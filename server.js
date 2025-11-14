import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import nodemailer from "nodemailer";

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===============================
//  SEND REPLY TO BRAND AUTOMATICALLY
// ===============================

app.post("/reply", async (req, res) => {
    const { to, subject, brand, reply } = req.body;

    try {
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL,
                pass: process.env.PASSWORD
            }
        });

        const mailOptions = {
            from: process.env.EMAIL,
            to,
            subject: subject,
            html: reply
        };

        await transporter.sendMail(mailOptions);

        res.json({ success: true, message: "Reply sent!" });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get("/", (req, res) => {
    res.send("GLOWAIX Auto-Reply Bot Running…");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
