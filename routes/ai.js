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
        system: `You are a research assistant for Sean Kalman, a Nantucket real estate agent. Search the web and return the most useful results as plain bullet points.

OUTPUT RULES:
- Return up to 10 bullets — never more. If you find more, pick the 10 best.
- Use "• " to start each bullet (the bullet character followed by a space).
- Each bullet is one specific fact, event, place, or person with a name, date, or brief detail.
- No markdown headers, no **bold**, no numbering.
- Plain text only — this is going straight into a notes field.
- If the web search genuinely turned up nothing relevant, return a single bullet that names the closest related thing you DID find on Nantucket, plus a note about the year. Never return an empty response.`,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("Anthropic web search error:", err);
      return res.status(502).json({ error: "Search failed — please try again" });
    }

    const data = await anthropicRes.json();

    // Web search responses contain multiple content blocks (tool_use,
    // tool_result, text). Concatenate ALL text blocks — grabbing only the
    // first one can miss the actual answer when Claude leads with a tool
    // call and follows up with text in a later block.
    const textBlocks = (data.content || [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text.trim())
      .filter(Boolean);
    const result = textBlocks.join("\n\n") || "No results returned.";

    res.json({ result });
  } catch (err) {
    next(err);
  }
});

// ─── POST /ai/synthesize-profile ──────────────────────────────────────────────
// Build a "profile memory" snapshot of the user's company and voice.
//   Body: {
//     profile: {                  // CompanyProfile shape from the desktop app
//       companyName, industry, tagline, bio, website,
//       brandVoice, targetAudience, brandColors, handles: { ... }
//     },
//     websiteUrl?: string,        // optional override; defaults to profile.website
//     existingNotes?: string      // any prior snapshot the user has tweaked
//   }
//   Returns: { snapshot, scrapedChars, scrapedTitle }
//
// The endpoint scrapes the home page (and follows up to 2 obvious about/services
// links) server-side — no CORS issues, runs even when the user hasn't set up
// any API keys. Output is plain prose suitable to paste into Memory Bank.
router.post("/synthesize-profile", async (req, res, next) => {
  try {
    const { profile, websiteUrl, existingNotes } = req.body || {};
    if (!profile || typeof profile !== "object") {
      return res.status(400).json({ error: "profile object is required" });
    }

    const urlToScrape = (websiteUrl || profile.website || "").trim();

    let scrapedText = "";
    let scrapedTitle = "";
    if (urlToScrape) {
      const result = await scrapeSiteForContext(urlToScrape).catch((err) => {
        console.warn("[synthesize-profile] scrape failed:", err?.message);
        return null;
      });
      if (result) {
        scrapedText = result.text;
        scrapedTitle = result.title;
      }
    }

    // Build the synthesis prompt. The result lands in the user's Memory Bank as
    // an always-on background block in every caption-generation call.
    const profileBlock = formatProfileForPrompt(profile);
    const existingBlock = existingNotes && String(existingNotes).trim()
      ? `\n\nEXISTING NOTES the user has already curated (preserve any useful specifics, but feel free to reorganize / rewrite for clarity):\n${String(existingNotes).trim()}`
      : "";
    const scrapedBlock = scrapedText
      ? `\n\nWEBSITE CONTENT scraped from ${urlToScrape}${scrapedTitle ? ` (page title: "${scrapedTitle}")` : ""}:\n${scrapedText}`
      : urlToScrape
      ? `\n\nNOTE: The user provided ${urlToScrape} but the site could not be scraped (might be a client-rendered SPA or behind auth). Work with the profile fields only.`
      : "";

    const systemPrompt = `You are a brand strategist building a concise "user memory" — a permanent background note that an AI caption writer will reference on every post that user generates.

Your output should help the AI write copy that sounds genuinely like this person and their business, with the right facts, voice, and audience in mind.

WRITE the snapshot as plain prose (3–6 short paragraphs, no headers, no bullet points, no markdown). Cover, in order:
1. Who the person and the company are (name, location, what they do, anything that gives them edge or credibility)
2. The services / products / focus areas worth knowing about
3. The brand voice — how they sound, what to avoid
4. The target audience and what those people care about
5. Any specific facts worth remembering (years in business, generations on the island, specialties, notable inventory or markets, signature phrases, etc.)

RULES:
- Write in third person.
- Be specific, not generic. If the source material is thin, say so honestly rather than padding with filler.
- 200–500 words total. Tight beats verbose.
- No "stunning", "breathtaking", "one-of-a-kind", "luxury living" or any other real-estate cliché.
- NEVER include emojis.
- Return ONLY the snapshot prose — no preamble, no explanation, no JSON wrapping.`;

    const userMessage = `Synthesize a profile memory for the AI to reference when writing this user's social posts.${profileBlock}${scrapedBlock}${existingBlock}`;

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
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      console.error("[synthesize-profile] Anthropic error:", err);
      return res.status(502).json({ error: "AI synthesis failed — please try again" });
    }

    const data = await anthropicRes.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n")
      .trim();

    return res.json({
      snapshot: text,
      scrapedChars: scrapedText.length,
      scrapedTitle,
    });
  } catch (err) {
    next(err);
  }
});

