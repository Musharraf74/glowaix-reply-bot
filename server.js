import express from "express";
import nodemailer from "nodemailer";
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// OAuth2 credentials
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const REDIRECT_URI = "https://developers.google.com/oauthplayground";

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

// Home route
app.get("/", (req, res) => {
  res.send("Glowaix Email Bot Server Running!");
});

// Watch test
app.get("/watch", (req, res) => {
  res.send("Watch active!");
});

// ---------- AUTO REPLY EVERY 15 SECONDS ----------
setInterval(async () => {
  try {
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread -from:servicemybusinesss@gmail.com",
    });

    if (!res.data.messages || res.data.messages.length === 0) return;

    for (const msg of res.data.messages) {
      const emailId = msg.id;

      const fullMail = await gmail.users.messages.get({
        userId: "me",
        id: emailId,
      });

      let fromHeader = fullMail.data.payload.headers.find(
        (h) => h.name === "From"
      );

      if (!fromHeader) continue;

      let senderEmail = fromHeader.value.match(/<(.+?)>/);
      senderEmail = senderEmail ? senderEmail[1] : fromHeader.value;

      // Access Token
      const accessTokenObject = await oauth2Client.getAccessToken();
      const accessToken =
        typeof accessTokenObject === "string"
          ? accessTokenObject
          : accessTokenObject?.token;

      // Nodemailer
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

      await transporter.sendMail({
        from: "Glowaix Bot <servicemybusinesss@gmail.com>",
        to: senderEmail,
        subject: "Thank you for contacting us!",
        html: "<h3>Your message is received. Our team will reply soon.</h3>",
      });

      // Mark as read
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
}, 15000);

// Server Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
