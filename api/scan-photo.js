import OpenAI from "openai";

const MODEL = "gpt-4o";
const MAX_TOKENS = 1500;

const VISION_PROMPT =
  "Look at this photo of a room, closet, or belongings. List every distinct item you see. " +
  "For each: name (string), category (clothing/electronics/books/kitchen/furniture/toys/other), " +
  "size (small/medium/large). Return ONLY valid JSON: { items: [{name, category, size}] }. " +
  "No prose, no markdown.";

// Split a data URL into its media type and bare base64 payload. Accepts a raw
// base64 string too, in which case we assume JPEG.
function splitDataUrl(image) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(image);
  if (match) return { mediaType: match[1], data: match[2] };
  return { mediaType: "image/jpeg", data: image.replace(/^data:[^,]*,/, "") };
}

// The model is asked for bare JSON, but strip code fences / stray prose just in case.
function parseModelJson(text) {
  const candidates = [
    text,
    text.match(/```json\s*([\s\S]*?)```/)?.[1],
    text.match(/```\s*([\s\S]*?)```/)?.[1],
    text.match(/\{[\s\S]*\}/)?.[0],
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (e) {
      /* try the next candidate */
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // Same casing tolerance as the Wallet Coach chat function.
  const apiKey = process.env.OPENAI_API_KEY || process.env.openAI_api_key;
  if (!apiKey) {
    console.error("No API key set (checked OPENAI_API_KEY and openAI_api_key)");
    return res.status(500).json({ error: "OPENAI_API_KEY is not set on the server." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const image = body?.image;
    if (!image || typeof image !== "string") {
      return res.status(500).json({ error: "Request body must include an `image` data URL." });
    }

    const { mediaType, data } = splitDataUrl(image);
    if (!data) {
      return res.status(500).json({ error: "The `image` field did not contain any image data." });
    }

    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } },
          ],
        },
      ],
    });

    const text = completion.choices?.[0]?.message?.content?.trim() || "";
    const parsed = parseModelJson(text);
    if (!parsed || !Array.isArray(parsed.items)) {
      return res.status(500).json({ error: "The vision model did not return the expected JSON shape." });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("scan-photo failed:", err);

    if (err instanceof OpenAI.AuthenticationError) {
      return res.status(500).json({ error: "Photo scanning is not configured yet. (Invalid API key.)" });
    }
    if (err instanceof OpenAI.PermissionDeniedError) {
      return res.status(500).json({ error: "Photo scanning is not configured yet. (Key lacks access to this model.)" });
    }
    if (err instanceof OpenAI.RateLimitError) {
      const quota = /quota|billing|insufficient/i.test(err.message);
      return res.status(500).json({
        error: quota
          ? "The OpenAI account is out of credit."
          : "Too many scans at once. Wait a moment and try again.",
      });
    }
    return res.status(500).json({ error: err?.message || "Unknown error while scanning the photo." });
  }
}
