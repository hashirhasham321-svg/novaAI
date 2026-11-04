
// ==========================================
// QuBix AI - Complete Netlify Backend
// AI Fallback: Gemini -> Groq -> OpenRouter -> Kimi
// ==========================================

const SYSTEM_PROMPT = `
You are QuBix AI, the official AI assistant of QuBix AI.

IDENTITY RULES:
- Your name is always QuBix AI.
- If someone asks your name, answer: "I am QuBix AI."
- Never introduce yourself as Dots, Gemini, Groq, Kimi, OpenRouter,
  or any other AI provider or model.
- Do not start conversations by saying you are developed by another company.
- Do not invent a different identity.
- If asked which AI provider or model powers you, answer honestly
  that QuBix AI uses AI technology from its configured providers.

BEHAVIOR:
- Be helpful, friendly, intelligent and accurate.
- Respond in the same language as the user.
- Follow the user's requested tone and format.
- If you do not know something, say so honestly.
- Never invent facts.
`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const jsonResponse = (statusCode, data) => ({
  statusCode,
  headers: {
    ...corsHeaders,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(data)
});

// ==========================================
// SUPABASE AUTHENTICATION
// ==========================================

async function verifyUser(token) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error("Supabase environment variables are missing.");
  }

  const response = await fetch(
    `${supabaseUrl}/auth/v1/user`,
    {
      method: "GET",
      headers: {
        "apikey": anonKey,
        "Authorization": `Bearer ${token}`
      }
    }
  );

  if (!response.ok) return false;

  const user = await response.json();

  return Boolean(user && user.id);
}

// ==========================================
// GEMINI
// ==========================================

async function askGemini(message) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("Gemini API key missing.");
  }

  const model =
    process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: message }]
          }
        ],
        generationConfig: {
          temperature: 0.7
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || "Gemini request failed."
    );
  }

  const reply = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("");

  if (!reply) {
    throw new Error("Gemini returned an empty response.");
  }

  return reply;
}

// ==========================================
// OPENAI-COMPATIBLE PROVIDERS
// ==========================================

async function askOpenAICompatible({
  apiKey,
  url,
  model,
  message,
  extraHeaders = {}
}) {
  if (!apiKey) {
    throw new Error("API key missing.");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      ...extraHeaders
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT
        },
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0.7
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
      `Provider request failed: ${response.status}`
    );
  }

  const reply = data.choices?.[0]?.message?.content;

  if (typeof reply !== "string" || !reply.trim()) {
    throw new Error("Provider returned an empty response.");
  }

  return reply;
}

// ==========================================
// GROQ
// ==========================================

async function askGroq(message) {
  return askOpenAICompatible({
    apiKey: process.env.GROQ_API_KEY,
    url: "https://api.groq.com/openai/v1/chat/completions",
    model:
      process.env.GROQ_MODEL ||
      "llama-3.3-70b-versatile",
    message
  });
}

// ==========================================
// OPENROUTER
// ==========================================

async function askOpenRouter(message) {
  return askOpenAICompatible({
    apiKey: process.env.OPENROUTER_API_KEY,
    url: "https://openrouter.ai/api/v1/chat/completions",
    model:
      process.env.OPENROUTER_MODEL ||
      "openrouter/free",
    message,
    extraHeaders: {
      "HTTP-Referer": "https://qubixai.netlify.app/",
      "X-Title": "QuBix AI"
    }
  });
}

// ==========================================
// KIMI
// ==========================================

async function askKimi(message) {
  return askOpenAICompatible({
    apiKey: process.env.KIMI_API_KEY,
    url: "https://api.moonshot.ai/v1/chat/completions",
    model:
      process.env.KIMI_MODEL ||
      "kimi-k2.5",
    message
  });
}

// ==========================================
// MAIN NETLIFY FUNCTION
// ==========================================

exports.handler = async (event) => {

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ""
    };
  }

  // Only POST requests
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      error: "Method not allowed."
    });
  }

  try {

    // Authentication
    const authHeader =
      event.headers.authorization ||
      event.headers.Authorization ||
      "";

    if (!authHeader.startsWith("Bearer ")) {
      return jsonResponse(401, {
        error: "Please log in to use QuBix AI."
      });
    }

    const token = authHeader.slice(7).trim();

    if (!token) {
      return jsonResponse(401, {
        error: "Invalid login session."
      });
    }

    const authenticated = await verifyUser(token);

    if (!authenticated) {
      return jsonResponse(401, {
        error: "Your session is invalid or expired. Please log in again."
      });
    }

    // Validate message
    const body = JSON.parse(event.body || "{}");
    const message = body.message;

    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 12000
    ) {
      return jsonResponse(400, {
        error: "Please enter a message (maximum 12000 characters)."
      });
    }

    // AI provider fallback sequence
    const providers = [
      ["Gemini", () => askGemini(message)],
      ["Groq", () => askGroq(message)],
      ["OpenRouter", () => askOpenRouter(message)],
      ["Kimi", () => askKimi(message)]
    ];

    const errors = [];

    for (const [provider, request] of providers) {
      try {

        const reply = await request();

        return jsonResponse(200, {
          reply,
          provider
        });

      } catch (error) {

        console.error(
          `${provider} failed:`,
          error.message
        );

        errors.push(`${provider}: ${error.message}`);
      }
    }

    // All providers failed
    console.error(
      "All AI providers failed:",
      errors
    );

    return jsonResponse(503, {
      error: "All AI providers are temporarily unavailable. Please try again."
    });

  } catch (error) {

    console.error(
      "QuBix backend error:",
      error
    );

    return jsonResponse(500, {
      error: "Server error. Please try again later."
    });
  }
};
