const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const MODELS = {
  groq: "openai/gpt-oss-20b",
  gemini: "gemini-2.5-flash"
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

const isUUID = value =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function supabaseHeaders(token, extra = {}) {
  return {
    apikey: process.env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extra
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

async function callGemini(messages, apiKey) {
  const systemMessage = messages.find(m => m.role === "system");

  const contents = messages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "") }]
    }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: systemMessage?.content || SYSTEM_PROMPT
          }]
        },
        contents,
        generationConfig: {
          temperature: 0.7,
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
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=" +
      process.env.GEMINI_API_KEY,
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
  const imagePart = parts.find(p => p.inlineData?.data);

  if (!imagePart) {
    throw new Error("No image was returned");
  }

  return {
    mimeType: imagePart.inlineData.mimeType,
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

/* =========================
   MEMORY FEATURES
========================= */

async function saveMemory(userId, memory, category, token) {
  const url = new URL(
    `${process.env.SUPABASE_URL}/rest/v1/qubix_memories`
  );

  url.searchParams.set("on_conflict", "user_id,memory");

  const response = await fetch(url, {
    method: "POST",
    headers: supabaseHeaders(token, {
      Prefer: "resolution=merge-duplicates,return=minimal"
    }),
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
    headers: supabaseHeaders(token)
  });

  if (!response.ok) {
    throw new Error("Could not load memories");
  }

  return response.json();
}

async function deleteMemory(id, userId, token) {
  if (!isUUID(id)) {
    throw new Error("Invalid memory ID");
  }

  const url = new URL(
    `${process.env.SUPABASE_URL}/rest/v1/qubix_memories`
  );

  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("user_id", `eq.${userId}`);

  const response = await fetch(url, {
    method: "DELETE",
    headers: supabaseHeaders(token)
  });

  if (!response.ok) {
    throw new Error("Could not delete memory");
  }

  return true;
}

/* =========================
   CHAT SHARING FEATURES
========================= */

async function createShare(chatId, userId, token) {
  if (!isUUID(chatId)) {
    throw new Error("Invalid chat ID");
  }

  // Check ownership before creating a public link.
  const chatUrl = new URL(
    `${process.env.SUPABASE_URL}/rest/v1/chats`
  );

  chatUrl.searchParams.set("select", "id");
  chatUrl.searchParams.set("id", `eq.${chatId}`);
  chatUrl.searchParams.set("user_id", `eq.${userId}`);
  chatUrl.searchParams.set("limit", "1");

  const chatResponse = await fetch(chatUrl, {
    headers: supabaseHeaders(token)
  });

  if (!chatResponse.ok) {
    throw new Error("Could not verify chat ownership");
  }

  const chats = await chatResponse.json();

  if (!chats.length) {
    throw new Error("Chat not found or access denied");
  }

  // Create share record.
  const shareResponse = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/qubix_shares`,
    {
      method: "POST",
      headers: supabaseHeaders(token, {
        Prefer: "return=representation"
      }),
      body: JSON.stringify({
        chat_id: chatId,
        user_id: userId
      })
    }
  );

  const shareData = await shareResponse.json();

  if (!shareResponse.ok || !shareData?.[0]?.share_token) {
    throw new Error("Could not create share link");
  }

  const tokenValue = shareData[0].share_token;
  const siteUrl = process.env.URL || "https://qubixai.netlify.app";

  return {
    shareToken: tokenValue,
    shareUrl: `${siteUrl}/share.html?token=${encodeURIComponent(tokenValue)}`
  };
}

async function revokeShare(shareToken, userId, token) {
  if (!isUUID(shareToken)) {
    throw new Error("Invalid share token");
  }

  const url = new URL(
    `${process.env.SUPABASE_URL}/rest/v1/qubix_shares`
  );

  url.searchParams.set("share_token", `eq.${shareToken}`);
  url.searchParams.set("user_id", `eq.${userId}`);

  const response = await fetch(url, {
    method: "PATCH",
    headers: supabaseHeaders(token, {
      Prefer: "return=minimal"
    }),
    body: JSON.stringify({
      is_active: false
    })
  });

  if (!response.ok) {
    throw new Error("Could not revoke share link");
  }

  return true;
}

/* =========================
   MAIN NETLIFY FUNCTION
========================= */

export default async (request) => {
  if (request.method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: HEADERS,
      body: ""
    };
  }

  if (request.method !== "POST") {
    return json(405, {
      error: "Method not allowed"
    });
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

    /* MEMORY ACTIONS */

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

    if (action === "memory_delete") {
      await deleteMemory(body.id, user.id, token);

      return json(200, {
        success: true
      });
    }

    if (action === "memory_clear") {
      const url = new URL(
        `${process.env.SUPABASE_URL}/rest/v1/qubix_memories`
      );

      url.searchParams.set("user_id", `eq.${user.id}`);

      const response = await fetch(url, {
        method: "DELETE",
        headers: supabaseHeaders(token)
      });

      if (!response.ok) {
        throw new Error("Could not clear memories");
      }

      return json(200, {
        success: true
      });
    }

    /* CHAT SHARING ACTIONS */

    if (action === "create_share") {
      const result = await createShare(
        body.chatId,
        user.id,
        token
      );

      return json(200, {
        success: true,
        ...result
      });
    }

    if (action === "revoke_share") {
      await revokeShare(
        body.shareToken,
        user.id,
        token
      );

      return json(200, {
        success: true
      });
    }

    /* IMAGE GENERATION */

    if (action === "generate_image") {
      if (
        typeof body.prompt !== "string" ||
        !body.prompt.trim()
      ) {
        return json(400, {
          error: "Image prompt is required"
        });
      }

      if (body.prompt.length > 4000) {
        return json(413, {
          error: "Image prompt is too long"
        });
      }

      const image = await generateImage(body.prompt.trim());

      return json(200, {
        success: true,
        image
      });
    }

    /* NORMAL CHAT */

    if (
      typeof message !== "string" ||
      !message.trim()
    ) {
      return json(400, {
        error: "Message is required"
      });
    }

    if (message.length > 30000) {
      return json(413, {
        error: "Message is too long"
      });
    }

    /* OPTIONAL WEB SEARCH */

    let searchContext = "";

    if (webSearchEnabled) {
      try {
        const results = await webSearch(message);

        searchContext = `
Web search results:
${JSON.stringify(results)}

Use these results carefully.
Do not invent sources or claim that you opened a page unless you did.
`;
      } catch (error) {
        console.error("QuBix web search:", error.message);
        searchContext =
          "Web search was unavailable for this request.";
      }
    }

    /* LOAD USER MEMORIES */

    let memoryContext = "";

    try {
      const memories = await listMemories(user.id, token);

      memoryContext = memories.length
        ? "\nUser memories:\n" +
          memories.map(m => `- ${m.memory}`).join("\n")
        : "";
    } catch (error) {
      console.error("QuBix memory loading:", error.message);
    }

    /* CHAT MODES */

    const modePrompts = {
      normal: "Answer naturally and helpfully.",
      study: "Act as a patient tutor. Explain concepts step by step.",
      coding: "Act as an expert programmer. Give practical, correct code.",
      creative: "Be creative and original while following the request.",
      research: "Analyze carefully and distinguish facts from uncertainty."
    };

    const selectedMode =
      modePrompts[mode] || modePrompts.normal;

    /* CONVERSATION HISTORY */

    const conversation = Array.isArray(messages)
      ? messages.slice(-20).map(m => ({
          role: m.role === "assistant"
            ? "assistant"
            : "user",
          content: String(m.content || "").slice(0, 12000)
        }))
      : [];

    conversation.push({
      role: "user",
      content: message.trim()
    });

    const fullMessages = [
      {
        role: "system",
        content:
          SYSTEM_PROMPT +
          "\n" + selectedMode +
          memoryContext +
          searchContext
      },
      ...conversation
    ];

    /* GROQ PRIMARY, GEMINI FALLBACK */

    let answer = "";
    let provider = "groq";

    try {
      if (!process.env.GROQ_API_KEY) {
        throw new Error("Groq API key missing");
      }

      const safeTemperature = Math.min(
        1.5,
        Math.max(
          0,
          Number.isFinite(Number(temperature))
            ? Number(temperature)
            : 0.7
        )
      );

      answer = await callGroq(
        fullMessages,
        process.env.GROQ_API_KEY,
        safeTemperature
      );

    } catch (groqError) {
      console.error("Groq failed; trying Gemini:", groqError.message);

      if (!process.env.GEMINI_API_KEY) {
        throw groqError;
      }

      provider = "gemini";

      answer = await callGemini(
        fullMessages,
        process.env.GEMINI_API_KEY
      );
    }

    if (!answer.trim()) {
      throw new Error("The AI returned an empty response");
    }

    return json(200, {
      success: true,
      answer,
      provider,
      memoryUsed: Boolean(memoryContext),
      webSearchUsed: Boolean(searchContext)
    });

  } catch (error) {
    console.error("QuBix error:", error);

    const message = error.message || "Something went wrong";

    const statusCode =
      message.includes("Authentication") ||
      message.includes("session")
        ? 401
        : message.includes("Invalid") ||
          message.includes("required")
          ? 400
          : 500;

    return json(statusCode, {
      error: message
    });
  }
};
