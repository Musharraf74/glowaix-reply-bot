import express from "express";
import { google } from "googleapis";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// OAuth Credentials
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);

oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

// HOME ROUTE
app.get("/", (req, res) => {
  res.send("Glowaix Email Bot Server Running!");
});

// WATCH ROUTE
app.get("/watch", (req, res) => {
  res.send("Watch active!");
});

// ---------- AUTO REPLY SYSTEM ----------
async function autoReply() {
  try {
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Fetch unread emails
    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread -from:servicemybusinesss@gmail.com",
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) return;

    for (let msg of messages) {
      const emailId = msg.id;

      // Get email details
      const fullMail = await gmail.users.messages.get({
        userId: "me",
        id: emailId,
      });

      let fromHeader = fullMail.data.payload.headers.find(
        (h) => h.name === "From"
      );
      if (!fromHeader) continue;

      let senderEmail = fromHeader.value.match(/<(.*)>/);
      senderEmail = senderEmail ? senderEmail[1] : fromHeader.value;

      // Generate access token
      const accessTokenObject = await oauth2Client.getAccessToken();
      const accessToken =
        typeof accessTokenObject === "string"
          ? accessTokenObject
          : accessTokenObject?.token;

      // Nodemailer transport
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          type: "OAuth2",
          user: "servicemybusinesss@gmail.com",
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          refreshToken: REFRESH_TOKEN,
          accessToken,
        },
      });

      // Send Auto Reply
      await transporter.sendMail({
        from: "Glowaix Bot <servicemybusinesss@gmail.com>",
        to: senderEmail,
        subject: "Thank you for contacting us!",
        html: "<h3>Your message is received. Our team will reply soon.</h3>",
      });

      // Mark as READ
      await gmail.users.messages.modify({
        userId: "me",
        id: emailId,
        resource: {
          removeLabelIds: ["UNREAD"],
          addLabelIds: ["AUTO_REPLIED"],
        },
      });

      console.log("Auto replied to:", senderEmail);
    }
  } catch (error) {
    console.error("Auto-reply error:", error);
  }
}

// Run autoReply every 15 seconds
setInterval(autoReply, 15000);

// ---------- START SERVER ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
