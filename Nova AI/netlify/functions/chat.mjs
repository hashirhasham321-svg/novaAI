const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const MODELS = {
  groq: "openai/gpt-oss-20b",
  groqLarge: "openai/gpt-oss-120b",
  gemini: "gemini-2.5-flash",
  imagePrimary: "gemini-3.1-flash-image",
  imageFallback: "gemini-2.5-flash-image"
};

/* Keys here must match the <option> values of #modelSelect in index.html */
const MODEL_CATALOG = {
  groq:         { provider: "groq",   model: MODELS.groq },
  "groq-large": { provider: "groq",   model: MODELS.groqLarge },
  gemini:       { provider: "gemini", model: MODELS.gemini }
};

const SYSTEM_PROMPT = `
You are QuBix AI, a powerful, friendly and intelligent assistant.
You can communicate in English, Urdu, Roman Urdu, Punjabi, Hindi and Arabic.
Respond in the language used by the user unless asked otherwise.
Be accurate, helpful, clear and honest.
For coding requests, provide complete working code where possible.
Never claim to have performed actions you did not perform.
`;

const json = (statusCode, body) => new Response(
  JSON.stringify(body),
  { status: statusCode, headers: HEADERS }
);

function getSupabaseHeaders(token) {
  return {
    apikey: process.env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

async function fetchT(url, options = {}, ms = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(ms / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callGroq(
  messages,
  apiKey,
  temperature = 0.7,
  model = MODELS.groq
) {
  const response = await fetchT(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: 4096,
        stream: false
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || `Groq request failed (${response.status})`
    );
  }

  return data.choices?.[0]?.message?.content || "";
}

function prepareGeminiContents(messages) {
  const contents = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    const role = message.role === "assistant" ? "model" : "user";
    const value = String(message.content || "");

    if (!value.trim()) continue;

    const previous = contents[contents.length - 1];

    if (previous && previous.role === role) {
      previous.parts[0].text += "\n\n" + value;
    } else {
      contents.push({
        role,
        parts: [{ text: value }]
      });
    }
  }

  while (contents.length && contents[0].role === "model") {
    contents.shift();
  }

  return contents;
}

async function callGemini(
  messages,
  apiKey,
  systemInstruction,
  temperature = 0.7,
  model = MODELS.gemini
) {
  const contents = prepareGeminiContents(messages);

  if (!contents.length) {
    throw new Error("No conversation content for Gemini.");
  }

  const response = await fetchT(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        contents,
        generationConfig: {
          temperature,
          maxOutputTokens: 4096
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || `Gemini request failed (${response.status})`
    );
  }

  return data.candidates?.[0]?.content?.parts
    ?.filter(part => part.text)
    .map(part => part.text)
    .join("") || "";
}

/* ---------------- WEB SEARCH ---------------- */

async function webSearch(query) {
  if (!process.env.TAVILY_API_KEY) {
    throw new Error("Web search is not configured. Add TAVILY_API_KEY.");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: 5,
      include_answer: true
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "Web search failed.");
  }

  return {
    answer: data.answer || "",
    results: (data.results || []).map(item => ({
      title: item.title,
      url: item.url,
      content: item.content
    }))
  };
}

/* ---------------- IMAGE GENERATION ---------------- */

async function generateImageWithModel(prompt, apiKey, model) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text:
              "Generate an image based on this description. " +
              "Return an actual generated image, not just a written description.\n\n" +
              prompt
          }]
        }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"]
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
      `Image model ${model} failed (${response.status}).`
    );
  }

  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(part => part.inlineData?.data);

  if (!imagePart) {
    const textMessage = parts
      .filter(part => part.text)
      .map(part => part.text)
      .join(" ");

    throw new Error(
      textMessage ||
      "Gemini did not return an image. Check API access, quota and model availability."
    );
  }

  return {
    mimeType: imagePart.inlineData.mimeType || "image/png",
    data: imagePart.inlineData.data,
    model
  };
}

async function generateImage(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is missing in Netlify environment variables."
    );
  }

  let firstError;

  try {
    return await generateImageWithModel(
      prompt,
      apiKey,
      MODELS.imagePrimary
    );
  } catch (error) {
    firstError = error;
    console.error("Primary image model failed:", error.message);
  }

  try {
    return await generateImageWithModel(
      prompt,
      apiKey,
      MODELS.imageFallback
    );
  } catch (fallbackError) {
    console.error("Fallback image model failed:", fallbackError.message);

    throw new Error(
      "Image generation failed. Primary: " +
      firstError.message +
      " | Fallback: " +
      fallbackError.message
    );
  }
}

