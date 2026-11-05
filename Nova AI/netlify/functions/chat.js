// netlify/functions/chat.js

const SYSTEM_PROMPT =
  "You are QuBix AI, a helpful and professional AI assistant. " +
  "Answer clearly in English, Urdu, or Roman Urdu. " +
  "Be accurate, friendly, concise, and helpful. " +
  "Use conversation history to understand follow-up questions. " +
  "Remember details shared in this chat using the provided history. " +
  "Never claim to remember information that is not present in the history.";

const PROVIDER_TIMEOUT = 10000;
const MAX_HISTORY = 12;
const MAX_OUTPUT_TOKENS = 1024;

exports.handler = async (event) => {

  const send = (statusCode, data) => ({
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(data)
  });

  if (event.httpMethod !== "POST") {
    return send(405, {
      error: "Method not allowed."
    });
  }

  try {

    // =================================
    // SUPABASE AUTHENTICATION
    // =================================

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error("Supabase environment variables missing.");

      return send(503, {
        error: "Authentication service is not configured."
      });
    }

    const authHeader =
      event.headers?.authorization ||
      event.headers?.Authorization ||
      "";

    const accessToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!accessToken) {
      return send(401, {
        error: "Please log in to use QuBix AI."
      });
    }

    const authController = new AbortController();

    const authTimer = setTimeout(
      () => authController.abort(),
      8000
    );

    let authResponse;

    try {

      authResponse = await fetch(
        `${supabaseUrl}/auth/v1/user`,
        {
          method: "GET",
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${accessToken}`
          },
          signal: authController.signal
        }
      );

    } catch (error) {

      console.error("Supabase authentication error:", error.message);

      return send(503, {
        error: "Authentication service is unavailable. Please try again."
      });

    } finally {
      clearTimeout(authTimer);
    }

    if (!authResponse.ok) {
      return send(401, {
        error: "Your session is invalid or expired. Please log in again."
      });
    }

    // =================================
    // READ REQUEST
    // =================================

    let body;

    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return send(400, {
        error: "Invalid request body."
      });
    }

    const message = body.message;

    if (typeof message !== "string" || !message.trim()) {
      return send(400, {
        error: "Message is required."
      });
    }

    if (message.length > 12000) {
      return send(400, {
        error: "Message is too long."
      });
    }

    const userMessage = message.trim();

    // =================================
    // CONVERSATION MEMORY
    // =================================

    const rawHistory = Array.isArray(body.history)
      ? body.history
      : [];

    const history = [];
    let totalChars = 0;

    for (const item of rawHistory.slice(-MAX_HISTORY)) {

      if (
        !item ||
        !["user", "assistant"].includes(item.role) ||
        typeof item.content !== "string" ||
        !item.content.trim()
      ) {
        continue;
      }

      const content = item.content.trim().slice(0, 4000);

      if (totalChars + content.length > 16000) {
        break;
      }

      history.push({
        role: item.role,
        content
      });

      totalChars += content.length;
    }

    // Ensure latest user message is included.
    const last = history[history.length - 1];

    if (
      !last ||
      last.role !== "user" ||
      last.content !== userMessage
    ) {
      history.push({
        role: "user",
        content: userMessage
      });
    }

    const compatibleMessages = [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      ...history
    ];

    const geminiContents = history.map(item => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [
        {
          text: item.content
        }
      ]
    }));

    // =================================
    // PROVIDER REQUEST HELPER
    // =================================

    async function requestProvider(name, url, headers, payload) {

      const controller = new AbortController();

      const timer = setTimeout(
        () => controller.abort(),
        PROVIDER_TIMEOUT
      );

      try {

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        let data;

        try {
          data = await response.json();
        } catch {
          throw new Error(`${name}: Invalid response from provider.`);
        }

        if (!response.ok) {

          const apiError =
            data.error?.message ||
            data.error?.metadata?.raw ||
            data.message ||
            `HTTP ${response.status}`;

          throw new Error(`${name}: ${apiError}`);
        }

        const reply =
          data.choices?.[0]?.message?.content?.trim() ||
          data.candidates?.[0]?.content?.parts
            ?.map(part => part.text || "")
            .join("")
            .trim();

        if (!reply) {
          throw new Error(`${name}: Empty response.`);
        }

        console.log(`${name} responded successfully.`);

        return reply;

      } catch (error) {

        if (error.name === "AbortError") {
          throw new Error(`${name}: Request timed out.`);
        }

        throw error;

      } finally {
        clearTimeout(timer);
      }
    }

    // =================================
    // PROVIDER 1: GROQ
    // FAST PRIMARY PROVIDER
    // =================================

    if (process.env.GROQ_API_KEY) {

      try {

        const reply = await requestProvider(
          "Groq",

          "https://api.groq.com/openai/v1/chat/completions",

          {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`
          },

          {
            model:
              process.env.GROQ_MODEL ||
              "llama-3.3-70b-versatile",

            messages: compatibleMessages,

            temperature: 0.7,
            max_tokens: MAX_OUTPUT_TOKENS
          }
        );

        return send(200, {
          reply,
          provider: "Groq"
        });

      } catch (error) {
        console.error(error.message);
      }
    }

    // =================================
    // PROVIDER 2: GEMINI
    // =================================

    if (process.env.GEMINI_API_KEY) {

      try {

        const reply = await requestProvider(
          "Gemini",

          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",

          {
            "Content-Type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY
          },

          {
            systemInstruction: {
              parts: [
                {
                  text: SYSTEM_PROMPT
                }
              ]
            },

            contents: geminiContents,

            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: MAX_OUTPUT_TOKENS
            }
          }
        );

        return send(200, {
          reply,
          provider: "Gemini"
        });

      } catch (error) {
        console.error(error.message);
      }
    }

    // =================================
    // PROVIDER 3: KIMI
    // =================================

    if (process.env.KIMI_API_KEY) {

      try {

        const reply = await requestProvider(
          "Kimi",

          "https://api.moonshot.ai/v1/chat/completions",

          {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.KIMI_API_KEY}`
          },

          {
            model:
              process.env.KIMI_MODEL ||
              "kimi-k2.5",

            messages: compatibleMessages,

            max_tokens: MAX_OUTPUT_TOKENS
          }
        );

        return send(200, {
          reply,
          provider: "Kimi"
        });

      } catch (error) {
        console.error(error.message);
      }
    }

    // =================================
    // PROVIDER 4: OPENROUTER
    // =================================

    if (process.env.OPENROUTER_API_KEY) {

      try {

        const reply = await requestProvider(
          "OpenRouter",

          "https://openrouter.ai/api/v1/chat/completions",

          {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "HTTP-Referer": "https://qubixai.netlify.app/",
            "X-Title": "QuBix AI"
          },

          {
            model:
              process.env.OPENROUTER_MODEL ||
              "openrouter/free",

            messages: compatibleMessages,

            temperature: 0.7,
            max_tokens: MAX_OUTPUT_TOKENS
          }
        );

        return send(200, {
          reply,
          provider: "OpenRouter"
        });

      } catch (error) {
        console.error(error.message);
      }
    }

    // =================================
    // ALL PROVIDERS FAILED
    // =================================

    console.error("All configured AI providers failed.");

    return send(503, {
      error: "All AI providers are currently unavailable. Please try again in a moment."
    });

  } catch (error) {

    console.error("QuBix server error:", error.message);

    return send(500, {
      error: "QuBix encountered a server error. Please try again."
    });
  }
};
