// server.js — COPY/PASTE ENTIRE FILE
import express from "express";
import dotenv from "dotenv";
dotenv.config();
import { google } from "googleapis";
import nodemailer from "nodemailer";
import fetch from "node-fetch";
import OpenAI from "openai";

const app = express();
app.use(express.json());

/* ---------- ENV / CONFIG ---------- */
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const OPENAI_KEY = process.env.OPENAI_KEY;
const AGENCY_NAME = process.env.AGENCY_NAME || "Glowaix";
const SAMPLE_VIDEO_LINK = process.env.SAMPLE_VIDEO_LINK;
const PORTFOLIO_LINK = process.env.PORTFOLIO_LINK;
const INSTAGRAM_LINK = process.env.INSTAGRAM_LINK;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL;
const FINAL_SYSTEM_PROMPT = process.env.FINAL_SYSTEM_PROMPT || "";
const HOLD_FOR_APPROVAL = (process.env.HOLD_FOR_APPROVAL || "true") === "true";
const CONFIDENCE_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || "0.6");

/* ---------- OAuth2 client ---------- */
const REDIRECT_URI = "https://developers.google.com/oauthplayground";
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

/* ---------- OpenAI client ---------- */
const openai = new OpenAI({ apiKey: OPENAI_KEY });

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
  // simple: try parts, fallback to snippet
  try {
    if (!payload) return "";
    if (payload.parts && payload.parts.length) {
      // prefer text/plain
      const part = payload.parts.find((p) => p.mimeType === "text/plain") || payload.parts[0];
      if (part && part.body && part.body.data) {
        return Buffer.from(part.body.data, "base64").toString("utf8");
      }
    } else if (payload.body && payload.body.data) {
      return Buffer.from(payload.body.data, "base64").toString("utf8");
    }
    return "";
  } catch {
    return "";
  }
}

/* ---------- Basic lightweight research (homepage title/meta) ---------- */
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

/* ---------- Build prompt (system + user) ---------- */
function buildAIMessage({ senderEmail, senderName, subject, threadText, researchSummary }) {
  const system = FINAL_SYSTEM_PROMPT || `You are a highly skilled professional email assistant for ${AGENCY_NAME}. Generate a unique, human-sounding, professional reply JSON.`;
  const user = `
Incoming email:
- Sender: ${senderEmail}
- Sender Name: ${senderName || ""}
- Subject: ${subject}
- Thread History: 
${threadText}

Research Summary:
${researchSummary}

Agency info:
- Sample: ${SAMPLE_VIDEO_LINK}
- Portfolio: ${PORTFOLIO_LINK}
- Instagram: ${INSTAGRAM_LINK}
- Contact: ${CONTACT_EMAIL}

Rules: follow the JSON output format exactly. Keep reply_html max 350 words. Use American English.
`;
  return { system, user };
}

/* ---------- Main handler: process a single message object ---------- */
async function processMessage(message) {
  try {
    const msgId = message.id;
    // fetch full message
    const full = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });
    const headers = full.data.payload.headers || [];
    const subject = headers.find((h) => h.name === "Subject")?.value || "";
    const fromHeader = headers.find((h) => h.name === "From")?.value || "";
    const senderEmail = (fromHeader.match(/<(.+?)>/)?.[1]) || fromHeader.split(" ").pop() || "";
    const senderName = fromHeader.split("<")[0].trim();

    // get thread history
    const threadId = full.data.threadId;
    const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    let threadText = "";
    thread.data.messages.forEach((m) => {
      const text = extractPlainTextFromParts(m.payload);
      threadText += text + "\n---\n";
    });

    // lightweight research
    const domain = senderEmail.split("@")[1] || "";
    const researchSummary = await lightResearch(domain);

    // build prompt and call OpenAI
    const { system, user } = buildAIMessage({ senderEmail, senderName, subject, threadText, researchSummary });

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.75,
      max_tokens: 700
    });

    const output = aiResponse.choices?.[0]?.message?.content?.trim() || "";
    // expect JSON output
    let data;
    try {
      data = JSON.parse(output);
    } catch (err) {
      console.log("LLM output not JSON. Saving for manual review.");
      // label for review (optional)
      return;
    }

    // confidence check
    if (!data.confidence || data.confidence < CONFIDENCE_THRESHOLD) {
      console.log("Low confidence:", data.confidence, "→ send to manual review.");
      // label or store for review
      return;
    }

    // Build reply (threaded)
    const replyHtml = data.reply_html.replace(/\[SAMPLE_VIDEO_LINK\]/g, SAMPLE_VIDEO_LINK)
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
      console.log("HOLD_FOR_APPROVAL enabled → Reply generated but NOT sent. Preview below:");
      console.log("TO:", senderEmail);
      console.log("SUBJECT:", data.subject);
      console.log("HTML:", replyHtml);
      // Optionally save to DB or Google Sheet for manual send
      return;
    }

    // Send via Gmail API
    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw
      }
    });

    // mark as read + add label AUTO_REPLIED
    await gmail.users.messages.modify({
      userId: "me",
      id: msgId,
      requestBody: {
        removeLabelIds: ["UNREAD"],
        addLabelIds: ["AUTO_REPLIED"]
      }
    });

    console.log("Auto reply SENT to", senderEmail);
  } catch (err) {
    console.error("processMessage error:", err?.message || err);
  }
}

/* ---------- Poller: check unread emails every 15s and process new ones ---------- */
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
    console.error("Poll error:", err.message || err);
  } finally {
    isProcessing = false;
  }
}

// start poller
setInterval(pollUnread, 15000);

/* ---------- Simple routes ---------- */
app.get("/", (req, res) => res.send("Glowaix Email Bot Server Running!"));
app.get("/watch", (req, res) => res.send("Watch active!"));
// debug route to list all Gmail labels
app.get("/labels", async (req, res) => {
  try {
    const list = await gmail.users.labels.list({ userId: "me" });
    res.json(list.data.labels);
  } catch (err) {
    console.error("Label fetch error:", err.message);
    res.status(500).send("Error fetching labels");
  }

/* ---------- Start server ---------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