/* ---------------- IMAGE UNDERSTANDING ---------------- */

async function analyzeImage(prompt, image, apiKey) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing in Netlify environment variables.");
  }

  if (!image || typeof image.data !== "string") {
    throw new Error("Please attach an image.");
  }

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp"
  ];

  if (!allowedTypes.includes(image.mimeType)) {
    throw new Error("Supported image formats are JPG, PNG and WEBP.");
  }

  if (image.data.length > 9000000) {
    throw new Error("Image is too large. Please use a smaller image.");
  }

  const response = await fetchT(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            {
              text: String(prompt || "Describe this image.").slice(0, 5000)
            },
            {
              inlineData: {
                mimeType: image.mimeType,
                data: image.data
              }
            }
          ]
        }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 4096
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
      `Image analysis failed (${response.status}).`
    );
  }

  const answer = data.candidates?.[0]?.content?.parts
    ?.filter(part => part.text)
    .map(part => part.text)
    .join("") || "";

  if (!answer.trim()) {
    throw new Error("Gemini could not analyze this image.");
  }

  return answer;
}


/* ---------------- SMART ROUTING ---------------- */

function providerAvailable(key) {
  const entry = MODEL_CATALOG[key];
  if (!entry) return false;
  return entry.provider === "groq"
    ? Boolean(process.env.GROQ_API_KEY)
    : Boolean(process.env.GEMINI_API_KEY);
}

function buildProviderChain(selected, mode, promptChars) {
  const chain = [];

  if (selected && selected !== "auto" && MODEL_CATALOG[selected]) {
    chain.push(selected);
  }

  let auto;
  if (promptChars > 20000 || mode === "research") {
    auto = ["gemini", "groq", "groq-large"];      // long context / research
  } else if (mode === "coding") {
    auto = ["groq-large", "gemini", "groq"];      // stronger model for code
  } else {
    auto = ["groq", "gemini", "groq-large"];      // fast default
  }

  for (const key of auto) {
    if (!chain.includes(key)) chain.push(key);
  }

  return chain.filter(providerAvailable);
}

/* ---------------- DOCUMENT OCR ---------------- */

async function ocrDocument(file, apiKey) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing in Netlify environment variables.");
  }

  const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

  if (!file || typeof file.data !== "string" || !allowed.includes(file.mimeType)) {
    throw new Error("OCR supports PDF, JPG, PNG and WEBP files.");
  }

  if (file.data.length > 9000000) {
    throw new Error("File is too large for OCR.");
  }

  const response = await fetchT(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            {
              text:
                "Extract all readable text from this document exactly as written. " +
                "Keep paragraphs, lists and tables (as plain text or Markdown). " +
                "Do not summarize, translate or add commentary. " +
                "If there is no readable text, reply with exactly: NO_TEXT_FOUND"
            },
            { inlineData: { mimeType: file.mimeType, data: file.data } }
          ]
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 8192 }
      })
    },
    25000
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || `OCR failed (${response.status}).`);
  }

  const text = data.candidates?.[0]?.content?.parts
    ?.filter(part => part.text)
    .map(part => part.text)
    .join("")
    .trim() || "";

  if (!text || text === "NO_TEXT_FOUND") {
    throw new Error("No readable text was found in this document.");
  }

  return text;
}

/* ---------------- USAGE TRACKING ---------------- */

