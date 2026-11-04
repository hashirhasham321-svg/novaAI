// QuBix AI - Netlify Backend Function
// Provider fallback: Gemini -> Groq -> OpenRouter -> Kimi

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

async function askGemini(message) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Gemini key missing");

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: message }]
        }]
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "Gemini request failed");
  }

  const reply = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("");

  if (!reply) throw new Error("Gemini returned an empty response");

  return reply;
}

async function askOpenAICompatible({
  apiKey,
  url,
  model,
  message,
  extraHeaders = {}
}) {
  if (!apiKey) throw new Error("API key missing");

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
      data.error?.message || `Provider request failed: ${response.status}`
    );
  }

  const reply = data.choices?.[0]?.message?.content;

  if (!reply) throw new Error("Provider returned an empty response");

  return reply;
}

async function askGroq(message) {
  return askOpenAICompatible({
    apiKey: process.env.GROQ_API_KEY,
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    message
  });
}

async function askOpenRouter(message) {
  return askOpenAICompatible({
    apiKey: process.env.OPENROUTER_API_KEY,
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: process.env.OPENROUTER_MODEL || "openrouter/free",
    message,
    extraHeaders: {
      "HTTP-Referer": "https://qubixai.netlify.app/",
      "X-Title": "QuBix AI"
    }
  });
}

async function askKimi(message) {
  return askOpenAICompatible({
    apiKey: process.env.KIMI_API_KEY,
    url: "https://api.moonshot.ai/v1/chat/completions",
    model: process.env.KIMI_MODEL || "kimi-k2.5",
    message
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      error: "Method not allowed"
    });
  }

  try {
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
        console.error(`${provider} failed:`, error.message);
        errors.push(`${provider}: ${error.message}`);
      }
    }

    console.error("All AI providers failed:", errors);

    return jsonResponse(503, {
      error: "All AI providers are temporarily unavailable. Please try again."
    });

  } catch (error) {
    console.error("QuBix backend error:", error);

    return jsonResponse(500, {
      error: "Server error. Please try again later."
    });
  }
};
