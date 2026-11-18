
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

const json = (statusCode, body) => new Response(
  JSON.stringify(body),
  {
    status: statusCode,
    headers: HEADERS
  }
);

function getSupabaseHeaders(token) {
  return {
    apikey: process.env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

// GROQ AI
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

// GEMINI HISTORY FORMAT
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

// GEMINI BACKUP AI
async function callGemini(
  messages,
  apiKey,
  systemInstruction,
  temperature = 0.7
) {
  const contents = prepareGeminiContents(messages);

  if (!contents.length) {
    throw new Error("No conversation content for Gemini");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
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
    throw new Error(data.error?.message || "Gemini request failed");
  }

  return data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("") || "";
}

// WEB SEARCH
async function webSearch(query) {
  if (!process.env.TAVILY_API_KEY) {
    throw new Error("Web search is not configured");
  }

  const response = await fetch(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: true
      })
    }
  );

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

// IMAGE GENERATION
async function generateImage(prompt) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Image generation is not configured");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.image}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
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
    throw new Error(
      parts.find(part => part.text)?.text || "No image was returned"
    );
  }

  return {
    mimeType: imagePart.inlineData.mimeType || "image/png",
    data: imagePart.inlineData.data
  };
}

// SUPABASE AUTHENTICATION
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

// LOAD USER PROFILE
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

// SAVE MEMORY
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

// LIST MEMORIES
async function listMemories(userId, token) {
  const url = new URL(
    `${process.env.SUPABASE_URL}/rest/v1/qubix_memories`
  );

  url.searchParams.set(
    "select",
    "id,memory,category,created_at"
  );
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

// DELETE ONE MEMORY
async function deleteMemory(id, userId, token) {
  if (!id) {
    throw new Error("Memory ID is required");
  }

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

// CLEAR ALL MEMORIES
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

// AI MODES
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

// USER PROFILE INSTRUCTIONS
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

// MAIN NETLIFY FUNCTION
export default async (request) => {

  // CORS PREFLIGHT
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: HEADERS
    });
  }

  if (request.method !== "POST") {
    return json(405, {
      error: "Method not allowed"
    });
  }

  try {
    // AUTHENTICATION
    const token = (request.headers.get("authorization") || "")
      .replace(/^Bearer\s+/i, "");

    const user = await authenticate(token);

    const body = await request.json();

    // SUPPORT OLD AND NEW FRONTEND FORMATS
    const message =
      typeof body.message === "string"
        ? body.message
        : "";

    const action = body.action || "chat";
    const mode = body.mode || "normal";
    const temperature = body.temperature ?? 0.7;

    const webSearchEnabled =
      body.webSearchEnabled === true ||
      body.webSearch === true;

    const conversationInput = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.history)
        ? body.history
        : [];

    // MEMORY: LIST
    if (action === "memory_list") {
      return json(200, {
        success: true,
        memories: await listMemories(user.id, token)
      });
    }

    // MEMORY: SAVE
    if (action === "memory_save") {
      if (
        typeof body.memory !== "string" ||
        !body.memory.trim()
      ) {
        return json(400, {
          error: "Memory is required"
        });
      }

      if (body.memory.length > 2000) {
        return json(413, {
          error: "Memory is too long"
        });
      }

      await saveMemory(
        user.id,
        body.memory.trim(),
        body.category,
        token
      );

      return json(200, {
        success: true
      });
    }

    // MEMORY: DELETE
    if (action === "memory_delete") {
      await deleteMemory(body.id, user.id, token);

      return json(200, {
        success: true
      });
    }

    // MEMORY: CLEAR
    if (action === "memory_clear") {
      await clearMemories(user.id, token);

      return json(200, {
        success: true
      });
    }

    // IMAGE GENERATION
    if (action === "generate_image") {
      const prompt =
        typeof body.prompt === "string"
          ? body.prompt
          : message;

      if (!prompt.trim()) {
        return json(400, {
          error: "Image prompt is required"
        });
      }

      if (prompt.length > 4000) {
        return json(413, {
          error: "Image prompt is too long"
        });
      }

      const image = await generateImage(prompt.trim());

      const imageUrl =
        `data:${image.mimeType};base64,${image.data}`;

      return json(200, {
        success: true,
        image,
        imageUrl,
        data: imageUrl,
        reply: "Image generated successfully."
      });
    }

    // CHAT VALIDATION
    const userMessage = message.trim();

    if (!userMessage) {
      return json(400, {
        error: "Message is required"
      });
    }

    if (userMessage.length > 30000) {
      return json(413, {
        error: "Message is too long"
      });
    }

    // LOAD USER PROFILE
    let profile = {};

    try {
      profile = await loadProfile(user.id, token);
    } catch (error) {
      console.error(
        "Profile loading error:",
        error.message
      );
    }

    // WEB SEARCH
    let searchContext = "";
    let webSearchUsed = false;

    if (webSearchEnabled) {
      try {
        const results = await webSearch(userMessage);

        searchContext = `
Web search results:
${JSON.stringify(results)}

Use these search results carefully.
Do not invent sources or claim that you opened pages you did not open.
If the results do not answer the question, say so.
`;

        webSearchUsed = true;

      } catch (error) {
        console.error(
          "Web search error:",
          error.message
        );

        searchContext = `
Web search was requested but is unavailable for this request.
Do not pretend that a web search succeeded.
`;
      }
    }

    // LOAD SAVED MEMORIES
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
      console.error(
        "Memory loading error:",
        error.message
      );
    }

    // BUILD SYSTEM INSTRUCTIONS
    const profileContext = getProfilePrompt(profile);
    const modeContext = getModePrompt(mode);

    const systemInstruction = [
      SYSTEM_PROMPT,
      modeContext,
      profileContext,
      memoryContext,
      searchContext
    ].filter(Boolean).join("\n\n");

    // PREPARE CONVERSATION HISTORY
    const conversation = conversationInput
      .slice(-20)
      .filter(item =>
        item &&
        ["user", "assistant"].includes(item.role) &&
        typeof item.content === "string"
      )
      .map(item => ({
        role: item.role,
        content: item.content.slice(0, 12000)
      }));

    // COMPLETE MESSAGE ARRAY
    const fullMessages = [
      {
        role: "system",
        content: systemInstruction
      },
      ...conversation,
      {
        role: "user",
        content: userMessage
      }
    ];

    // TEMPERATURE
    const numericTemperature = Number(temperature);

    const safeTemperature = Math.min(
      1.5,
      Math.max(
        0,
        Number.isFinite(numericTemperature)
          ? numericTemperature
          : 0.7
      )
    );

    // AI PROVIDERS
    let answer = "";
    let provider = "groq";
    let groqErrorMessage = "";

    // GROQ PRIMARY, GEMINI BACKUP
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

      console.error(
        "Groq error:",
        groqErrorMessage
      );

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

    if (!answer || !answer.trim()) {
      throw new Error("The AI returned an empty response");
    }

    // SUCCESS RESPONSE
    return json(200, {
      success: true,

      // Both response formats
      answer,
      reply: answer,

      provider,
      memoryUsed,
      webSearchUsed,
      profileUsed: Boolean(profileContext)
    });

  } catch (error) {
    console.error("QuBix error:", error);

    const errorMessage =
      error.message || "Something went wrong";

    const statusCode =
      errorMessage.toLowerCase().includes("authentication") ||
      errorMessage.toLowerCase().includes("session") ||
      errorMessage.toLowerCase().includes("expired")
        ? 401
        : 500;

    return json(statusCode, {
      success: false,
      error: errorMessage,
      reply: errorMessage
    });
  }
};
