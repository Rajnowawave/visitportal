import dotenv from "dotenv";
import express from "express";
import nodemailer from "nodemailer";
import cors from "cors";
import cron from "node-cron";
import twilio from "twilio";
import ExcelJS from "exceljs";
import { db } from "./firebaseAdmin.js";

dotenv.config();
const app = express();

// -------------------
// Middleware
// -------------------
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://sitevisitportaladinathbuildwell.netlify.app", // ✅ Netlify frontend allowed
    ],
    methods: ["GET", "POST"],
    credentials: true,
  })
);
app.use(express.json());

// -------------------
// Nodemailer setup
// -------------------
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

// -------------------
// Twilio setup
// -------------------
const twilioClient = new twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

// -------------------
// Daily Report Function
// -------------------
const sendDailyReport = async () => {
  try {
    console.log("🔍 Fetching data from Firestore (siteVisits)...");

    const snapshot = await db.collection("siteVisits").get();
    let rows = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      rows.push({
        visitorName: data.visitor?.name || "-",
        contactNumber: data.visitor?.phone || "-",
        visitDate: data.visitAt
          ? new Date(data.visitAt._seconds * 1000).toLocaleDateString("en-IN")
          : "-",
        visitTime: data.visitTime || "-",
        channelPartner: data.channelPartner?.name || "-",
        propertyTypes: Array.isArray(data.propertyTypes) ? data.propertyTypes.join(", ") : "-",
        remark: data.remarks || "-",
        status: data.bookingStatus || "Not Booked",
      });
    });

    console.log("📊 Total site visits found:", rows.length);
    if (rows.length === 0) {
      console.log("⚠️ No visits found. Skipping email + WhatsApp.");
      return;
    }

    // ================= EMAIL TABLE =================
    let htmlTable = `
      <h2>📊 Daily Site Visit Report</h2>
      <table border="1" cellspacing="0" cellpadding="5" style="border-collapse:collapse; width:100%; font-family:Arial, sans-serif;">
        <tr style="background:#2c3e50; color:#fff; text-align:left;">
          <th>S.No</th>
          <th>Visitor Name</th>
          <th>Contact Number</th>
          <th>Visit Date</th>
          <th>Visit Time</th>
          <th>Channel Partner</th>
          <th>Property Types</th>
          <th>Remark</th>
          <th>Status</th>
        </tr>
        ${rows
          .map(
            (r, i) => `
              <tr style="background:${i % 2 === 0 ? "#f8f9fa" : "#ffffff"};">
                <td style="padding:8px;border:1px solid #ddd;text-align:center;">${i + 1}</td>
                <td style="padding:8px;border:1px solid #ddd;">${r.visitorName}</td>
                <td style="padding:8px;border:1px solid #ddd;">${r.contactNumber}</td>
                <td style="padding:8px;border:1px solid #ddd;text-align:center;">${r.visitDate}</td>
                <td style="padding:8px;border:1px solid #ddd;text-align:center;">${r.visitTime}</td>
                <td style="padding:8px;border:1px solid #ddd;">${r.channelPartner}</td>
                <td style="padding:8px;border:1px solid #ddd;">${r.propertyTypes}</td>
                <td style="padding:8px;border:1px solid #ddd;">${r.remark}</td>
                <td style="padding:8px;border:1px solid #ddd;text-align:center;">${r.status}</td>
              </tr>`
          )
          .join("")}
      </table>
    `;

    // ================= EXCEL FILE =================
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Site Visits");

    worksheet.columns = [
      { header: "S.No", key: "sno", width: 6 },
      { header: "Visitor Name", key: "visitorName", width: 20 },
      { header: "Contact Number", key: "contactNumber", width: 15 },
      { header: "Visit Date", key: "visitDate", width: 15 },
      { header: "Visit Time", key: "visitTime", width: 15 },
      { header: "Channel Partner", key: "channelPartner", width: 20 },
      { header: "Property Types", key: "propertyTypes", width: 25 },
      { header: "Remark", key: "remark", width: 30 },
      { header: "Status", key: "status", width: 15 },
    ];

    rows.forEach((r, i) => {
      worksheet.addRow({
        sno: i + 1,
        ...r,
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();

    // ================= SEND EMAIL =================
    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: "rajch54875@gmail.com",
      subject: `Daily Site Visit Report - ${new Date().toLocaleDateString("en-IN")}`,
      html: htmlTable,
      attachments: [
        {
          filename: `Site_Visit_Report_${new Date().toLocaleDateString("en-IN")}.xlsx`,
          content: buffer,
        },
      ],
    });
    console.log("✅ Email sent with Excel:", info.messageId);

    // ================= WHATSAPP MESSAGE =================
    let messages = [];
    rows.forEach((r, i) => {
      messages.push(
        `#${i + 1}\n` +
          `Name     : ${r.visitorName}\n` +
          `Contact  : ${r.contactNumber}\n` +
          `Property : ${r.propertyTypes}\n` +
          `Remark   : ${r.remark}\n` +
          `Status   : ${r.status}`
      );
    });

    const chunkSize = 5; // send 5 records per WhatsApp msg
    for (let i = 0; i < messages.length; i += chunkSize) {
      const chunk = messages.slice(i, i + chunkSize).join("\n\n");
      const textMessage = `📋 Daily Site Visit Report\n\n${chunk}`;

      const waMsg = await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM, // "whatsapp:+14155238886"
        to: "whatsapp:+918290001814", // <-- your number
        body: textMessage,
      });

      console.log("✅ WhatsApp message sent:", waMsg.sid);
    }

    return info;
  } catch (err) {
    console.error("❌ Error sending daily report:", err.message);
    throw err;
  }
};

// -------------------
// Manual trigger API
// -------------------
app.post("/send-report", async (req, res) => {
  try {
    const info = await sendDailyReport();
    res.json({ ok: true, info });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------
// Cron job (daily 10:02 AM IST)
// -------------------
cron.schedule(
  "58 12 * * *",
  () => {
    console.log("⏰ Running daily email + WhatsApp job...");
    sendDailyReport();
  },
  { timezone: "Asia/Kolkata" }
);

// -------------------
// Start server
// -------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
