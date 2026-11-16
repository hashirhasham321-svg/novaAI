
const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const MODELS = {
  groq: "openai/gpt-oss-20b",
  gemini: "gemini-2.5-flash",
  image: "gemini-2.5-flash-image"
};

const SYSTEM_PROMPT = `
You are QuBix AI, a powerful, friendly and intelligent assistant.
You can communicate in English, Urdu, Roman Urdu, Punjabi, Hindi and Arabic.
Respond in the language used by the user unless asked otherwise.
Be accurate, helpful, clear and honest.
For coding requests, provide complete working code where possible.
Never claim to have performed actions you did not perform.
`;

const json = (statusCode, body) => ({
  statusCode,
  headers: HEADERS,
  body: JSON.stringify(body)
});

function getSupabaseHeaders(token) {
  return {
    apikey: process.env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

async function callGroq(messages, apiKey, temperature = 0.7) {
  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODELS.groq,
        messages,
        temperature,
        max_tokens: 4096,
        stream: false
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "Groq request failed");
  }

  return data.choices?.[0]?.message?.content || "";
}

function prepareGeminiContents(messages) {
  const contents = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    const role = message.role === "assistant" ? "model" : "user";
    const text = String(message.content || "");

    if (!text.trim()) continue;

    const previous = contents[contents.length - 1];

    if (previous && previous.role === role) {
      previous.parts[0].text += "\n\n" + text;
    } else {
      contents.push({
        role,
        parts: [{ text }]
      });
    }
  }

  while (contents.length && contents[0].role === "model") {
    contents.shift();
  }

  return contents;
}

async function callGemini(messages, apiKey, systemInstruction, temperature = 0.7) {
  const contents = prepareGeminiContents(messages);

  if (!contents.length) {
    throw new Error("No conversation content for Gemini");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    throw new Error(data.error?.message || "Gemini request failed");
  }

  return data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("") || "";
}

async function webSearch(query) {
  if (!process.env.TAVILY_API_KEY) {
    throw new Error("Web search is not configured");
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
    throw new Error(data.error?.message || "Web search failed");
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

async function generateImage(prompt) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Image generation is not configured");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.image}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"]
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "Image generation failed");
  }

  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(part => part.inlineData?.data);

  if (!imagePart) {
    throw new Error("No image was returned");
  }

  return {
    mimeType: imagePart.inlineData.mimeType || "image/png",
    data: imagePart.inlineData.data
  };
}

async function authenticate(token) {
  if (
    !token ||
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_ANON_KEY
  ) {
    throw new Error("Authentication required");
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
    throw new Error("Invalid or expired login session");
  }

  return response.json();
}

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
    throw new Error("Could not load user profile");
  }

  const rows = await response.json();
  return rows?.[0] || {};
}

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
    throw new Error("Could not save memory");
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
    throw new Error("Could not load memories");
  }

  return response.json();
}

async function deleteMemory(id, userId, token) {
  if (!id) throw new Error("Memory ID is required");

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
    throw new Error("Could not delete memory");
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
    throw new Error("Could not clear memories");
  }

  return true;
}

function getModePrompt(mode) {
  const prompts = {
    normal: "Answer naturally and helpfully.",
    study: "Act as a patient tutor. Explain concepts step by step and use examples.",
    coding: "Act as an expert programmer. Give practical, correct code and explain important steps.",
    creative: "Be creative and original while following the user's request.",
    research: "Analyze carefully. Distinguish facts from uncertainty and use available evidence."
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

export default async (request) => {
  if (request.method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: HEADERS,
      body: ""
    };
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const token = (request.headers.authorization || "")
      .replace(/^Bearer\s+/i, "");

    const user = await authenticate(token);
    const body = await request.json();

    const {
      message,
      messages = [],
      action = "chat",
      webSearchEnabled = false,
      mode = "normal",
      temperature = 0.7
    } = body;

    // Memory actions
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
        return json(400, { error: "Memory is required" });
      }

      if (body.memory.length > 2000) {
        return json(413, { error: "Memory is too long" });
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

    // Image generation
    if (action === "generate_image") {
      if (
        typeof body.prompt !== "string" ||
        !body.prompt.trim()
      ) {
        return json(400, { error: "Image prompt is required" });
      }

      if (body.prompt.length > 4000) {
        return json(413, { error: "Image prompt is too long" });
      }

      const image = await generateImage(body.prompt.trim());

      return json(200, {
        success: true,
        image
      });
    }

    // Chat validation
    if (typeof message !== "string" || !message.trim()) {
      return json(400, { error: "Message is required" });
    }

    if (message.length > 30000) {
      return json(413, { error: "Message is too long" });
    }

    // Load user profile
    let profile = {};

    try {
      profile = await loadProfile(user.id, token);
    } catch (error) {
      console.error("Profile loading error:", error.message);
    }

    // Optional web search
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

    // Load saved user memories
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

    let answer = "";
    let provider = "groq";
    let groqErrorMessage = "";

    // Groq primary, Gemini fallback
    try {
      if (!process.env.GROQ_API_KEY) {
        throw new Error("Groq API key missing");
      }

      answer = await callGroq(
        fullMessages,
        process.env.GROQ_API_KEY,
        safeTemperature
      );
    } catch (error) {
      groqErrorMessage = error.message;
      console.error("Groq error:", groqErrorMessage);

      if (!process.env.GEMINI_API_KEY) {
        throw new Error(
          "Groq failed and Gemini API key is missing: " +
          groqErrorMessage
        );
      }

      provider = "gemini";

      answer = await callGemini(
        fullMessages,
        process.env.GEMINI_API_KEY,
        systemInstruction,
        safeTemperature
      );
    }

    if (!answer.trim()) {
      throw new Error("The AI returned an empty response");
    }

    return json(200, {
      success: true,
      answer,
      provider,
      memoryUsed,
      webSearchUsed,
      profileUsed: Boolean(profileContext)
    });

  } catch (error) {
    console.error("QuBix error:", error);

    const message = error.message || "Something went wrong";

    const statusCode =
      message.includes("Authentication") ||
      message.includes("session")
        ? 401
        : 500;

    return json(statusCode, {
      error: message
    });
  }
};
