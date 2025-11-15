import express from "express";
import nodemailer from "nodemailer";
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// OAuth2 Credentials from Render
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

// Watch route for Render
app.get("/watch", (req, res) => {
  console.log("Watch route triggered");
  res.send("Watch active!");
});

// Send Email API
app.post("/send", async (req, res) => {
  const { to, subject, message } = req.body;

  try {
    const accessTokenObject = await oauth2Client.getAccessToken();
    const accessToken =
      typeof accessTokenObject === "string"
        ? accessTokenObject
        : accessTokenObject?.token;

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

    const mailOptions = {
      from: "Glowaix Bot <servicemybusinesss@gmail.com>",
      to,
      subject,
      html: message,
    };

    const result = await transporter.sendMail(mailOptions);
    res.json({ success: true, result });
  } catch (error) {
    console.error("Email error:", error);
    res.status(500).json({ success: false, error });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
