const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireSubscription = require("../middleware/requireSubscription");

const router = express.Router();

// All social posting routes require auth + active subscription
router.use(requireAuth, requireSubscription);

// ─── Helper: get stored token for a platform ──────────────────────────────────
async function getToken(userId, platform) {
  const { rows } = await db.query(
    `SELECT access_token, meta_user_id, meta_page_id, linkedin_urn
     FROM oauth_tokens WHERE user_id = $1 AND platform = $2`,
    [userId, platform]
  );
  if (!rows.length) throw new Error(`${platform} not connected`);
  return rows[0];
}

// ─── Twitter posting ───────────────────────────────────────────────────────────
// Note: Twitter v1.1 media upload requires OAuth 1.0a — not supported with OAuth 2.0 PKCE.
// Posting text-only for now; image support requires OAuth 1.0a app credentials.
async function postToTwitter(userId, text, _imageBase64) {
  const token = await getToken(userId, "twitter");

  const postRes = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!postRes.ok) {
    const errText = await postRes.text();
    throw new Error(`Twitter API error ${postRes.status}: ${errText}`);
  }

  const post = await postRes.json();
  if (post.errors) throw new Error(post.errors[0]?.message || "Tweet failed");
  return { success: true, postId: post.data?.id, platform: "twitter" };
}

// ─── Helper: upload image to Cloudinary and return URL ───────────────────────
// We use Cloudinary as a temporary image host since both Meta and LinkedIn
// require a publicly accessible URL (not base64).
async function uploadImageToCloudinary(base64Data) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary not configured");
  }

  // Strip data URI prefix if present
  const base64 = base64Data.replace(/^data:image\/\w+;base64,/, "");

  const formData = new URLSearchParams();
  formData.append("file", `data:image/jpeg;base64,${base64}`);
  formData.append("upload_preset", "postkraft_posts");

  // Use unsigned upload with a preset, OR signed upload
  const timestamp = Math.floor(Date.now() / 1000);
  const str = `timestamp=${timestamp}${apiSecret}`;

  // Use crypto for HMAC (Node 18+ has built-in)
  const { createHash } = await import("crypto");
  const signature = createHash("sha1")
    .update(`timestamp=${timestamp}${apiSecret}`)
    .digest("hex");

  const body = new URLSearchParams({
    file: `data:image/jpeg;base64,${base64}`,
    api_key: apiKey,
    timestamp: String(timestamp),
    signature,
  });

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: "POST", body }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cloudinary upload failed: ${err}`);
  }

  const data = await res.json();
  return data.secure_url;
}

// ══════════════════════════════════════════════════════════════════════════════
//  POST /social/upload-image
//  Uploads a base64 image to Cloudinary and returns the public URL.
//  Used by the scheduler flow so images are stored before scheduling.
// ══════════════════════════════════════════════════════════════════════════════
router.post("/upload-image", async (req, res, next) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });
    const url = await uploadImageToCloudinary(imageBase64);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  POST /social/post
//  Universal posting endpoint. Body:
//  {
//    platform: "instagram" | "facebook" | "linkedin",
//    caption: string,
//    hashtags: string,   // space-separated "#tag1 #tag2"
//    cta: string,
//    imageBase64: string // base64-encoded image (with or without data URI prefix)
//  }
// ══════════════════════════════════════════════════════════════════════════════
router.post("/post", async (req, res, next) => {
  try {
    const { platform, caption, hashtags, cta, imageBase64, boardId, title, link } = req.body;

    if (!platform || !caption) {
      return res.status(400).json({ error: "platform and caption are required" });
    }

    const fullText = [caption, hashtags, cta].filter(Boolean).join("\n\n");

    switch (platform) {
      case "instagram":
        return res.json(await postToInstagram(req.user.id, fullText, imageBase64));
      case "facebook":
        return res.json(await postToFacebook(req.user.id, fullText, imageBase64));
      case "linkedin":
        return res.json(await postToLinkedIn(req.user.id, fullText, imageBase64));
      case "twitter":
        return res.json(await postToTwitter(req.user.id, fullText, imageBase64));
      case "pinterest":
        if (!imageBase64) return res.status(400).json({ error: "Pinterest requires an image" });
        if (!boardId) return res.status(400).json({ error: "Pinterest requires a boardId" });
        return res.json(await postToPinterest(req.user.id, fullText, imageBase64, boardId, title, link));
      default:
        return res.status(400).json({ error: `Unsupported platform: ${platform}` });
    }
  } catch (err) {
    console.error("Post error:", err.message);
    if (err.message.includes("not connected")) {
      return res.status(403).json({ error: err.message });
    }
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  INSTAGRAM
// ══════════════════════════════════════════════════════════════════════════════
async function postToInstagram(userId, text, imageBase64) {
  const token = await getToken(userId, "meta");

  // 1. Get Instagram Business Account ID linked to the user's pages
  const pagesRes = await fetch(
    `https://graph.facebook.com/v20.0/me/accounts?fields=instagram_business_account,name&access_token=${token.access_token}`
  );
  const pages = await pagesRes.json();
  if (pages.error) throw new Error(pages.error.message);

  const igAccount = pages.data?.find((p) => p.instagram_business_account)?.instagram_business_account;
  if (!igAccount) throw new Error("No Instagram Business Account found. Connect an Instagram Business account to your Facebook Page.");

  // 2. Upload image to get a public URL
  const imageUrl = await uploadImageToCloudinary(imageBase64);

  // 3. Create media container
  const containerRes = await fetch(
    `https://graph.facebook.com/v20.0/${igAccount.id}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: imageUrl,
        caption: text,
        access_token: token.access_token,
      }),
    }
  );
  const container = await containerRes.json();
  if (container.error) throw new Error(container.error.message);

  // 4. Poll until Instagram finishes processing the image (required before publish)
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

  // 5. Publish the container
  const publishRes = await fetch(
    `https://graph.facebook.com/v20.0/${igAccount.id}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id: container.id,
        access_token: token.access_token,
      }),
    }
  );
  const published = await publishRes.json();
  if (published.error) throw new Error(published.error.message);

  return { success: true, postId: published.id, platform: "instagram" };
}

