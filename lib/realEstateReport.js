/**
 * Daily Nantucket Real Estate Report
 * Runs at 7am ET on Railway — no Mac required.
 *
 * Flow:
 *   1. Auth with Microsoft Graph (client credentials)
 *   2. Find NAREB folder in sean@thekalmanco.com mailbox
 *   3. Pull emails from the last 7 days, including image attachments
 *   4. Pass everything to Claude (multimodal — reads image flyers natively)
 *   5. Send the HTML report via Resend
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const USER_EMAIL = process.env.REPORT_USER_EMAIL || "sean@thekalmanco.com";
const REPORT_TO = process.env.REPORT_TO_EMAIL || "sean@thekalmanco.com";

// ── Microsoft Graph: get access token ────────────────────────────────────────

async function getGraphToken() {
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.AZURE_CLIENT_ID,
        client_secret: process.env.AZURE_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
      }),
    }
  );
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Graph auth failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ── Microsoft Graph: find NAREB folder ───────────────────────────────────────

async function getNAREBFolderId(token) {
  const res = await fetch(
    `${GRAPH_BASE}/users/${USER_EMAIL}/mailFolders?$top=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  const folder = data.value?.find(
    (f) => f.displayName?.toLowerCase() === "nareb"
  );
  if (!folder) throw new Error("NAREB folder not found in Outlook");
  return folder.id;
}

// ── Microsoft Graph: fetch emails from the last 7 days ───────────────────────

async function getNAREBEmails(token, folderId) {
  const since = new Date();
  since.setDate(since.getDate() - 7);
  // Graph API requires ISO 8601 without milliseconds for $filter
  const sinceStr = since.toISOString().replace(/\.\d{3}Z$/, "Z");

  const url =
    `${GRAPH_BASE}/users/${USER_EMAIL}/mailFolders/${folderId}/messages` +
    `?$filter=receivedDateTime ge ${sinceStr}` +
    `&$select=id,subject,body,receivedDateTime,from,hasAttachments` +
    `&$top=50&$orderby=receivedDateTime desc`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.value ?? [];
}

// ── Microsoft Graph: fetch attachments for one message ───────────────────────

async function getAttachments(token, messageId) {
  const res = await fetch(
    `${GRAPH_BASE}/users/${USER_EMAIL}/messages/${messageId}/attachments`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.value ?? [];
}

// ── Build Claude message content (multimodal) ─────────────────────────────────
// Returns an array of Anthropic content blocks (text + image).

async function buildEmailContent(token, emails) {
  const blocks = [];

  for (const email of emails) {
    // Strip HTML tags from body for cleaner text
    const bodyText = (email.body?.content ?? "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000); // cap per email so we don't overflow context

    blocks.push({
      type: "text",
      text:
        `\n\n━━━ EMAIL ━━━\n` +
        `From: ${email.from?.emailAddress?.name ?? ""} <${email.from?.emailAddress?.address ?? ""}>\n` +
        `Subject: ${email.subject}\n` +
        `Received: ${new Date(email.receivedDateTime).toLocaleString("en-US", { timeZone: "America/New_York" })}\n` +
        `Body: ${bodyText || "[no text body]"}`,
    });

    // Pull attachments — images get passed as base64 for multimodal reading
    if (email.hasAttachments) {
      let attachments = [];
      try {
        attachments = await getAttachments(token, email.id);
      } catch (err) {
        blocks.push({ type: "text", text: `[Could not fetch attachments: ${err.message}]` });
      }

      for (const att of attachments) {
        const ct = att.contentType ?? "";

        if (ct.startsWith("image/") && att.contentBytes) {
          // Pass image directly — Claude reads flyers natively
          const mediaType = ct.split(";")[0].trim();
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: mediaType, data: att.contentBytes },
          });
          blocks.push({
            type: "text",
            text: `[Above image: "${att.name}" — attachment from the email above. Read it for address, date, time, price, agent.]`,
          });
        } else if (ct === "application/pdf" && att.contentBytes) {
          // PDFs: decode and include as text if readable, otherwise note it
          blocks.push({
            type: "text",
            text: `[PDF attachment: "${att.name}" — may contain listing details. Extract any visible text from this PDF.]`,
          });
        } else if (ct.startsWith("text/") && att.contentBytes) {
          const decoded = Buffer.from(att.contentBytes, "base64").toString("utf-8").slice(0, 1000);
          blocks.push({ type: "text", text: `[Text attachment "${att.name}"]: ${decoded}` });
        }
        // Skip headshots, logos, etc.
      }
    }
  }

  return blocks;
}

// ── Claude: generate the HTML report ─────────────────────────────────────────

async function generateReport(contentBlocks) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "America/New_York",
  });
  const sevenDaysOut = new Date();
  sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);
  const cutoff = sevenDaysOut.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
    timeZone: "America/New_York",
  });

  const systemPrompt =
    `You are generating a daily real estate intelligence report for Sean Kalman, a Nantucket real estate agent. ` +
    `Today is ${today}. Be precise — copy addresses, prices, times, and agent names exactly as written. ` +
    `For open houses, only include ones scheduled within the next 7 days (through ${cutoff}). ` +
    `De-duplicate: if the same open house appears in multiple emails or images, list it once and cite both agents.`;

  const userPrompt =
    `Here are NAREB emails from the past 7 days, including inline flyer images. ` +
    `Generate a clean HTML email report with these sections:\n\n` +
    `1. **Open Houses (Sale)** — next 7 days only, sorted chronologically. For each: address, date, time, price, listing agent.\n` +
    `2. **Rental Open Houses** — same format plus rental rate.\n` +
    `3. **Price Adjustments & Other Updates** — reductions, new listings, market news.\n\n` +
    `Format requirements:\n` +
    `- Clean HTML with inline styles (no external CSS — this is an email)\n` +
    `- Header with today's date and a count summary (e.g. "5 open houses · 2 rentals · 3 updates")\n` +
    `- Use tables or styled lists; keep it scannable\n` +
    `- If a section is empty, write "None today."\n` +
    `- If a listing is missing details even after checking images, include it and flag the missing field\n\n` +
    `Return ONLY the HTML — no markdown, no explanation.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            ...contentBlocks,
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Claude returned no content");
  return text;
}

// ── Resend: send the report ───────────────────────────────────────────────────

async function sendReport(htmlBody, emailCount) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "America/New_York",
  });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "PostKraft <noreply@postkraft.app>",
      to: [REPORT_TO],
      subject: `Nantucket Real Estate Daily Report — ${today}`,
      html: htmlBody,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend failed: ${err}`);
  }
  return await res.json();
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function runDailyRealEstateReport() {
  console.log("📰 Daily real estate report starting…");

  try {
    // 1. Auth
    const token = await getGraphToken();
    console.log("✅ Microsoft Graph authenticated");

    // 2. Find NAREB folder
    const folderId = await getNAREBFolderId(token);
    console.log("📁 NAREB folder found");

    // 3. Fetch emails
    const emails = await getNAREBEmails(token, folderId);
    console.log(`📧 ${emails.length} emails found in the last 7 days`);

    // 4. Build multimodal content (text + images)
    const contentBlocks = await buildEmailContent(token, emails);
    console.log(`🖼️  Content blocks built (${contentBlocks.length} blocks)`);

    // Handle empty mailbox gracefully
    const emailContent =
      emails.length === 0
        ? [{ type: "text", text: "No emails found in the NAREB folder in the last 7 days." }]
        : contentBlocks;

    // 5. Generate report with Claude
    const htmlReport = await generateReport(emailContent);
    console.log("🤖 Report generated");

    // 6. Send via Resend
    await sendReport(htmlReport, emails.length);
    console.log(`📨 Report sent to ${REPORT_TO}`);

  } catch (err) {
    console.error("❌ Real estate report failed:", err.message);

    // Send a failure notification so you know it broke
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "PostKraft <noreply@postkraft.app>",
          to: [REPORT_TO],
          subject: `⚠️ Real Estate Report Failed — ${new Date().toLocaleDateString()}`,
          html: `<p style="font-family:sans-serif">The daily real estate report failed to run.</p><p><strong>Error:</strong> ${err.message}</p>`,
        }),
      });
    } catch { /* don't let the error notifier crash */ }
  }
}

module.exports = { runDailyRealEstateReport };
