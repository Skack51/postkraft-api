/**
 * scheduler.js
 * Server-side post scheduler — runs every minute on Railway.
 * Finds pending posts whose scheduled_at has passed and fires them.
 */

const cron = require("node-cron");
const db = require("../db");
const { runDailyRealEstateReport } = require("./realEstateReport");

// ── Reuse posting logic from social routes ─────────────────────────────────────

async function getToken(userId, platform) {
  const { rows } = await db.query(
    `SELECT access_token, meta_user_id, meta_page_id, linkedin_urn
     FROM oauth_tokens WHERE user_id = $1 AND platform = $2`,
    [userId, platform]
  );
  if (!rows.length) throw new Error(`${platform} not connected`);
  return rows[0];
}

async function postToInstagram(userId, text, imageUrl) {
  const token = await getToken(userId, "meta");

  const pagesRes = await fetch(
    `https://graph.facebook.com/v20.0/me/accounts?fields=instagram_business_account,name&access_token=${token.access_token}`
  );
  const pages = await pagesRes.json();
  if (pages.error) throw new Error(pages.error.message);

  const igAccount = pages.data?.find((p) => p.instagram_business_account)?.instagram_business_account;
  if (!igAccount) throw new Error("No Instagram Business Account found");

  const containerRes = await fetch(
    `https://graph.facebook.com/v20.0/${igAccount.id}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: imageUrl, caption: text, access_token: token.access_token }),
    }
  );
  const container = await containerRes.json();
  if (container.error) throw new Error(container.error.message);

  // Poll until FINISHED
  let status = "";
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const statusRes = await fetch(
      `https://graph.facebook.com/v20.0/${container.id}?fields=status_code&access_token=${token.access_token}`
    );
    const statusData = await statusRes.json();
    status = statusData.status_code;
    if (status === "FINISHED") break;
    if (status === "ERROR") throw new Error("Instagram media processing failed");
  }
  if (status !== "FINISHED") throw new Error("Instagram media processing timed out");

  const publishRes = await fetch(
    `https://graph.facebook.com/v20.0/${igAccount.id}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: container.id, access_token: token.access_token }),
    }
  );
  const published = await publishRes.json();
  if (published.error) throw new Error(published.error.message);
  return published.id;
}

async function postToFacebook(userId, text, imageUrl) {
  const token = await getToken(userId, "meta");

  const pagesRes = await fetch(
    `https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token&access_token=${token.access_token}`
  );
  const pages = await pagesRes.json();
  if (pages.error) throw new Error(pages.error.message);
  if (!pages.data?.length) throw new Error("No Facebook Pages found");

  const page = pages.data[0];

  if (imageUrl) {
    const photoRes = await fetch(`https://graph.facebook.com/v20.0/${page.id}/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: imageUrl, caption: text, access_token: page.access_token }),
    });
    const photo = await photoRes.json();
    if (photo.error) throw new Error(photo.error.message);
    return photo.post_id || photo.id;
  } else {
    const postRes = await fetch(`https://graph.facebook.com/v20.0/${page.id}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, access_token: page.access_token }),
    });
    const post = await postRes.json();
    if (post.error) throw new Error(post.error.message);
    return post.id;
  }
}

async function postToLinkedIn(userId, text, imageUrl) {
  const token = await getToken(userId, "linkedin");
  const authorUrn = `urn:li:person:${token.linkedin_urn}`;

  if (imageUrl) {
    // Fetch image from Cloudinary URL and upload as binary
    const imgRes = await fetch(imageUrl);
    const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

    const registerRes = await fetch("https://api.linkedin.com/v2/assets?action=registerUpload", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
          owner: authorUrn,
          serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
        },
      }),
    });
    const registerData = await registerRes.json();
    if (registerData.message) throw new Error(registerData.message);

    const uploadUrl = registerData.value?.uploadMechanism?.["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]?.uploadUrl;
    const asset = registerData.value?.asset;
    if (!uploadUrl || !asset) throw new Error("LinkedIn image registration failed");

    await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: imageBuffer });

    const postRes = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", "X-Restli-Protocol-Version": "2.0.0" },
      body: JSON.stringify({
        author: authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text },
            shareMediaCategory: "IMAGE",
            media: [{ status: "READY", description: { text: "" }, media: asset, title: { text: "" } }],
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    });
    const post = await postRes.json();
    if (post.message) throw new Error(post.message);
    return post.id;
  } else {
    const postRes = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", "X-Restli-Protocol-Version": "2.0.0" },
      body: JSON.stringify({
        author: authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text }, shareMediaCategory: "NONE" } },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    });
    const post = await postRes.json();
    if (post.message) throw new Error(post.message);
    return post.id;
  }
}

async function postToTwitter(userId, text, imageUrl) {
  const token = await getToken(userId, "twitter");

  let mediaId;
  if (imageUrl) {
    // Fetch image and upload to Twitter's media endpoint
    const imgRes = await fetch(imageUrl);
    const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

    const uploadRes = await fetch("https://upload.twitter.com/1.1/media/upload.json", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ media_data: imageBuffer.toString("base64") }),
    });
    const uploadData = await uploadRes.json();
    if (uploadData.errors) throw new Error(uploadData.errors[0]?.message || "Twitter media upload failed");
    mediaId = uploadData.media_id_string;
  }

  const body = { text };
  if (mediaId) body.media = { media_ids: [mediaId] };

  const postRes = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const post = await postRes.json();
  if (post.errors) throw new Error(post.errors[0]?.message || "Tweet failed");
  return post.data?.id;
}

async function postToPinterest(userId, text, imageUrl) {
  const token = await getToken(userId, "pinterest");
  if (!imageUrl) throw new Error("Pinterest requires an image");

  // Get user's first board
  const boardsRes = await fetch("https://api.pinterest.com/v5/boards?page_size=1", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const boards = await boardsRes.json();
  if (!boards.items?.length) throw new Error("No Pinterest boards found — create a board first");
  const boardId = boards.items[0].id;

  const title = text.split("\n")[0].slice(0, 100);
  const description = text.slice(0, 500);

  const pinRes = await fetch("https://api.pinterest.com/v5/pins", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      board_id: boardId,
      title,
      description,
      media_source: { source_type: "image_url", url: imageUrl },
    }),
  });
  const pin = await pinRes.json();
  if (pin.code) throw new Error(pin.message || "Pinterest pin creation failed");
  return pin.id;
}

// ── Fire a single scheduled post ───────────────────────────────────────────────

async function firePost(post) {
  const fullText = [post.caption, post.hashtags, post.cta].filter(Boolean).join("\n\n");

  let postId;
  switch (post.platform) {
    case "instagram":
      postId = await postToInstagram(post.user_id, fullText, post.image_url);
      break;
    case "facebook":
      postId = await postToFacebook(post.user_id, fullText, post.image_url);
      break;
    case "linkedin":
      postId = await postToLinkedIn(post.user_id, fullText, post.image_url);
      break;
    case "twitter":
      postId = await postToTwitter(post.user_id, fullText, post.image_url);
      break;
    case "pinterest":
      postId = await postToPinterest(post.user_id, fullText, post.image_url);
      break;
    default:
      throw new Error(`Unsupported platform: ${post.platform}`);
  }
  return postId;
}

// ── Main tick — runs every minute ─────────────────────────────────────────────

async function tick() {
  let duePosts;
  try {
    const { rows } = await db.query(
      `SELECT * FROM scheduled_posts
       WHERE status = 'pending' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT 20`
    );
    duePosts = rows;
  } catch (err) {
    console.error("[scheduler] DB query failed:", err.message);
    return;
  }

  if (!duePosts.length) return;
  console.log(`[scheduler] Firing ${duePosts.length} scheduled post(s)`);

  for (const post of duePosts) {
    // Mark as in-progress to avoid double-firing
    await db.query(
      `UPDATE scheduled_posts SET status = 'sending' WHERE id = $1 AND status = 'pending'`,
      [post.id]
    );

    try {
      const postId = await firePost(post);
      await db.query(
        `UPDATE scheduled_posts SET status = 'sent', sent_at = NOW(), error = NULL WHERE id = $1`,
        [post.id]
      );
      console.log(`[scheduler] ✓ ${post.platform} post sent (${postId}) for user ${post.user_id}`);
    } catch (err) {
      console.error(`[scheduler] ✗ Failed to post ${post.id}:`, err.message);
      await db.query(
        `UPDATE scheduled_posts SET status = 'failed', error = $1 WHERE id = $2`,
        [err.message, post.id]
      );
    }
  }
}

// ── Start the scheduler ────────────────────────────────────────────────────────

function startScheduler() {
  console.log("[scheduler] Started — checking every minute");
  // Run immediately on start, then every minute
  tick();
  cron.schedule("* * * * *", tick);

  // ── Daily real estate report — 7:00am Eastern ─────────────────────────────
  // Only runs if Azure credentials are configured
  if (process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET) {
    cron.schedule("0 7 * * *", runDailyRealEstateReport, {
      timezone: "America/New_York",
    });
    console.log("[scheduler] Real estate report scheduled — 7:00am ET daily");
  } else {
    console.log("[scheduler] Real estate report skipped — Azure credentials not set");
  }
}

module.exports = { startScheduler };