// ══════════════════════════════════════════════════════════════════════════════
//  FACEBOOK
// ══════════════════════════════════════════════════════════════════════════════
async function postToFacebook(userId, text, imageBase64) {
  const token = await getToken(userId, "meta");

  // Get first managed page
  const pagesRes = await fetch(
    `https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token&access_token=${token.access_token}`
  );
  const pages = await pagesRes.json();
  if (pages.error) throw new Error(pages.error.message);
  if (!pages.data?.length) throw new Error("No Facebook Pages found. Create a Facebook Page first.");

  const page = pages.data[0];

  if (imageBase64) {
    // Post with photo
    const imageUrl = await uploadImageToCloudinary(imageBase64);
    const photoRes = await fetch(
      `https://graph.facebook.com/v20.0/${page.id}/photos`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: imageUrl,
          caption: text,
          access_token: page.access_token,
        }),
      }
    );
    const photo = await photoRes.json();
    if (photo.error) throw new Error(photo.error.message);
    return { success: true, postId: photo.post_id || photo.id, platform: "facebook" };
  } else {
    // Text-only post
    const postRes = await fetch(
      `https://graph.facebook.com/v20.0/${page.id}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          access_token: page.access_token,
        }),
      }
    );
    const post = await postRes.json();
    if (post.error) throw new Error(post.error.message);
    return { success: true, postId: post.id, platform: "facebook" };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  LINKEDIN
// ══════════════════════════════════════════════════════════════════════════════
async function postToLinkedIn(userId, text, imageBase64) {
  const token = await getToken(userId, "linkedin");
  const authorUrn = `urn:li:person:${token.linkedin_urn}`;

  if (imageBase64) {
    // 1. Register image upload
    const registerRes = await fetch(
      "https://api.linkedin.com/v2/assets?action=registerUpload",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          registerUploadRequest: {
            recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
            owner: authorUrn,
            serviceRelationships: [
              { relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" },
            ],
          },
        }),
      }
    );
    const registerData = await registerRes.json();
    if (registerData.message) throw new Error(registerData.message);

    const uploadUrl = registerData.value?.uploadMechanism?.["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]?.uploadUrl;
    const asset = registerData.value?.asset;

    if (!uploadUrl || !asset) throw new Error("LinkedIn image registration failed");

    // 2. Upload image bytes
    const base64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64, "base64");

    await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: imageBuffer,
    });

    // 3. Create post with image
    const postRes = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text },
            shareMediaCategory: "IMAGE",
            media: [
              {
                status: "READY",
                description: { text: "" },
                media: asset,
                title: { text: "" },
              },
            ],
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    });
    const post = await postRes.json();
    if (post.message) throw new Error(post.message);
    return { success: true, postId: post.id, platform: "linkedin" };
  } else {
    // Text-only post
    const postRes = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text },
            shareMediaCategory: "NONE",
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    });
    const post = await postRes.json();
    if (post.message) throw new Error(post.message);
    return { success: true, postId: post.id, platform: "linkedin" };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  PINTEREST
//  Creates a Pin on a user-selected board. Requires an image (Pinterest does
//  not allow text-only Pins). The image is uploaded to Cloudinary first to
//  get a public URL, then handed to Pinterest's v5 API as media_source.
// ══════════════════════════════════════════════════════════════════════════════
async function postToPinterest(userId, text, imageBase64, boardId, title, link) {
  const token = await getToken(userId, "pinterest");

  // Pinterest requires a public image URL — host it on Cloudinary first
  const imageUrl = await uploadImageToCloudinary(imageBase64);

  // Pinterest Pin description has a 500-char limit
  const description = text.length > 500 ? text.substring(0, 497) + "..." : text;

  // Title is optional but recommended (100-char limit). If not provided,
  // derive it from the first line of the caption.
  const pinTitle = (title || text.split("\n")[0]).substring(0, 100);

  const body = {
    board_id: boardId,
    title: pinTitle,
    description,
    media_source: {
      source_type: "image_url",
      url: imageUrl,
    },
  };

  // Optional destination link (e.g., back to the listing on thekalmanco.com)
  if (link) body.link = link;

  const postRes = await fetch("https://api.pinterest.com/v5/pins", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!postRes.ok) {
    const errText = await postRes.text();
    throw new Error(`Pinterest API error ${postRes.status}: ${errText}`);
  }

  const pin = await postRes.json();
  return { success: true, postId: pin.id, platform: "pinterest" };
}

module.exports = router;
