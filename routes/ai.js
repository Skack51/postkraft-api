const express = require("express");
// fetch is available globally in Node 18+ — no import needed
const requireAuth = require("../middleware/requireAuth");
const requireSubscription = require("../middleware/requireSubscription");

const router = express.Router();

// All AI routes require auth + active subscription
router.use(requireAuth, requireSubscription);

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-6";

// Per-platform caption specs (mirrors what the desktop app uses)
const PLATFORM_SPECS = {
  instagram: {
    maxChars: 1200,
    hashtagCount: "10-15",
    style: "Visual, aspirational, storytelling. Community hashtags.",
  },
  facebook: {
    maxChars: 500,
    hashtagCount: "3-5",
    style: "Conversational, informative, neighborhood-focused.",
  },
  linkedin: {
    maxChars: 600,
    hashtagCount: "3-5",
    style: "Professional, market insight angle, agent credibility.",
  },
};

// ─── POST /ai/generate ───────────────────────────────────────────────────────
// Generic proxy used by the Electron app's aiCaptionGenerator.ts.
// Body: { systemPrompt, userMessage, imageBase64? }
// Returns the raw Anthropic response so the client can parse it.
router.post("/generate", async (req, res, next) => {
  try {
    const { systemPrompt, userMessage, imageBase64 } = req.body;

    if (!systemPrompt || !userMessage) {
      return res.status(400).json({ error: "systemPrompt and userMessage are required" });
    }

    const userContent = [];
    if (imageBase64) {
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: imageBase64 },
      });
    }
    userContent.push({ type: "text", text: userMessage });

    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("Anthropic API error:", err);
      return res.status(502).json({ error: "AI service error — please try again" });
    }

    const data = await anthropicRes.json();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ─── POST /ai/caption ─────────────────────────────────────────────────────────
// Body: {
//   image_url?: string,       // publicly accessible URL (e.g. Cloudinary)
//   image_base64?: string,    // base64-encoded image as fallback
//   image_media_type?: string, // e.g. 'image/jpeg'
//   platforms: string[],      // ['instagram', 'facebook', 'linkedin']
//   context?: string,         // user-provided notes about the property/image
//   memory?: object,          // user's Memory Bank (profile, style prefs, etc.)
// }
// Returns: { captions: { instagram?, facebook?, linkedin? } }
router.post("/caption", async (req, res, next) => {
  try {
    const { image_url, image_base64, image_media_type, platforms, context, memory } = req.body;

    if (!platforms || !platforms.length) {
      return res.status(400).json({ error: "platforms array is required" });
    }
    if (!image_url && !image_base64) {
      return res.status(400).json({ error: "image_url or image_base64 is required" });
    }

    // Build the image content block
    let imageBlock;
    if (image_url) {
      imageBlock = { type: "image", source: { type: "url", url: image_url } };
    } else {
      imageBlock = {
        type: "image",
        source: {
          type: "base64",
          media_type: image_media_type || "image/jpeg",
          data: image_base64,
        },
      };
    }

    // Build platform specs section
    const platformInstructions = platforms
      .map((p) => {
        const spec = PLATFORM_SPECS[p];
        if (!spec) return null;
        return `**${p.toUpperCase()}**: max ${spec.maxChars} chars, ${spec.hashtagCount} hashtags. Style: ${spec.style}`;
      })
      .filter(Boolean)
      .join("\n");

    // Build memory context
    const memoryContext = memory
      ? `
Agent profile:
- Name: ${memory.agentName || "Real estate agent"}
- Brokerage: ${memory.brokerageName || ""}
- Market: ${memory.market || ""}
- Style notes: ${memory.styleNotes || ""}
- Website: ${memory.website || ""}
`.trim()
      : "";

    const systemPrompt = `You are an expert social media copywriter.
Write captions that are confident, specific, and human — no generic filler, no clichés like "stunning" or "breathtaking".
Return ONLY valid JSON. No markdown, no explanation, just the JSON object.`;

    const userPrompt = `Look at this real estate photo and write captions for: ${platforms.join(", ")}.

${memoryContext}
${context ? `Additional context: ${context}` : ""}

Platform requirements:
${platformInstructions}

Return this exact JSON structure (only include keys for requested platforms):
{
  "instagram": { "caption": "...", "hashtags": "#tag1 #tag2 ...", "cta": "..." },
  "facebook":  { "caption": "...", "hashtags": "#tag1 #tag2 ...", "cta": "..." },
  "linkedin":  { "caption": "...", "hashtags": "#tag1 #tag2 ...", "cta": "..." }
}`;

    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [imageBlock, { type: "text", text: userPrompt }],
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("Anthropic API error:", err);
      return res.status(502).json({ error: "AI service error — please try again" });
    }

    const anthropicData = await anthropicRes.json();
    const rawText = anthropicData.content?.[0]?.text || "{}";

    let captions;
    try {
      captions = JSON.parse(rawText);
    } catch {
      console.error("Failed to parse AI response:", rawText);
      return res.status(502).json({ error: "AI returned unexpected format — please try again" });
    }

    res.json({ captions });
  } catch (err) {
    next(err);
  }
});

// ─── POST /ai/search ─────────────────────────────────────────────────────────
// Body: { prompt, theme? }
// Returns: { result: string }
router.post("/search", async (req, res, next) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "prompt is required" });
    }

    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: `You are a research assistant for Sean Kalman, a Nantucket real estate agent. Search the web and return EXACTLY the top 10 most relevant results as plain bullet points only.

HARD RULES:
- Return at most 10 bullets — never more, even if you find more relevant items. Pick the top 10.
- Use "• " to start each bullet (the bullet character followed by a space).
- Each bullet is one specific fact or event with a name, date, location, or brief detail.
- No markdown headers, no **bold**, no numbering, no intro sentence, no outro sentence.
- Plain text only — this is going straight into a notes field.`,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("Anthropic web search error:", err);
      return res.status(502).json({ error: "Search failed — please try again" });
    }

    const data = await anthropicRes.json();
    const textBlock = data.content?.find((b) => b.type === "text");
    const result = textBlock?.text ?? "No results returned.";

    res.json({ result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
