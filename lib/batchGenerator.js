/**
 * batchGenerator.js
 * Weekly batch generation for the paid/cloud tier.
 *
 * Once a week the scheduler calls runWeeklyBatch(). For every active cloud user
 * with batch generation enabled, it builds (connected platforms × posts_per_platform)
 * draft posts for the coming week — picking rotated photos from their synced pool
 * and writing captions in their voice with Claude — then drops them into
 * scheduled_posts as status='draft'. Drafts are ignored by the every-minute
 * scheduler until the user reviews and approves them (which flips draft → pending).
 *
 * Nothing here auto-publishes. Review-before-publish is intentional.
 *
 * NOTE on graphics: content_prefs.graphic_ratio is reserved for routing a share
 * of slots to the branded-graphic engine (Just Listed / market-stat cards). That
 * renderer isn't built yet, so for now every slot generates a photo + caption
 * post. Graphic routing plugs in at the marked spot in generateForUser().
 */

const db = require("../db");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-6";

// Per-platform caption specs — mirrors routes/ai.js so cloud captions match the
// app's manual ones.
const PLATFORM_SPECS = {
  instagram: { maxChars: 1200, hashtagCount: "10-15", style: "Visual, aspirational, storytelling. Community hashtags." },
  facebook:  { maxChars: 500,  hashtagCount: "3-5",   style: "Conversational, informative, neighborhood-focused." },
  linkedin:  { maxChars: 600,  hashtagCount: "3-5",   style: "Professional, market insight angle, agent credibility." },
  twitter:   { maxChars: 260,  hashtagCount: "1-3",   style: "Punchy, concise, one clear hook." },
  pinterest: { maxChars: 480,  hashtagCount: "2-5",   style: "Descriptive, searchable, lifestyle-oriented." },
};
const KNOWN_PLATFORMS = new Set(Object.keys(PLATFORM_SPECS));

// Default posting times when a platform has no schedule configured: spread across
// the week at 9am local.
const DEFAULT_SCHEDULE = ["Mon 09:00", "Tue 09:00", "Wed 09:00", "Thu 09:00", "Fri 09:00", "Sat 10:00", "Sun 11:00"];

const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// ── Time helpers ────────────────────────────────────────────────────────────────

// Convert a wall-clock time in a named IANA timezone to the correct UTC instant,
// DST included. Standard offset-probe technique (no external tz library).
function zonedWallTimeToUtc(year, monthIndex, day, hour, minute, timeZone) {
  const utcGuess = Date.UTC(year, monthIndex, day, hour, minute, 0);
  const probe = new Date(utcGuess);
  const asTz = new Date(probe.toLocaleString("en-US", { timeZone }));
  const asUtc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  const offset = asUtc.getTime() - asTz.getTime();
  return new Date(utcGuess + offset);
}

// Calendar date parts for "now" as seen in the given timezone.
function todayPartsInTz(timeZone) {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now); // YYYY-MM-DD
  const weekdayShort = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })
    .format(now).toLowerCase(); // 'sun'..'sat'
  const [y, m, d] = ymd.split("-").map(Number);
  return { year: y, monthIndex: m - 1, day: d, weekday: WEEKDAYS[weekdayShort] };
}

// The Monday that starts the coming week (strictly after today), in the user's tz.
function upcomingMonday(timeZone) {
  const t = todayPartsInTz(timeZone);
  // Days until next Monday (1). If today IS Monday, jump a full week.
  let delta = (1 - t.weekday + 7) % 7;
  if (delta === 0) delta = 7;
  const base = new Date(Date.UTC(t.year, t.monthIndex, t.day));
  base.setUTCDate(base.getUTCDate() + delta);
  return base; // a Date whose UTC Y/M/D are the Monday's calendar date
}

function ymdString(date) {
  return date.toISOString().slice(0, 10);
}