// ── Site scraper ─────────────────────────────────────────────────────────────
// Lightweight HTML → plain text using regex (no cheerio dep). Fetches the home
// page plus up to two follow-up links whose href text contains "about" or
// "services". Total output is capped so the AI prompt stays a sensible size.
async function scrapeSiteForContext(rawUrl) {
  const homeUrl = normalizeUrl(rawUrl);
  if (!homeUrl) throw new Error("invalid URL");

  const home = await fetchHtmlSafely(homeUrl);
  if (!home) return null;

  const followUps = findFollowUpLinks(home.html, homeUrl).slice(0, 2);
  const followTexts = [];
  for (const link of followUps) {
    const page = await fetchHtmlSafely(link).catch(() => null);
    if (page) followTexts.push(`[${link}]\n${page.text}`);
  }

  const combined = [
    `[${homeUrl}${home.title ? ` — ${home.title}` : ""}]\n${home.text}`,
    ...followTexts,
  ].join("\n\n").slice(0, 10_000);

  return { text: combined, title: home.title || "" };
}

function normalizeUrl(input) {
  let u = String(input).trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function fetchHtmlSafely(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: ctl.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(ctype)) return null;
    const html = (await res.text()).slice(0, 800_000); // hard cap raw HTML
    return { html, text: htmlToText(html), title: extractTitle(html) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeBasicEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

function htmlToText(html) {
  return decodeBasicEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 8_000);
}

function decodeBasicEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…");
}

function findFollowUpLinks(html, baseUrl) {
  const links = new Set();
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    const text = decodeBasicEntities(m[2].replace(/<[^>]+>/g, "")).trim().toLowerCase();
    if (!/about|service|practice|team|story|approach/i.test(text + " " + href)) continue;
    try {
      const abs = new URL(href, baseUrl).toString();
      const absUrl = new URL(abs);
      const baseHost = new URL(baseUrl).host;
      if (absUrl.host !== baseHost) continue; // same-origin only
      if (abs === baseUrl) continue;
      links.add(abs);
    } catch {
      /* skip malformed href */
    }
  }
  return [...links];
}

function formatProfileForPrompt(profile) {
  const lines = [];
  const push = (label, value) => {
    if (value && String(value).trim()) lines.push(`- ${label}: ${String(value).trim()}`);
  };
  push("Company name", profile.companyName);
  push("Industry", profile.industry);
  push("Tagline", profile.tagline);
  push("Bio", profile.bio);
  push("Website", profile.website);
  push("Brand voice", profile.brandVoice);
  push("Target audience", profile.targetAudience);
  if (Array.isArray(profile.brandColors) && profile.brandColors.length) {
    push("Brand colors", profile.brandColors.join(", "));
  }
  if (profile.handles && typeof profile.handles === "object") {
    const handles = Object.entries(profile.handles)
      .filter(([, v]) => v && String(v).trim())
      .map(([k, v]) => `${k}: @${String(v).replace(/^@/, "")}`)
      .join(", ");
    if (handles) push("Social handles", handles);
  }
  return lines.length
    ? `\n\nPROFILE FIELDS the user entered:\n${lines.join("\n")}`
    : "\n\nPROFILE FIELDS: (empty — user has not filled out their profile yet)";
}

module.exports = router;
