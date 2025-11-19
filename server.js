// server.js — Generic Chat provider (OpenRouter / Groq / etc.) + Gmail auto-reply
import express from "express";
import dotenv from "dotenv";
dotenv.config();
import { google } from "googleapis";
import fetch from "node-fetch";
import axios from "axios";

const app = express();
app.use(express.json());

/* ---------- ENV / CONFIG ---------- */
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

const AGENCY_NAME = process.env.AGENCY_NAME || "Glowaix";
const SAMPLE_VIDEO_LINK = process.env.SAMPLE_VIDEO_LINK || "";
const PORTFOLIO_LINK = process.env.PORTFOLIO_LINK || "";
const INSTAGRAM_LINK = process.env.INSTAGRAM_LINK || "";
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "";
const FINAL_SYSTEM_PROMPT = process.env.FINAL_SYSTEM_PROMPT || "";
const HOLD_FOR_APPROVAL = (process.env.HOLD_FOR_APPROVAL || "true") === "true";
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || "0.6");

// Provider (OpenRouter / Groq / other) settings — set these in Render env
// PROVIDER_URL: e.g. "https://openrouter.ai/api/v1/chat/completions" or your Groq endpoint
// PROVIDER_KEY: the API key for that provider
// PROVIDER_MODEL: e.g. "deepseek/deepseek-chat" or "gpt-4o-mini-research" or "groq/groq-1"
const PROVIDER_URL = process.env.PROVIDER_URL || "";
const PROVIDER_KEY = process.env.PROVIDER_KEY || "";
const PROVIDER_MODEL = process.env.PROVIDER_MODEL || "gpt-4o-mini-research";

// Gmail label id to add after reply — use the full label id string returned by Gmail list (example: "Label_6545156454014858465")
const AUTO_REPLIED_LABEL_ID = process.env.AUTO_REPLIED_LABEL_ID || "Label_6545156454014858465";

/* ---------- OAuth2 client ---------- */
const REDIRECT_URI = "https://developers.google.com/oauthplayground";
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

