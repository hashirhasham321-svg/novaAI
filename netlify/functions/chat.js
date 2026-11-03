
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
  if (!apiKey) return json(500, { error: "Gemini API key missing." });

  let message;
  try {
    message = JSON.parse(event.body || "{}").message;
  } catch {
    return json(400, { error: "Invalid request." });
  }

  if (typeof message !== "string" || !message.trim()) {
    return json(400, { error: "Message is required." });
  }

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [{ text: message.trim() }]
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 512
          }
        })
      });

      const data = await response.json();

      if (response.ok) {
        const reply = data.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "").join("");

        return json(200, { reply: reply || "No answer generated." });
      }

      if (response.status !== 503 && response.status !== 429) {
        return json(response.status, {
          error: data.error?.message || "Gemini API error."
        });
      }

      if (attempt === 2) {
        return json(503, {
          error: "Gemini is busy right now. Please try again shortly."
        });
      }

    } catch (error) {
      console.error("Gemini request failed:", error);
      if (attempt === 2) {
        return json(500, { error: "Could not connect to Gemini." });
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }

  return json(503, { error: "Gemini is temporarily unavailable." });
};
