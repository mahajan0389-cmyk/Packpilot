import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-5";

const VISION_PROMPT =
  "Look at this photo of a room, closet, or belongings. List every distinct item you see. " +
  "For each: name (string), category (clothing/electronics/books/kitchen/furniture/toys/other), " +
  "size (small/medium/large). Return ONLY valid JSON: { items: [{name, category, size}] }. " +
  "No prose, no markdown.";

// Pull the media type out of a data URL and hand back the bare base64 payload.
// Accepts a raw base64 string too, in which case we assume JPEG.
function splitDataUrl(image) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(image);
  if (match) return { mediaType: match[1], data: match[2] };
  return { mediaType: "image/jpeg", data: image.replace(/^data:[^,]*,/, "") };
}

// The model is told to return bare JSON, but strip code fences / stray prose just in case.
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

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server." });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const image = body?.image;
    if (!image || typeof image !== "string") {
      return res.status(500).json({ error: "Request body must include an `image` data URL." });
    }

    const { mediaType, data } = splitDataUrl(image);
    if (!data) {
      return res.status(500).json({ error: "The `image` field did not contain any image data." });
    }

    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data } },
            { type: "text", text: VISION_PROMPT },
          ],
        },
      ],
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    const parsed = parseModelJson(text);
    if (!parsed || !Array.isArray(parsed.items)) {
      return res.status(500).json({ error: "The vision model did not return the expected JSON shape." });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("scan-photo failed:", err);
    return res.status(500).json({ error: err?.message || "Unknown error while scanning the photo." });
  }
}
