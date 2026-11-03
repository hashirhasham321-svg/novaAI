
exports.handler = async (event) => {
  const json = (statusCode, data) => ({
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return json(500, { error: "GEMINI_API_KEY is missing in Netlify." });
  }

  let message;

  try {
    message = JSON.parse(event.body || "{}").message;
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  if (typeof message !== "string" || !message.trim()) {
    return json(400, { error: "Message is required." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 22000);

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "You are Nova AI, a helpful assistant. Answer clearly in English, Urdu or Roman Urdu."
            }]
          },
          contents: [{
            role: "user",
            parts: [{ text: message.trim() }]
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1024
          }
        }),
        signal: controller.signal
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return json(response.status, {
        error: data.error?.message || "Gemini API error"
      });
    }

    const reply = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("") || "No answer generated.";

    return json(200, { reply });

  } catch (error) {
    console.error("Nova AI error:", error);

    if (error.name === "AbortError") {
      return json(504, {
        error: "Gemini took too long to respond. Please try again."
      });
    }

    return json(500, {
      error: error.message || "AI request failed."
    });

  } finally {
    clearTimeout(timeout);
  }
};
