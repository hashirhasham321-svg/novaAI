// netlify/functions/chat.js

const SYSTEM_PROMPT =
  "You are QuBix AI, a helpful and professional AI assistant. " +
  "Answer clearly in English, Urdu, or Roman Urdu. Be accurate and helpful. " +
  "Use the conversation history to understand follow-up questions and remember details " +
  "the user has shared in this chat. Do not claim to remember information not present in the history.";

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
    return send(405, { error: "Method not allowed." });
  }

  try {

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error("Supabase environment variables missing.");

      return send(503, {
        error: "Authentication service is not configured."
      });
    }

    // Verify logged-in user.
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

    let authResponse;

    try {

      authResponse = await fetch(
        `${supabaseUrl}/auth/v1/user`,
        {
          method: "GET",
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

    } catch (error) {

      console.error("Supabase authentication service unavailable.");

      return send(503, {
        error: "Authentication service is temporarily unavailable."
      });
    }

    if (!authResponse.ok) {
      return send(401, {
        error: "Your session is invalid or expired. Please log in again."
      });
    }

    // Read request.
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

    // Keep recent conversation history.
    const rawHistory = Array.isArray(body.history)
      ? body.history
      : [];

    const history = [];
    let totalChars = 0;

    for (const item of rawHistory.slice(-30)) {

      if (
        !item ||
        !["user", "assistant"].includes(item.role) ||
        typeof item.content !== "string" ||
        !item.content.trim()
      ) {
        continue;
      }

      const content = item.content.trim().slice(0, 6000);

      if (totalChars + content.length > 24000) {
        break;
      }

      history.push({
        role: item.role,
        content
      });

      totalChars += content.length;
    }

    // Make sure the latest message is included.
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

    // Gemini uses "model" for assistant messages.
    const geminiContents = history.map(item => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{ text: item.content }]
    }));

    // OpenAI-compatible providers.
    const compatibleMessages = [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      ...history
    ];

    // =================================
    // GEMINI
    // =================================

    if (process.env.GEMINI_API_KEY) {

      try {

        const response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": process.env.GEMINI_API_KEY
            },

            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: SYSTEM_PROMPT }]
              },

              contents: geminiContents,

              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 2048
              }
            })
          }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error?.message || "Gemini failed."
          );
        }

        const reply = data.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "")
          .join("")
          .trim();

        if (!reply) {
          throw new Error("Empty Gemini response.");
        }

        return send(200, {
          reply,
          provider: "Gemini"
        });

      } catch (error) {
        console.error("Gemini failed:", error.message);
      }
    }

    // =================================
    // GROQ
    // =================================

    if (process.env.GROQ_API_KEY) {

      try {

        const response = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`
            },

            body: JSON.stringify({
              model:
                process.env.GROQ_MODEL ||
                "llama-3.3-70b-versatile",

              messages: compatibleMessages,

              temperature: 0.7,
              max_tokens: 2048
            })
          }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error?.message || "Groq failed."
          );
        }

        const reply =
          data.choices?.[0]?.message?.content?.trim();

        if (!reply) {
          throw new Error("Empty Groq response.");
        }

        return send(200, {
          reply,
          provider: "Groq"
        });

      } catch (error) {
        console.error("Groq failed:", error.message);
      }
    }

    // =================================
    // OPENROUTER
    // =================================

    if (process.env.OPENROUTER_API_KEY) {

      try {

        const response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
              "HTTP-Referer": "https://qubixai.netlify.app/",
              "X-Title": "QuBix AI"
            },

            body: JSON.stringify({
              model:
                process.env.OPENROUTER_MODEL ||
                "openrouter/free",

              messages: compatibleMessages,

              temperature: 0.7,
              max_tokens: 2048
            })
          }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error?.message || "OpenRouter failed."
          );
        }

        const reply =
          data.choices?.[0]?.message?.content?.trim();

        if (!reply) {
          throw new Error("Empty OpenRouter response.");
        }

        return send(200, {
          reply,
          provider: "OpenRouter"
        });

      } catch (error) {
        console.error("OpenRouter failed:", error.message);
      }
    }

    // =================================
    // KIMI
    // =================================

    if (process.env.KIMI_API_KEY) {

      try {

        const response = await fetch(
          "https://api.moonshot.ai/v1/chat/completions",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.KIMI_API_KEY}`
            },

            body: JSON.stringify({
              model:
                process.env.KIMI_MODEL ||
                "kimi-k2.5",

              messages: compatibleMessages,

              temperature: 0.7,
              max_tokens: 2048
            })
          }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error?.message || "Kimi failed."
          );
        }

        const reply =
          data.choices?.[0]?.message?.content?.trim();

        if (!reply) {
          throw new Error("Empty Kimi response.");
        }

        return send(200, {
          reply,
          provider: "Kimi"
        });

      } catch (error) {
        console.error("Kimi failed:", error.message);
      }
    }

    // No provider worked.
    return send(503, {
      error: "QuBix AI is temporarily unable to respond. Please try again."
    });

  } catch (error) {

    console.error("Chat function error:", error.message);

    return send(500, {
      error: "An unexpected server error occurred."
    });
  }
};
