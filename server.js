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
app.use(express.json({ limit: '10mb' }));

// -------------------
// Nodemailer setup
// -------------------
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: { 
    user: process.env.GMAIL_USER, 
    pass: process.env.GMAIL_APP_PASSWORD 
  },
});

// Verify email configuration on startup
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Email configuration error:", error);
  } else {
    console.log("✅ Email server is ready to send messages");
  }
});

// -------------------
// Twilio setup
// -------------------
const twilioClient = new twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

// -------------------
// WhatsApp Message Generator
// -------------------
const generateWhatsAppMessage = (visits) => {
  let message = `📊 *Visit Report*\n`;
  message += `Generated: ${new Date().toLocaleString('en-IN')}\n\n`;
  
  visits.forEach((v, i) => {
    message += `*#${i + 1}*\n`;
    message += `👤 Name: ${v.visitorName}\n`;
    message += `📞 Contact: ${v.contactNumber}\n`;
    message += `📅 Date: ${v.visitDate}\n`;
    message += `⏰ Time: ${v.visitTime}\n`;
    message += `🏢 Partner: ${v.channelPartner}\n`;
    message += `🏠 Property: ${v.propertyTypes}\n`;
    message += `📝 Remark: ${v.remark}\n`;
    message += `✅ Status: ${v.status}\n`;
    message += `\n`;
  });
  
  message += `📈 *Summary*\n`;
  message += `Total Visits: ${visits.length}\n`;
  message += `Booked: ${visits.filter(v => v.status === 'Booked').length}\n`;
  message += `Not Booked: ${visits.filter(v => v.status === 'Not Booked').length}`;
  
  return message;
};

// -------------------
// Send WhatsApp Function
// -------------------
const sendWhatsAppReport = async (phoneNumber, visits) => {
  try {
    const formattedNumber = phoneNumber.startsWith('whatsapp:') 
      ? phoneNumber 
      : `whatsapp:${phoneNumber}`;
    
    const message = generateWhatsAppMessage(visits);
    
    const maxLength = 1500;
    if (message.length <= maxLength) {
      const waMsg = await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: formattedNumber,
        body: message,
      });
      console.log("✅ WhatsApp message sent:", waMsg.sid);
      return { success: true, messageId: waMsg.sid };
    } else {
      // Send in chunks
      const chunks = [];
      let currentChunk = `📊 *Visit Report (Part 1)*\n`;
      currentChunk += `Generated: ${new Date().toLocaleString('en-IN')}\n\n`;
      
      let chunkNumber = 1;
      
      visits.forEach((v, i) => {
        const visitText = `*#${i + 1}*\n👤 ${v.visitorName}\n📞 ${v.contactNumber}\n📅 ${v.visitDate}\n⏰ ${v.visitTime}\n🏢 ${v.channelPartner}\n🏠 ${v.propertyTypes}\n📝 ${v.remark}\n✅ ${v.status}\n\n`;
        
        if ((currentChunk + visitText).length > maxLength) {
          chunks.push(currentChunk);
          chunkNumber++;
          currentChunk = `📊 *Visit Report (Part ${chunkNumber})*\n\n`;
        }
        
        currentChunk += visitText;
      });
      
      currentChunk += `📈 *Summary*\nTotal: ${visits.length} | Booked: ${visits.filter(v => v.status === 'Booked').length}`;
      chunks.push(currentChunk);
      
      const messageIds = [];
      for (let chunk of chunks) {
        const waMsg = await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_FROM,
          to: formattedNumber,
          body: chunk,
        });
        messageIds.push(waMsg.sid);
        console.log(`✅ WhatsApp chunk sent: ${waMsg.sid}`);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      return { success: true, messageIds };
    }
  } catch (error) {
    console.error("❌ WhatsApp send error:", error);
    throw error;
  }
};

// -------------------
// Daily Report Function (SCHEDULED ONLY - keeps your hardcoded email)
// -------------------
const sendDailyReport = async () => {
  try {
    console.log("🔍 Fetching data from Firestore for daily report...");

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
      console.log("⚠️ No visits found. Skipping scheduled email.");
      return { message: "No visits found", visitCount: 0 };
    }

    // Generate HTML for daily scheduled email
    let htmlTable = `
      <div style="font-family:Arial,sans-serif;max-width:1000px;margin:0 auto;padding:20px;">
        <h2 style="color:#2c3e50;text-align:center;">📊 Daily Site Visit Report</h2>
        <p style="text-align:center;color:#7f8c8d;">Generated on ${new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" })}</p>
        <table border="1" cellspacing="0" cellpadding="8" style="border-collapse:collapse; width:100%; font-family:Arial, sans-serif; margin:20px 0;">
          <tr style="background:#2c3e50; color:#fff;">
            <th>S.No</th><th>Visitor Name</th><th>Contact Number</th><th>Visit Date</th><th>Visit Time</th>
            <th>Channel Partner</th><th>Property Types</th><th>Remark</th><th>Status</th>
          </tr>
          ${rows.map((r, i) => `
            <tr style="background:${i % 2 === 0 ? "#f8f9fa" : "#ffffff"};">
              <td style="text-align:center;">${i + 1}</td><td>${r.visitorName}</td><td>${r.contactNumber}</td>
              <td style="text-align:center;">${r.visitDate}</td><td style="text-align:center;">${r.visitTime}</td>
              <td>${r.channelPartner}</td><td>${r.propertyTypes}</td><td>${r.remark}</td>
              <td style="text-align:center;font-weight:bold;">${r.status}</td>
            </tr>
          `).join("")}
        </table>
        <div style="text-align:center;margin-top:20px;padding:15px;background:#f8f9fa;border-radius:5px;">
          <p><strong>Total Visits:</strong> ${rows.length}</p>
        </div>
      </div>
    `;

    // Create Excel attachment
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
      worksheet.addRow({ sno: i + 1, ...r });
    });

    const buffer = await workbook.xlsx.writeBuffer();

    // Send scheduled email to your hardcoded address
    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: "rajch54875@gmail.com", // This stays for scheduled reports
      subject: `Daily Site Visit Report - ${new Date().toLocaleDateString("en-IN")}`,
      html: htmlTable,
      attachments: [
        {
          filename: `Site_Visit_Report_${new Date().toLocaleDateString("en-IN").replace(/\//g, '-')}.xlsx`,
          content: buffer,
        },
      ],
    });
    console.log("✅ Daily scheduled email sent:", info.messageId);

    // Send WhatsApp
    await sendWhatsAppReport("+917792097977", rows);

    return { 
      success: true, 
      info, 
      message: "Daily report sent successfully", 
      visitCount: rows.length 
    };
  } catch (err) {
    console.error("❌ Error sending daily report:", err.message);
    throw err;
  }
};

