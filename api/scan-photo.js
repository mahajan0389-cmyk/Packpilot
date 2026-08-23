import OpenAI from "openai";

const MODEL = "gpt-4o";
const BUILD_MARKER = "diag-v3";
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

// The key has been stored under several names across environments, so match on a
// normalised form (case- and underscore-insensitive) rather than one exact spelling.
const KEY_NAMES = new Set(["openaiapikey", "openapikey", "openaikey", "openkey"]);

function resolveApiKey(env) {
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY;
  const name = Object.keys(env).find((k) =>
    KEY_NAMES.has(k.replace(/_/g, "").toLowerCase())
  );
  return name ? env[name] : undefined;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const apiKey = resolveApiKey(process.env);
  if (!apiKey) {
    // Temporary diagnostic: report the build marker and any key-ish env var NAMES
    // (never values) straight into the error, so the app's TECHNICAL DETAILS panel
    // shows what this deployment can actually see.
    const candidates = Object.keys(process.env)
      .filter((k) => /key|openai|api/i.test(k))
      .sort();
    console.error(`No OpenAI key found. Candidate env names: ${candidates.join(", ")}`);
    return res.status(500).json({
      error:
        `[${BUILD_MARKER}] No OpenAI key found. Env var names visible to this function: ` +
        (candidates.length ? candidates.join(", ") : "(none matching key/api/openai)"),
    });
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
