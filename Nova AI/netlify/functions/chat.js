const SYSTEM_PROMPT = `
You are QuBix AI, a highly capable, intelligent and professional AI assistant.

Your capabilities:
- Answer questions accurately and clearly.
- Help with advanced coding, debugging and programming.
- Explain complex topics step by step.
- Solve mathematical and logical problems.
- Help with writing, research, brainstorming and analysis.
- Understand conversation history and maintain context.
- Respond naturally in English, Urdu or Roman Urdu.
- Never invent facts. Admit uncertainty when necessary.

Be helpful, thoughtful, accurate and concise.
`;

const TIMEOUT = 8000;
const MAX_HISTORY = 10;
const MAX_OUTPUT_TOKENS = 1200;

const send = (statusCode, data) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  },
  body: JSON.stringify(data)
});

async function fetchWithTimeout(url, options, timeout = TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(response) {
  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Invalid response from AI server.");
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      `HTTP ${response.status}`;

    throw new Error(message);
  }

  return data;
}

function getHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(item =>
      item &&
      ["user", "assistant"].includes(item.role) &&
      typeof item.content === "string"
    )
    .slice(-MAX_HISTORY)
    .map(item => ({
      role: item.role,
      content: item.content.slice(0, 3000)
    }));
}

// GROQ
async function askGroq(message, history) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is missing.");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: message }
  ];

  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        messages,
        temperature: 0.7,
        max_tokens: MAX_OUTPUT_TOKENS
      })
    }
  );

  const data = await readResponse(response);
  const reply = data.choices?.[0]?.message?.content;

  if (!reply) throw new Error("Groq returned an empty response.");
  return reply;
}

// GEMINI
async function askGemini(message, history) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing.");

  const contents = [
    ...history.map(item => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{ text: item.content }]
    })),
    {
      role: "user",
      parts: [{ text: message }]
    }
  ];

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || "gemini-2.5-flash"}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: MAX_OUTPUT_TOKENS
        }
      })
    }
  );

  const data = await readResponse(response);
  const reply = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!reply) {
    throw new Error(
      data.promptFeedback?.blockReason || "Gemini returned an empty response."
    );
  }

  return reply;
}

// KIMI / MOONSHOT
async function askKimi(message, history) {
  const key = process.env.KIMI_API_KEY;
  if (!key) throw new Error("KIMI_API_KEY is missing.");

  const response = await fetchWithTimeout(
    "https://api.moonshot.ai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: process.env.KIMI_MODEL || "kimi-k2.5",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history,
          { role: "user", content: message }
        ],
        temperature: 0.7,
        max_tokens: MAX_OUTPUT_TOKENS
      })
    }
  );

  const data = await readResponse(response);
  const reply = data.choices?.[0]?.message?.content;

  if (!reply) throw new Error("Kimi returned an empty response.");
  return reply;
}

// OPENROUTER
async function askOpenRouter(message, history) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is missing.");

  const response = await fetchWithTimeout(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": process.env.SITE_URL || "https://qubix.netlify.app",
        "X-Title": "QuBix AI"
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || "openrouter/free",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history,
          { role: "user", content: message }
        ],
        temperature: 0.7,
        max_tokens: MAX_OUTPUT_TOKENS
      })
    }
  );

  const data = await readResponse(response);
  const reply = data.choices?.[0]?.message?.content;

  if (!reply) throw new Error("OpenRouter returned an empty response.");
  return reply;
}

// VERIFY USER
async function verifyUser(token) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Supabase environment variables are missing.");
  }

  const response = await fetchWithTimeout(
    `${url.replace(/\/$/, "")}/auth/v1/user`,
    {
      method: "GET",
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`
      }
    },
    8000
  );

  if (!response.ok) {
    throw new Error("Authentication failed. Please sign in again.");
  }

  const user = await response.json();
  if (!user?.id) {
    throw new Error("Invalid user session.");
  }

  return user;
}

// MAIN HANDLER
exports.handler = async event => {
  if (event.httpMethod === "OPTIONS") {
    return send(200, { success: true });
  }

  if (event.httpMethod !== "POST") {
    return send(405, {
      success: false,
      error: "Method not allowed."
    });
  }

  try {
    const authHeader =
      event.headers?.authorization ||
      event.headers?.Authorization ||
      "";

    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!token) {
      return send(401, {
        success: false,
        error: "Please sign in to use QuBix AI."
      });
    }

    await verifyUser(token);

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return send(400, {
        success: false,
        error: "Invalid request body."
      });
    }

    const message =
      typeof body.message === "string"
        ? body.message.trim()
        : "";

    if (!message) {
      return send(400, {
        success: false,
        error: "Message is required."
      });
    }

    if (message.length > 12000) {
      return send(400, {
        success: false,
        error: "Message is too long. Please shorten it."
      });
    }

    const history = getHistory(body.history);

    const providers = [
      ["Groq", askGroq],
      ["Gemini", askGemini],
      ["Kimi", askKimi],
      ["OpenRouter", askOpenRouter]
    ];

    const errors = [];

    for (const [name, provider] of providers) {
      try {
        console.log(`Trying AI provider: ${name}`);

        const reply = await provider(message, history);

        console.log(`AI provider succeeded: ${name}`);

        return send(200, {
          success: true,
          reply,
          provider: name
        });

      } catch (error) {
        const reason = error.name === "AbortError"
          ? "Request timed out."
          : error.message || "Unknown provider error.";

        console.error(`${name} failed: ${reason}`);

        errors.push({
          provider: name,
          error: reason
        });
      }
    }

    console.error("All AI providers failed:", errors);

    return send(503, {
      success: false,
      error: "All AI providers are currently unavailable.",
      details: errors
    });

  } catch (error) {
    console.error("QuBix function error:", error);

    return send(500, {
      success: false,
      error: error.message || "Internal server error."
    });
  }
};