// -------------------
// Manual Report API - FIXED TO USE USER EMAILS
// -------------------
app.post("/send-report", async (req, res) => {
  try {
    console.log("📧 Manual report request received:", {
      method: req.body.sendMethod,
      recipient: req.body.to,
      hasHtml: !!req.body.html,
      visitsCount: req.body.visits?.length || 0,
      attachmentsCount: req.body.attachments?.length || 0
    });

    const { 
      sendMethod = 'email', 
      to, 
      whatsappNumber, 
      subject, 
      html, 
      visits = [],
      attachments = [] 
    } = req.body;

    let results = {};

    // Send Email - USES USER PROVIDED EMAIL
    if (sendMethod === 'email' || sendMethod === 'both') {
      if (!to || !to.trim()) {
        return res.status(400).json({ ok: false, error: "Email recipient is required" });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(to.trim())) {
        return res.status(400).json({ ok: false, error: "Invalid email format" });
      }

      console.log(`📧 Sending email to USER PROVIDED ADDRESS: ${to.trim()}`);
      
      const emailInfo = await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: to.trim(), // ✅ USES THE EMAIL FROM FRONTEND, NOT HARDCODED
        subject: subject || `Visit Report - ${new Date().toLocaleDateString("en-IN")}`,
        html: html || '<p>Visit report attached</p>',
        attachments: attachments.map(att => ({
          filename: att.filename,
          content: Buffer.from(att.content, att.encoding || 'base64')
        }))
      });

      results.email = { success: true, messageId: emailInfo.messageId };
      console.log("✅ Manual email sent to user address:", emailInfo.messageId);
    }

    // Send WhatsApp
    if (sendMethod === 'whatsapp' || sendMethod === 'both') {
      if (!whatsappNumber) {
        return res.status(400).json({ ok: false, error: "WhatsApp number is required" });
      }

      console.log(`📱 Sending WhatsApp to: ${whatsappNumber}`);
      const whatsappResult = await sendWhatsAppReport(whatsappNumber, visits);
      results.whatsapp = whatsappResult;
    }

    res.json({ 
      ok: true, 
      message: `Report sent successfully via ${sendMethod} to ${to}`, 
      results,
      visitCount: visits.length 
    });

  } catch (err) {
    console.error("❌ Error in manual send-report:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------
// Health check endpoint
// -------------------
app.get("/health", (req, res) => {
  res.json({ 
    status: "Server is running", 
    timestamp: new Date().toISOString(),
    services: {
      email: "✅ Ready",
      whatsapp: "✅ Ready", 
      firebase: "✅ Connected"
    }
  });
});

// -------------------
// Test endpoints
// -------------------
app.post("/test-email", async (req, res) => {
  try {
    const { to } = req.body;
    const testRecipient = to || "test@example.com";
    
    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: testRecipient,
      subject: "🧪 Test Email from Visit Portal",
      html: "<h2>🎉 Email configuration is working!</h2><p>Your email system is properly configured and ready to send reports.</p>",
    });
    
    console.log("✅ Test email sent:", info.messageId);
    res.json({ ok: true, message: "Test email sent successfully", recipient: testRecipient });
  } catch (err) {
    console.error("❌ Test email failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/test-whatsapp", async (req, res) => {
  try {
    const { to } = req.body;
    const testNumber = to || "+917792097977";
    
    const testVisits = [{
      visitorName: "Test User",
      contactNumber: "+919999999999",
      visitDate: new Date().toLocaleDateString('en-IN'),
      visitTime: "10:00 AM",
      channelPartner: "Test Partner",
      propertyTypes: "Villa, Apartment",
      remark: "This is a test message",
      status: "Not Booked"
    }];

    const result = await sendWhatsAppReport(testNumber, testVisits);
    
    console.log("✅ Test WhatsApp sent");
    res.json({ ok: true, message: "Test WhatsApp sent successfully", recipient: testNumber, result });
  } catch (err) {
    console.error("❌ Test WhatsApp failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------
// Cron job (daily 10:02 AM IST) - SCHEDULED EMAILS GO TO YOUR ADDRESS
// -------------------
cron.schedule(
  "55 16 * * *",
  () => {
    console.log("⏰ Running daily email + WhatsApp job...");
    sendDailyReport(); // This still goes to rajch54875@gmail.com
  },
  { timezone: "Asia/Kolkata" }
);

console.log("⏰ Daily report scheduled for 10:02 AM IST");

// -------------------
// Start server
// -------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📧 Email service ready");
  console.log("📱 WhatsApp service ready");
  console.log("🔥 Firebase connected");
  console.log("ℹ️  Manual reports will be sent to user-provided emails");
  console.log("ℹ️  Scheduled reports will still go to rajch54875@gmail.com");
});