/* ---------- Generic Provider Chat Function ---------- */
async function providerChat(system, user) {
  if (!PROVIDER_URL || !PROVIDER_KEY) {
    console.error("Provider URL or KEY not set. Set PROVIDER_URL and PROVIDER_KEY in env.");
    return null;
  }

  try {
    // Generic request body used by many 'chat/completions' endpoints.
    // If your provider needs different fields, update this function.
    const body = {
      model: PROVIDER_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.7,
      max_tokens: 700
    };

    const resp = await axios.post(PROVIDER_URL, body, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PROVIDER_KEY}`
      },
      timeout: 30000
    });

    // Try common response shapes:
    // - openrouter / openai-like: resp.data.choices[0].message.content
    // - some providers: resp.data.output[0].content[0].text etc.
    if (resp?.data?.choices && resp.data.choices[0]?.message?.content) {
      return resp.data.choices[0].message.content;
    }
    if (resp?.data?.choices && typeof resp.data.choices[0]?.text === "string") {
      return resp.data.choices[0].text;
    }
    if (resp?.data?.output && resp.data.output[0]?.content && resp.data.output[0].content[0]?.text) {
      return resp.data.output[0].content[0].text;
    }

    // fallback to whole data as string
    return typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
  } catch (err) {
    console.error("Provider Chat Error:", err.response?.data || err.message || err);
    return null;
  }
}

/* ---------- helper to build raw RFC email ---------- */
function buildRawEmail({ to, from, subject, html, inReplyTo, references }) {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
    references ? `References: ${references}` : "",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
  ].join("\n");

  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/* ---------- extract plain text from message payload ---------- */
function extractPlainTextFromParts(payload) {
  try {
    if (!payload) return "";
    if (payload.parts && payload.parts.length) {
      const part = payload.parts.find((p) => p.mimeType === "text/plain") || payload.parts[0];
      if (part?.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf8");
      }
    } else if (payload.body?.data) {
      return Buffer.from(payload.body.data, "base64").toString("utf8");
    }
    return "";
  } catch {
    return "";
  }
}

/* ---------- lightweight research (homepage title/meta) ---------- */
async function lightResearch(domain) {
  if (!domain || domain.includes("gmail.com")) return "No public website found.";
  try {
    const res = await fetch("https://" + domain, { timeout: 4000 });
    const html = await res.text();
    const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] || "";
    const desc = html.match(/<meta name=["']description["'] content=["']([^"']+)["']/i)?.[1] || "";
    return `${title}${desc ? " — " + desc : ""}`.trim();
  } catch {
    return "No public website found.";
  }
}

/* ---------- Build prompt ---------- */
function buildAIMessage({ senderEmail, senderName, subject, threadText, researchSummary }) {
  const system = FINAL_SYSTEM_PROMPT || `You are a highly skilled professional email assistant for ${AGENCY_NAME}. Generate JSON response.`;

  const user = `
Incoming email:
Sender: ${senderEmail}
Name: ${senderName}
Subject: ${subject}

Thread:
${threadText}

Research:
${researchSummary}

Agency info:
Sample: ${SAMPLE_VIDEO_LINK}
Portfolio: ${PORTFOLIO_LINK}
Instagram: ${INSTAGRAM_LINK}
Contact: ${CONTACT_EMAIL}

Rules:
- Output MUST be ONLY valid JSON. No text before or after the JSON.
- STRICTLY follow this exact structure:

{
  "subject": "string",
  "reply_html": "string",
  "confidence": 1.0
}

- Do NOT include explanations, markdown, comments or extra notes.
- Do NOT add anything outside the JSON object.
- reply_html maximum 350 words.
`;

  return { system, user };
}

/* ---------- MAIN MESSAGE HANDLER ---------- */
async function processMessage(message) {
  try {
    const msgId = message.id;

    const full = await gmail.users.messages.get({
      userId: "me",
      id: msgId,
      format: "full"
    });

    const headers = full.data.payload.headers || [];
    const subject = headers.find(h => h.name === "Subject")?.value || "";
    const fromHeader = headers.find(h => h.name === "From")?.value || "";

    const senderEmail = (fromHeader.match(/<(.+?)>/)?.[1]) || (fromHeader.split(" ").pop() || "");
    const senderName = (fromHeader.split("<")[0] || "").trim();

    const threadId = full.data.threadId;
    const thread = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full"
    });

    let threadText = "";
    for (const m of (thread.data.messages || [])) {
      threadText += extractPlainTextFromParts(m.payload) + "\n---\n";
    }

    const domain = (senderEmail.split("@")[1] || "");
    const researchSummary = await lightResearch(domain);

    const { system, user } = buildAIMessage({
      senderEmail,
      senderName,
      subject,
      threadText,
      researchSummary
    });

    // call provider
    const aiRaw = await providerChat(system, user);
    if (!aiRaw) return;

    // provider might return raw JSON string or plain text — try parse
    let data;
    try {
      data = JSON.parse(typeof aiRaw === "string" ? aiRaw.trim() : aiRaw);
    } catch (err) {
      console.log("Provider output NOT JSON — saved for manual review:", aiRaw);
      return;
    }

    if (!data.confidence || data.confidence < CONFIDENCE_THRESHOLD) {
      console.log("Low-confidence → manual review:", data.confidence);
      return;
    }

    const replyHtml = (data.reply_html || "")
      .replace(/\[SAMPLE_VIDEO_LINK\]/g, SAMPLE_VIDEO_LINK)
      .replace(/\[PORTFOLIO_LINK\]/g, PORTFOLIO_LINK)
      .replace(/\[INSTAGRAM_LINK\]/g, INSTAGRAM_LINK)
      .replace(/\[CONTACT_EMAIL\]/g, CONTACT_EMAIL);

    const raw = buildRawEmail({
      to: senderEmail,
      from: `${AGENCY_NAME} <${CONTACT_EMAIL}>`,
      subject: data.subject || `Re: ${subject}`,
      html: replyHtml,
      inReplyTo: full.data.id,
      references: full.data.id
    });

    if (HOLD_FOR_APPROVAL) {
      console.log("HOLD_FOR_APPROVAL → reply generated (not sent). SUBJECT:", data.subject);
      return;
    }

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw }
    });

    // mark as read + add custom label (use label id, not name)
    await gmail.users.messages.modify({
      userId: "me",
      id: msgId,
      requestBody: {
        removeLabelIds: ["UNREAD"],
        addLabelIds: [AUTO_REPLIED_LABEL_ID]
      }
    });

    console.log("Reply sent to", senderEmail);
  } catch (err) {
    console.error("processMessage error:", err?.response?.data || err?.message || err);
  }
}

/* ---------- POLLER ---------- */
let isProcessing = false;

async function pollUnread() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread -from:" + CONTACT_EMAIL,
      maxResults: 20
    });

    const messages = listRes.data.messages || [];
    for (const m of messages) {
      await processMessage(m);
    }
  } catch (err) {
    console.error("Poll error:", err?.message || err);
  }

  isProcessing = false;
}

// start poller every 15s
setInterval(pollUnread, 15000);

/* ---------- ROUTES ---------- */
app.get("/", (req, res) => res.send("Glowaix Email Bot Running (Generic provider)!"));
app.get("/watch", (req, res) => res.send("Watch active!"));
app.get("/labels", async (req, res) => {
  try {
    const list = await gmail.users.labels.list({ userId: "me" });
    res.json(list.data.labels);
  } catch (err) {
    res.status(500).send("Error fetching labels");
  }
});

/* ---------- START SERVER ---------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
