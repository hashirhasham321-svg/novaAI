
const SYSTEM_PROMPT = `
You are QuBix AI, a helpful and intelligent AI assistant.
Answer clearly and naturally in English, Urdu, or Roman Urdu,
depending on the user's language.
Be accurate, friendly, and useful.
`;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const GROQ_MODEL =
  process.env.GROQ_MODEL || "llama-3.1-8b-instant";

const MAX_HISTORY = 30;
const MAX_MESSAGE_LENGTH = 12000;
const TIMEOUT_MS = 20000;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

async function fetchWithTimeout(url, options, timeout = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-MAX_HISTORY)
    .filter(
      (item) =>
        item &&
        ["user", "assistant"].includes(item.role) &&
        typeof item.content === "string"
    )
    .map((item) => ({
      role: item.role,
      content: item.content.slice(0, MAX_MESSAGE_LENGTH),
    }));
}

async function verifyUser(token) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Supabase environment variables are missing.");
  }

  const response = await fetchWithTimeout(
    `${url.replace(/\/$/, "")}/auth/v1/user`,
    {
      method: "GET",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
      },
    },
    10000
  );

  if (!response.ok) {
    throw new Error("Supabase authentication failed.");
  }

  return response.json();
}

async function askGemini(messages) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) throw new Error("GEMINI_API_KEY is missing.");

  const contents = messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
        },
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || `Gemini HTTP ${response.status}`
    );
  }

  const answer = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!answer) throw new Error("Gemini returned an empty response.");

  return answer;
}

async function askGroq(messages) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) throw new Error("GROQ_API_KEY is missing.");

  const groqMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages,
  ];

  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: groqMessages,
        temperature: 0.7,
        max_completion_tokens: 2048,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || `Groq HTTP ${response.status}`
    );
  }

  const answer = data.choices?.[0]?.message?.content?.trim();

  if (!answer) throw new Error("Groq returned an empty response.");

  return answer;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const message =
      typeof body.message === "string" ? body.message.trim() : "";

    if (!message) {
      return json(400, { error: "Message is required." });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return json(400, { error: "Message is too long." });
    }

    const authHeader =
      event.headers.authorization ||
      event.headers.Authorization ||
      "";

    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!token) {
      return json(401, { error: "Please sign in again." });
    }

    await verifyUser(token);

    const history = cleanHistory(body.history);

    const messages = [
      ...history,
      { role: "user", content: message },
    ];

    const errors = [];

    // First provider: Gemini
    if (process.env.GEMINI_API_KEY) {
      try {
        console.log("Trying AI provider: Gemini");

        const reply = await askGemini(messages);

        console.log("Gemini response successful.");

        return json(200, {
          reply,
          provider: "Gemini",
        });
      } catch (error) {
        console.error("Gemini failed:", error.message);
        errors.push({
          provider: "Gemini",
          error: error.message,
        });
      }
    } else {
      errors.push({
        provider: "Gemini",
        error: "GEMINI_API_KEY is missing.",
      });
    }

    // Second provider: Groq
    if (process.env.GROQ_API_KEY) {
      try {
        console.log("Trying AI provider: Groq");

        const reply = await askGroq(messages);

        console.log("Groq response successful.");

        return json(200, {
          reply,
          provider: "Groq",
        });
      } catch (error) {
        console.error("Groq failed:", error.message);
        errors.push({
          provider: "Groq",
          error: error.message,
        });
      }
    } else {
      errors.push({
        provider: "Groq",
        error: "GROQ_API_KEY is missing.",
      });
    }

    console.error("All AI providers failed:", errors);

    return json(503, {
      error: "All AI providers are currently unavailable.",
      details: errors,
    });
  } catch (error) {
    console.error("Chat function error:", error.message);

    const message = error.message.includes("Supabase")
      ? error.message
      : "Internal server error.";

    return json(
      message.includes("authentication") ? 401 : 500,
      { error: message }
    );
  }
};
