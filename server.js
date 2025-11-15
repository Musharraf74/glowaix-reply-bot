import { google } from "googleapis";
import nodemailer from "nodemailer";

// AUTO CHECK MAIL EVERY 15 SECONDS
setInterval(async () => {
  try {
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Fetch unread emails
    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread -from:servicemybusinesss@gmail.com",
    });

    if (!res.data.messages || res.data.messages.length === 0) {
      return;
    }

    for (const msg of res.data.messages) {
      const emailId = msg.id;

      // Fetch email details
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

      // ----- SENDING AUTO REPLY -----
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

      await transporter.sendMail({
        from: "Glowaix Bot <servicemybusinesss@gmail.com>",
        to: senderEmail,
        subject: "Thank you for contacting us!",
        html: "<h3>Your message is received. Our team will reply soon.</h3>",
      });

      // MARK EMAIL AS READ
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
}, 15000); // 15 seconds