async function logUsage(userId, token, row) {
  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/qubix_usage`,
      {
        method: "POST",
        headers: {
          ...getSupabaseHeaders(token),
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ user_id: userId, ...row })
      }
    );

    if (!response.ok) {
      console.error("Usage log failed:", await response.text());
    }
  } catch (error) {
    console.error("Usage log error:", error.message);
  }
}

async function usageSummary(userId, token, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/qubix_usage`);
  url.searchParams.set(
    "select",
    "action,provider,model,status,error,latency_ms,web_search,fallback,created_at"
  );
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("created_at", `gte.${since}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "5000");

  const response = await fetch(url, { headers: getSupabaseHeaders(token) });

  if (!response.ok) {
    throw new Error(
      "Could not load usage. Run the qubix-phase1.sql migration in Supabase."
    );
  }

  const rows = await response.json();

  const count = (key) => rows.reduce((acc, row) => {
    if (!row[key]) return acc;
    acc[row[key]] = (acc[row[key]] || 0) + 1;
    return acc;
  }, {});

  const today = new Date().toISOString().slice(0, 10);
  const daily = [];

  for (let i = 6; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    daily.push({
      date,
      count: rows.filter(row => row.created_at.slice(0, 10) === date).length
    });
  }

  const okRows = rows.filter(row => row.status === "ok");
  const timed = okRows.filter(row => Number.isFinite(row.latency_ms));

  return {
    days,
    total: rows.length,
    ok: okRows.length,
    errors: rows.length - okRows.length,
    today: rows.filter(row => row.created_at.slice(0, 10) === today).length,
    avgLatencyMs: timed.length
      ? Math.round(timed.reduce((sum, row) => sum + row.latency_ms, 0) / timed.length)
      : 0,
    webSearches: rows.filter(row => row.web_search).length,
    fallbacks: rows.filter(row => row.fallback).length,
    byProvider: count("provider"),
    byModel: count("model"),
    byAction: count("action"),
    daily,
    recentErrors: rows
      .filter(row => row.status === "error")
      .slice(0, 5)
      .map(row => ({
        at: row.created_at,
        action: row.action,
        error: row.error || "Unknown error"
      }))
  };
}

/* ---------------- AUTHENTICATION ---------------- */

async function authenticate(token) {
  if (
    !token ||
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_ANON_KEY
  ) {
    throw new Error("Authentication required.");
  }

  const response = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) {
    throw new Error("Invalid or expired login session.");
  }

  return response.json();
}

/* ---------------- PROFILE ---------------- */

async function loadProfile(userId, token) {
  const url = new URL(
    `${process.env.SUPABASE_URL}/rest/v1/qubix_profiles`
  );

  url.searchParams.set(
    "select",
    "custom_instructions,preferred_language,response_style"
  );
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: getSupabaseHeaders(token)
  });

  if (!response.ok) {
    throw new Error("Could not load user profile.");
  }

  const rows = await response.json();
  return rows?.[0] || {};
}

/* ---------------- MEMORIES ---------------- */

async function saveMemory(userId, memory, category, token) {
  const url = new URL(
    `${process.env.SUPABASE_URL}/rest/v1/qubix_memories`
  );

  url.searchParams.set("on_conflict", "user_id,memory");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...getSupabaseHeaders(token),
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      user_id: userId,
      memory,
      category: category || "general"
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error("Could not save memory: " + error);
  }

  return true;
}

async function listMemories(userId, token) {
  const url = new URL(
    `${process.env.SUPABASE_URL}/rest/v1/qubix_memories`
  );

  url.searchParams.set("select", "id,memory,category,created_at");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "100");

  const response = await fetch(url, {
    headers: getSupabaseHeaders(token)
  });

  if (!response.ok) {
    throw new Error("Could not load memories.");
  }

  return response.json();
}

async function deleteMemory(id, userId, token) {
  if (!id) throw new Error("Memory ID is required.");

  const url = new URL(
    `${process.env.SUPABASE_URL}/rest/v1/qubix_memories`
  );

  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("user_id", `eq.${userId}`);

  const response = await fetch(url, {
    method: "DELETE",
    headers: getSupabaseHeaders(token)
  });

  if (!response.ok) {
    throw new Error("Could not delete memory.");
  }

  return true;
}

async function clearMemories(userId, token) {
  const url = new URL(
    `${process.env.SUPABASE_URL}/rest/v1/qubix_memories`
  );

  url.searchParams.set("user_id", `eq.${userId}`);

  const response = await fetch(url, {
    method: "DELETE",
    headers: getSupabaseHeaders(token)
  });

  if (!response.ok) {
    throw new Error("Could not clear memories.");
  }

  return true;
}

/* ---------------- MODES AND PERSONALIZATION ---------------- */

function getModePrompt(mode) {
  const prompts = {
    normal: "Answer naturally and helpfully.",
    study:
      "Act as a patient tutor. Explain concepts step by step and use examples.",
    coding:
      "Act as an expert programmer. Give practical, correct code and explain important steps.",
    creative:
      "Be creative and original while following the user's request.",
    research:
      "Analyze carefully. Distinguish facts from uncertainty and use available evidence."
  };

  return prompts[mode] || prompts.normal;
}

function getProfilePrompt(profile) {
  const parts = [];

  const language = profile.preferred_language || "auto";

  if (language !== "auto") {
    parts.push(`Preferred response language: ${language}.`);
  }

  const styles = {
    balanced: "Use a balanced level of detail.",
    concise: "Keep answers short and concise unless detail is requested.",
    detailed: "Give detailed explanations with useful examples.",
    friendly: "Use a warm and friendly conversational style.",
    professional: "Use a professional and clear tone."
  };

  if (profile.response_style && styles[profile.response_style]) {
    parts.push(styles[profile.response_style]);
  }

  if (profile.custom_instructions?.trim()) {
    parts.push(
      "Additional user instructions:\n" +
      profile.custom_instructions.trim().slice(0, 3000)
    );
  }

  return parts.join("\n");
}

/* ---------------- MAIN HANDLER ---------------- */

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: HEADERS
    });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  let token = "";
  let user = null;
  let currentAction = "chat";
  const startedAt = Date.now();
  const LOGGED_ACTIONS = ["chat", "analyze_image", "generate_image", "ocr_document"];

  try {
    token = (request.headers.get("authorization") || "")
      .replace(/^Bearer\s+/i, "");

    user = await authenticate(token);
    const body = await request.json();

    const {
      message,
      messages = [],
      action = "chat",
      webSearchEnabled = false,
      mode = "normal",
      temperature = 0.7,
      model: selectedModel = "auto"
    } = body;

    currentAction = action;

    /* Usage summary */

    if (action === "usage_summary") {
      return json(200, {
        usage: await usageSummary(user.id, token)
      });
    }

    /* Memory actions */

    if (action === "memory_list") {
      return json(200, {
        memories: await listMemories(user.id, token)
      });
    }

    if (action === "memory_save") {
      if (
        typeof body.memory !== "string" ||
        !body.memory.trim()
      ) {
        return json(400, { error: "Memory is required." });
      }

      if (body.memory.length > 2000) {
        return json(413, { error: "Memory is too long." });
      }

      await saveMemory(
        user.id,
        body.memory.trim(),
        body.category,
        token
      );

      return json(200, { success: true });
    }

    if (action === "memory_delete") {
      await deleteMemory(body.id, user.id, token);
      return json(200, { success: true });
    }

    if (action === "memory_clear") {
      await clearMemories(user.id, token);
      return json(200, { success: true });
    }

    /* Image understanding */

    if (action === "analyze_image") {
      const answer = await analyzeImage(
        message || "Describe this image.",
        body.image,
        process.env.GEMINI_API_KEY
      );

      await logUsage(user.id, token, {
        action: "analyze_image",
        provider: "gemini",
        model: MODELS.gemini,
        status: "ok",
        latency_ms: Date.now() - startedAt,
        input_chars: String(message || "").length,
        output_chars: answer.length
      });

      return json(200, {
        success: true,
        answer,
        provider: "gemini",
        action: "analyze_image"
      });
    }

    /* Document OCR (scanned PDFs and images) */

    if (action === "ocr_document") {
      const text = await ocrDocument(body.file, process.env.GEMINI_API_KEY);

      await logUsage(user.id, token, {
        action: "ocr_document",
        provider: "gemini",
        model: MODELS.gemini,
        status: "ok",
        latency_ms: Date.now() - startedAt,
        output_chars: text.length
      });

      return json(200, { success: true, text });
    }

    /* Image generation */

    if (action === "generate_image") {
      if (
        typeof body.prompt !== "string" ||
        !body.prompt.trim()
      ) {
        return json(400, { error: "Image prompt is required." });
      }

      if (body.prompt.length > 4000) {
        return json(413, { error: "Image prompt is too long." });
      }

      const image = await generateImage(body.prompt.trim());

      await logUsage(user.id, token, {
        action: "generate_image",
        provider: "gemini",
        model: image.model,
        status: "ok",
        latency_ms: Date.now() - startedAt,
        input_chars: body.prompt.length
      });

      return json(200, {
        success: true,
        image
      });
    }

    /* Chat validation */

    if (typeof message !== "string" || !message.trim()) {
      return json(400, { error: "Message is required." });
    }

    if (message.length > 30000) {
      return json(413, { error: "Message is too long." });
    }

    /* Load profile */

    let profile = {};

    try {
      profile = await loadProfile(user.id, token);
    } catch (error) {
      console.error("Profile loading error:", error.message);
    }

    /* Optional web search */

    let searchContext = "";
    let webSearchUsed = false;

    if (webSearchEnabled) {
      try {
        const results = await webSearch(message);

        searchContext = `
Web search results:
${JSON.stringify(results)}

Use these search results carefully.
Do not invent sources or claim that you opened pages you did not open.
If the results do not answer the question, say so.
`;

        webSearchUsed = true;
      } catch (error) {
        console.error("Web search error:", error.message);

        searchContext = `
Web search was requested but is unavailable for this request.
Do not pretend that a web search succeeded.
`;
      }
    }

    /* Load memories */

    let memoryContext = "";
    let memoryUsed = false;

    try {
      const memories = await listMemories(user.id, token);

      if (memories.length) {
        memoryContext =
          "\nRelevant saved user memories:\n" +
          memories
            .slice(0, 30)
            .map(item => "- " + item.memory)
            .join("\n");

        memoryUsed = true;
      }
    } catch (error) {
      console.error("Memory loading error:", error.message);
    }

    const profileContext = getProfilePrompt(profile);
    const modeContext = getModePrompt(mode);

    const systemInstruction = [
      SYSTEM_PROMPT,
      modeContext,
      profileContext,
      memoryContext,
      searchContext
    ].filter(Boolean).join("\n\n");

    const conversation = Array.isArray(messages)
      ? messages.slice(-20).map(item => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: String(item.content || "").slice(0, 12000)
        }))
      : [];

    const fullMessages = [
      {
        role: "system",
        content: systemInstruction
      },
      ...conversation,
      {
        role: "user",
        content: message
      }
    ];

    const safeTemperature = Math.min(
      1.5,
      Math.max(0, Number(temperature) || 0.7)
    );

    const promptChars = fullMessages.reduce(
      (total, item) => total + String(item.content || "").length,
      0
    );

    const chain = buildProviderChain(selectedModel, mode, promptChars);

    if (!chain.length) {
      throw new Error(
        "No AI provider is configured. Add GROQ_API_KEY or GEMINI_API_KEY."
      );
    }

    let answer = "";
    let provider = "";
    let usedModel = "";
    let usedKey = "";
    const attempts = [];

    /* Try each model in order; move on if one fails or times out */

    for (const key of chain) {
      const entry = MODEL_CATALOG[key];

      try {
        const result = entry.provider === "groq"
          ? await callGroq(
              fullMessages,
              process.env.GROQ_API_KEY,
              safeTemperature,
              entry.model
            )
          : await callGemini(
              fullMessages,
              process.env.GEMINI_API_KEY,
              systemInstruction,
              safeTemperature,
              entry.model
            );

        if (!result.trim()) throw new Error("Empty response.");

        answer = result;
        provider = entry.provider;
        usedModel = entry.model;
        usedKey = key;
        break;
      } catch (error) {
        attempts.push(`${key}: ${error.message}`);
        console.error(`Model ${key} failed:`, error.message);
      }
    }

    if (!usedKey) {
      throw new Error("All AI providers failed. " + attempts.join(" | "));
    }

    const fallbackUsed = usedKey !== chain[0];

    await logUsage(user.id, token, {
      action: "chat",
      provider,
      model: usedModel,
      status: "ok",
      latency_ms: Date.now() - startedAt,
      input_chars: message.length,
      output_chars: answer.length,
      web_search: webSearchUsed,
      fallback: fallbackUsed
    });

    return json(200, {
      success: true,
      answer,
      provider,
      model: usedModel,
      fallbackUsed,
      memoryUsed,
      webSearchUsed,
      profileUsed: Boolean(profileContext)
    });

  } catch (error) {
    console.error("QuBix error:", error);

    const message = error.message || "Something went wrong.";

    if (user && token && LOGGED_ACTIONS.includes(currentAction)) {
      await logUsage(user.id, token, {
        action: currentAction,
        status: "error",
        error: String(message).slice(0, 300),
        latency_ms: Date.now() - startedAt
      });
    }

    const statusCode =
      message.includes("Authentication") ||
      message.includes("session")
        ? 401
        : 500;

    return json(statusCode, {
      error: message
    });
  }
}