// Parse "Wed 17:00" → { weekday: 3, hour: 17, minute: 0 }; null if malformed.
function parseScheduleEntry(entry) {
  const m = String(entry).trim().match(/^([A-Za-z]{3})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const weekday = WEEKDAYS[m[1].toLowerCase()];
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (weekday === undefined || hour > 23 || minute > 59) return null;
  return { weekday, hour, minute };
}

// Resolve the scheduled UTC instant for slot `index` of a platform within the
// target week. Cycles through that platform's configured times; repeated cycles
// nudge by a few minutes so identical timestamps don't pile up.
function slotTime(prefs, platform, index, mondayDate) {
  const sched = prefs.posting_schedule && prefs.posting_schedule[platform];
  const entries = (Array.isArray(sched) && sched.length ? sched : DEFAULT_SCHEDULE)
    .map(parseScheduleEntry)
    .filter(Boolean);
  const list = entries.length ? entries : [{ weekday: 1, hour: 9, minute: 0 }];

  const pick = list[index % list.length];
  const cycle = Math.floor(index / list.length);

  // Day offset from Monday (weekday 1).
  const dayOffset = (pick.weekday - 1 + 7) % 7;
  const d = new Date(mondayDate);
  d.setUTCDate(d.getUTCDate() + dayOffset);

  const minute = (pick.minute + cycle * 7) % 60;
  const hour = pick.hour + Math.floor((pick.minute + cycle * 7) / 60);

  return zonedWallTimeToUtc(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    Math.min(hour, 23), minute,
    prefs.timezone || "America/New_York"
  );
}

// ── Caption generation ──────────────────────────────────────────────────────────

// Generate one platform's caption for a photo. Returns { caption, hashtags, cta }.
async function generateCaption(platform, imageUrl, memorySnapshot) {
  const spec = PLATFORM_SPECS[platform];
  const memoryBlock = memorySnapshot && memorySnapshot.trim()
    ? `\nAbout this agent and their brand (write in this voice):\n${memorySnapshot.trim()}\n`
    : "";

  const systemPrompt = `You are an expert real estate social media copywriter.
Write captions that are confident, specific, and human — no generic filler, no clichés like "stunning" or "breathtaking", and never use emojis.
Return ONLY valid JSON. No markdown, no explanation, just the JSON object.`;

  const userPrompt = `Look at this real estate photo and write ONE ${platform.toUpperCase()} post.
${memoryBlock}
Requirements: max ${spec.maxChars} characters, ${spec.hashtagCount} hashtags. Style: ${spec.style}

Return this exact JSON (no other keys):
{ "caption": "...", "hashtags": "#tag1 #tag2 ...", "cta": "..." }`;

  const resp = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: imageUrl } },
          { type: "text", text: userPrompt },
        ],
      }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Anthropic ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const raw = data.content?.[0]?.text || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI returned non-JSON caption");
  }
  return {
    caption: parsed.caption || "",
    hashtags: parsed.hashtags || "",
    cta: parsed.cta || "",
  };
}

// ── Photo selection (rotation) ──────────────────────────────────────────────────

async function pickPhotos(userId, prefs, count) {
  const where = ["user_id = $1"];
  const params = [userId];

  if (Array.isArray(prefs.photo_orientations) && prefs.photo_orientations.length) {
    params.push(prefs.photo_orientations);
    where.push(`orientation = ANY($${params.length})`);
  }
  if (prefs.photo_min_width > 0) {
    params.push(prefs.photo_min_width);
    where.push(`(width IS NULL OR width >= $${params.length})`);
  }
  if (prefs.photo_min_height > 0) {
    params.push(prefs.photo_min_height);
    where.push(`(height IS NULL OR height >= $${params.length})`);
  }
  if (prefs.photo_recency_days != null) {
    params.push(prefs.photo_recency_days);
    where.push(`created_at >= NOW() - ($${params.length} || ' days')::interval`);
  }
  if (Array.isArray(prefs.include_tags) && prefs.include_tags.length) {
    params.push(prefs.include_tags);
    where.push(`tags && $${params.length}`); // overlaps any included tag
  }
  if (Array.isArray(prefs.exclude_tags) && prefs.exclude_tags.length) {
    params.push(prefs.exclude_tags);
    where.push(`NOT (tags && $${params.length})`);
  }

  // Lowest-used first so photos rotate week to week; random tiebreak avoids
  // always picking the same order among equals.
  const { rows } = await db.query(
    `SELECT id, cloudinary_url
     FROM photo_pool
     WHERE ${where.join(" AND ")}
     ORDER BY used_count ASC, last_used_at ASC NULLS FIRST, random()
     LIMIT $${params.length + 1}`,
    [...params, Math.max(count, 1)]
  );
  return rows;
}

// ── Usage metering ────────────────────────────────────────────────────────────

