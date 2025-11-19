// server.js — DeepSeek via OpenRouter (Unlimited)
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
const SAMPLE_VIDEO_LINK = process.env.SAMPLE_VIDEO_LINK;
const PORTFOLIO_LINK = process.env.PORTFOLIO_LINK;
const INSTAGRAM_LINK = process.env.INSTAGRAM_LINK;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL;
const FINAL_SYSTEM_PROMPT = process.env.FINAL_SYSTEM_PROMPT || "";
const HOLD_FOR_APPROVAL = (process.env.HOLD_FOR_APPROVAL || "true") === "true";
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || "0.6");
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY;

/* ---------- OAuth2 client ---------- */
const REDIRECT_URI = "https://developers.google.com/oauthplayground";
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

/* ---------- DeepSeek Chat via OPENROUTER ---------- */
async function deepseekChat(system, user) {
  try {
    const resp = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "deepseek/deepseek-chat",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.7,
        max_tokens: 700
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${DEEPSEEK_KEY}`,
          "HTTP-Referer": "https://glowaix-email-bot.onrender.com",
          "X-Title": "Glowaix Email Bot"
        }
      }
    );

    return resp.data.choices[0].message.content;
  } catch (err) {
    console.error("DeepSeek Error:", err.response?.data || err.message);
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

/* ---------- extract text ---------- */
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

/* ---------- lightweight research ---------- */
async function lightResearch(domain) {
  if (!domain || domain.includes("gmail.com")) return "No public website found.";
  try {
    const res = await fetch("https://" + domain, { timeout: 4000 });
    const html = await res.text();
    const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] || "";
    const desc = html.match(/<meta name=["']description["'] content=["']([^"']+)/i)?.[1] || "";
    return `${title}${desc ? " — " + desc : ""}`.trim();
  } catch {
    return "No public website found.";
  }
}

/* ---------- Build prompt ---------- */
function buildAIMessage({ senderEmail, senderName, subject, threadText, researchSummary }) {
  const system = FINAL_SYSTEM_PROMPT || 
  `You are a highly skilled professional email assistant for ${AGENCY_NAME}. Generate JSON response.`;

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

    const senderEmail = (fromHeader.match(/<(.+?)>/)?.[1]) || fromHeader.split(" ").pop();
    const senderName = fromHeader.split("<")[0].trim();

    const threadId = full.data.threadId;

    const thread = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full"
    });

    let threadText = "";
    thread.data.messages.forEach(m => {
      threadText += extractPlainTextFromParts(m.payload) + "\n---\n";
    });

    const domain = senderEmail.split("@")[1] || "";
    const researchSummary = await lightResearch(domain);

    const { system, user } = buildAIMessage({
      senderEmail,
      senderName,
      subject,
      threadText,
      researchSummary
    });

    const aiRaw = await deepseekChat(system, user);
    if (!aiRaw) return;

    let data;
    try {
      data = JSON.parse(aiRaw);
    } catch {
      console.log("DeepSeek output NOT JSON");
      return;
    }

    if (!data.confidence || data.confidence < CONFIDENCE_THRESHOLD) {
      console.log("Low-confidence → manual review");
      return;
    }

    const replyHtml = data.reply_html
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
      console.log("HOLD_FOR_APPROVAL → reply NOT sent");
      return;
    }

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw }
    });

    await gmail.users.messages.modify({
      userId: "me",
      id: msgId,
      requestBody: {
        removeLabelIds: ["UNREAD"],
        addLabelIds: ["AUTO_REPLIED"]
      }
    });

    console.log("Reply sent to", senderEmail);

  } catch (err) {
    console.error("processMessage error:", err.message);
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
    for (const m of messages) await processMessage(m);

  } catch (err) {
    console.error("Poll error:", err.message);
  }

  isProcessing = false;
}

setInterval(pollUnread, 15000);

/* ---------- ROUTES ---------- */
app.get("/", (req, res) => res.send("Glowaix Email Bot Running (DeepSeek - OpenRouter)!"));
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