async function monthlyUsage(userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM usage_events
     WHERE user_id = $1 AND created_at >= date_trunc('month', NOW())`,
    [userId]
  );
  return rows[0]?.n || 0;
}

// ── Notification ────────────────────────────────────────────────────────────────

async function notifyReady(email, count, weekOf) {
  if (!process.env.RESEND_API_KEY || !email) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "Sean Kalman <sean@postkraft.app>",
        reply_to: "sean@postkraft.app",
        to: [email],
        subject: `Your ${count} posts for the week are ready to review`,
        text: `PostKraft generated ${count} draft posts for the week of ${weekOf}.\n\nOpen PostKraft to review, edit, swap photos, and approve them. Nothing posts until you approve it.`,
      }),
    });
  } catch (err) {
    console.error("[batch] notify failed:", err.message);
  }
}

// ── Per-user generation ─────────────────────────────────────────────────────────

async function generateForUser(user, mondayDate) {
  const weekOf = ymdString(mondayDate);

  // Idempotency: claim this (user, week). If a run already exists, skip.
  const claim = await db.query(
    `INSERT INTO batch_runs (user_id, week_of, status)
     VALUES ($1, $2, 'generating')
     ON CONFLICT (user_id, week_of) DO NOTHING
     RETURNING id`,
    [user.id, weekOf]
  );
  if (!claim.rows.length) {
    console.log(`[batch] week ${weekOf} already generated for ${user.id} — skipping`);
    return;
  }
  const batchRunId = claim.rows[0].id;

  const fail = async (msg) => {
    await db.query(`UPDATE batch_runs SET status = 'failed', error = $1 WHERE id = $2`, [msg, batchRunId]);
    console.warn(`[batch] ${user.id}: ${msg}`);
  };

  try {
    // Cost ceiling.
    if (user.monthly_ai_ceiling != null) {
      const used = await monthlyUsage(user.id);
      if (used >= user.monthly_ai_ceiling) {
        return fail(`monthly AI ceiling reached (${used}/${user.monthly_ai_ceiling})`);
      }
    }

    // Platforms to generate for.
    const platforms = (Array.isArray(user.enabled_platforms) ? user.enabled_platforms : [])
      .map((p) => String(p).toLowerCase())
      .filter((p) => KNOWN_PLATFORMS.has(p));
    if (!platforms.length) return fail("no platforms enabled in content prefs");

    const perPlatform = Math.max(1, user.posts_per_platform || 1);
    const totalSlots = platforms.length * perPlatform;

    // Pull enough rotated photos to cover the run (cycle if pool is smaller).
    const photos = await pickPhotos(user.id, user, totalSlots);
    if (!photos.length) return fail("no photos in pool match the configured rules");

    // Build the slot list: each platform × its post count.
    //   TODO(graphics): route round(totalSlots * user.graphic_ratio) of these
    //   to the branded-graphic engine once it exists. For now all are photo posts.
    const slots = [];
    for (const platform of platforms) {
      for (let i = 0; i < perPlatform; i++) slots.push({ platform, indexForPlatform: i });
    }

    let created = 0;
    const usedPhotoIds = new Set();

    for (let s = 0; s < slots.length; s++) {
      const { platform, indexForPlatform } = slots[s];
      const photo = photos[s % photos.length];
      try {
        const cap = await generateCaption(platform, photo.cloudinary_url, user.memory_snapshot);
        const scheduledAt = slotTime(user, platform, indexForPlatform, mondayDate);

        await db.query(
          `INSERT INTO scheduled_posts
             (user_id, platform, caption, hashtags, cta, image_url, scheduled_at, status, origin, batch_run_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'draft','weekly_batch',$8)`,
          [user.id, platform, cap.caption, cap.hashtags, cap.cta, photo.cloudinary_url, scheduledAt, batchRunId]
        );

        await db.query(
          `INSERT INTO usage_events (user_id, kind, units, batch_run_id) VALUES ($1,'caption',1,$2)`,
          [user.id, batchRunId]
        );

        usedPhotoIds.add(photo.id);
        created++;
      } catch (slotErr) {
        // One bad slot shouldn't sink the whole run.
        console.error(`[batch] ${user.id} slot ${s} (${platform}) failed:`, slotErr.message);
      }
    }

    // Bump rotation counters for the photos we actually used.
    if (usedPhotoIds.size) {
      await db.query(
        `UPDATE photo_pool SET used_count = used_count + 1, last_used_at = NOW()
         WHERE id = ANY($1)`,
        [[...usedPhotoIds]]
      );
    }

    if (created === 0) return fail("every slot failed to generate");

    await db.query(
      `UPDATE batch_runs SET status = 'ready', posts_count = $1, error = NULL WHERE id = $2`,
      [created, batchRunId]
    );
    console.log(`[batch] ✓ ${user.id}: ${created} drafts for week ${weekOf}`);
    await notifyReady(user.email, created, weekOf);
  } catch (err) {
    await fail(err.message);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────────

async function runWeeklyBatch() {
  console.log("[batch] Weekly batch run starting");
  let users;
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.subscription_status,
              cp.posts_per_platform, cp.enabled_platforms, cp.posting_schedule, cp.timezone,
              cp.photo_orientations, cp.photo_min_width, cp.photo_min_height, cp.photo_recency_days,
              cp.include_tags, cp.exclude_tags, cp.graphic_ratio, cp.monthly_ai_ceiling, cp.memory_snapshot
       FROM users u
       JOIN content_prefs cp ON cp.user_id = u.id
       WHERE cp.batch_enabled = TRUE
         AND u.subscription_status IN ('active', 'trialing')`
    );
    users = rows;
  } catch (err) {
    console.error("[batch] failed to load users:", err.message);
    return;
  }

  if (!users.length) {
    console.log("[batch] no eligible cloud users — nothing to do");
    return;
  }

  // Each user's target week is the upcoming Monday in their own timezone.
  // Process sequentially to keep AI concurrency (and cost spikes) controlled.
  for (const user of users) {
    const monday = upcomingMonday(user.timezone || "America/New_York");
    try {
      await generateForUser(user, monday);
    } catch (err) {
      console.error(`[batch] unhandled error for ${user.id}:`, err.message);
    }
  }
  console.log(`[batch] Weekly batch run complete (${users.length} user(s))`);
}

module.exports = { runWeeklyBatch, generateCaption };

// Exported for unit testing of the pure scheduling helpers (no side effects).
module.exports._test = {
  zonedWallTimeToUtc, upcomingMonday, parseScheduleEntry, slotTime, ymdString, todayPartsInTz,
};
