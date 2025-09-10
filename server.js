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
      "https://sitevisitportaladinathbuildwell.netlify.app",
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
// Helper function to filter last 24 hours data
// -------------------
const filterLast24Hours = (rows) => {
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
  
  return rows.filter(row => {
    if (!row.visitTimestamp) return false;
    const visitDate = new Date(row.visitTimestamp);
    return visitDate >= twentyFourHoursAgo;
  });
};

// -------------------
// Helper function to sort visits by date (latest first)
// -------------------
const sortVisitsByDate = (visits) => {
  return visits.sort((a, b) => {
    // If both have timestamps, sort by timestamp (latest first)
    if (a.visitTimestamp && b.visitTimestamp) {
      return new Date(b.visitTimestamp) - new Date(a.visitTimestamp);
    }
    
    // If one doesn't have timestamp, put it at the end
    if (!a.visitTimestamp && b.visitTimestamp) return 1;
    if (a.visitTimestamp && !b.visitTimestamp) return -1;
    
    // If both don't have timestamps, try to sort by visitDate string
    if (a.visitDate && b.visitDate) {
      const dateA = new Date(a.visitDate.split('/').reverse().join('-')); // Convert DD/MM/YYYY to YYYY-MM-DD
      const dateB = new Date(b.visitDate.split('/').reverse().join('-'));
      return dateB - dateA; // Latest first
    }
    
    return 0; // Keep original order if can't determine
  });
};

// -------------------
// Helper function to fetch and process Firestore data
// -------------------
const fetchVisitData = async () => {
  console.log("🔍 Fetching data from Firestore...");
  const snapshot = await db.collection("siteVisits").get();
  let rows = [];
  
  snapshot.forEach((doc) => {
    const data = doc.data();
    const visitTimestamp = data.visitAt 
      ? new Date(data.visitAt._seconds * 1000) 
      : null;
    
    rows.push({
      visitorName: data.visitor?.name || "-",
      contactNumber: data.visitor?.phone || "-",
      visitDate: visitTimestamp
        ? visitTimestamp.toLocaleDateString("en-IN")
        : "-",
      visitTime: data.visitTime || "-",
      channelPartner: data.channelPartner?.name || "-",
      propertyTypes: Array.isArray(data.propertyTypes) ? data.propertyTypes.join(", ") : "-",
      remark: data.remarks || "-",
      status: data.bookingStatus || "Not Booked",
      visitTimestamp: visitTimestamp // Keep raw timestamp for filtering and sorting
    });
  });
  
  console.log("📊 Total site visits found:", rows.length);
  
  // Filter for last 24 hours only
  const last24HourVisits = filterLast24Hours(rows);
  console.log("📊 Last 24 hour visits found:", last24HourVisits.length);
  
  // Sort by date (latest first)
  const sortedVisits = sortVisitsByDate(last24HourVisits);
  console.log("📅 Visits sorted by date (latest first)");
  
  return sortedVisits; // Return filtered and sorted data
};

// -------------------
// WhatsApp Message Generator
// -------------------
const generateWhatsAppMessage = (visits) => {
  let message = `📊 *Visit Report (Last 24 Hours)*\n`;
  message += `Generated: ${new Date().toLocaleString('en-IN')}\n`;
  
  visits.forEach((v, i) => {
    message += `*#${i + 1}*\n`;
    message += `Visitor Name: ${v.visitorName}\n`;
    message += `Contact Number: ${v.contactNumber}\n`;
    message += `Visit Date: ${v.visitDate}\n`;
    message += `Visit Time: ${v.visitTime}\n`;
    message += `Channel Partner: ${v.channelPartner}\n`;
    message += `Property Type: ${v.propertyTypes}\n`;
    message += `Remark: ${v.remark}\n`;
    message += `Status: ${v.status}\n`;
    message += `\n`;
  });
  
  message += `📈 *Summary (Last 24 Hours)*\n`;
  message += `Total Visits: ${visits.length}\n`;
  message += `Booked: ${visits.filter(v => v.status === 'Booked').length}\n`;
  message += `Not Booked: ${visits.filter(v => v.status === 'Not Booked').length}\n`;
  message += `Interested: ${visits.filter(v => v.status === 'Interested').length}\n`;
  return message;
};

// -------------------
// Send WhatsApp Function
// -------------------
const sendWhatsAppReport = async (phoneNumber, visits) => {
  try {
    if (visits.length === 0) {
      console.log("ℹ️ No visits in last 24 hours for WhatsApp report");
      
      const noDataMessage = `📊 *Visit Report (Last 24 Hours)*\n` +
        `Generated: ${new Date().toLocaleString('en-IN')}\n\n` +
        `ℹ️ No visits recorded in the last 24 hours.\n\n` +
        `📈 *Summary*\nTotal Recent Visits: 0`;
      
      const formattedNumber = phoneNumber.startsWith('whatsapp:') 
        ? phoneNumber 
        : `whatsapp:${phoneNumber}`;
      
      const waMsg = await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to: formattedNumber,
        body: noDataMessage,
      });
      
      return { success: true, messageId: waMsg.sid, visitsCount: 0 };
    }
    
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
      return { success: true, messageId: waMsg.sid, visitsCount: visits.length };
    } else {
      // Send in chunks
      const chunks = [];
      let currentChunk = `📊 *Visit Report (Last 24 Hours - Part 1)*\n`;
      currentChunk += `Generated: ${new Date().toLocaleString('en-IN')}\n`;
      currentChunk += `📅 *Sorted by Date (Latest First)*\n\n`;
      
      let chunkNumber = 1;
      
      visits.forEach((v, i) => {
        const visitText = 
          `#${i + 1}\n` +
          `Visitor Name: ${v.visitorName}\n` +
          `Contact Number: ${v.contactNumber}\n` +
          `Visit Date: ${v.visitDate}\n` +
          `Visit Time: ${v.visitTime}\n` +
          `Channel Partner: ${v.channelPartner}\n` +
          `Property Type: ${v.propertyTypes}\n` +
          `Remarks: ${v.remark}\n` +
          `Status: ${v.status}\n\n`;
          
        if ((currentChunk + visitText).length > maxLength) {
          chunks.push(currentChunk);
          chunkNumber++;
          currentChunk = `Visit Report (Last 24 Hours - Part ${chunkNumber})\n📅 *Sorted by Date (Latest First)*\n\n`;
        }
        currentChunk += visitText;
      });
      
      currentChunk += `📈 *Summary (Last 24 Hours)*\nTotal: ${visits.length} | Booked: ${visits.filter(v => v.status === 'Booked').length}`;
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
      
      return { success: true, messageIds, visitsCount: visits.length };
    }
  } catch (error) {
    console.error("❌ WhatsApp send error:", error);
    throw error;
  }
};

// -------------------
// Daily Report Function (Both Email & WhatsApp: Last 24 Hours, Date-wise Sorted)
// -------------------
const sendDailyReport = async () => {
  try {
    const last24HourVisits = await fetchVisitData(); // Already filtered and sorted by date
    
    if (last24HourVisits.length === 0) {
      console.log("⚠️ No visits found in last 24 hours. Skipping scheduled reports.");
      return { message: "No visits found in last 24 hours", visitCount: 0 };
    }
    
    // Generate HTML for email (LAST 24 HOURS DATA, DATE-WISE SORTED)
    let htmlTable = `
      <div style="font-family:Arial,sans-serif;max-width:1000px;margin:0 auto;padding:20px;">
        <h2 style="color:#2c3e50;text-align:center;">📊 Site Visit Report (Last 24 Hours)</h2>
        <p style="text-align:center;color:#7f8c8d;">Generated on ${new Date().toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" })}</p>
        <div style="text-align:center;margin:20px 0;padding:10px;background:#e8f4fd;border-radius:5px;">
          <p style="margin:0;color:#2980b9;font-weight:bold;">📅 Showing visits from last 24 hours only (Sorted by Date - Latest First)</p>
        </div>
        <table border="1" cellspacing="0" cellpadding="8" style="border-collapse:collapse; width:100%; font-family:Arial, sans-serif; margin:20px 0;">
          <tr style="background:#2c3e50; color:#fff;">
            <th>S.No</th><th>Visitor Name</th><th>Contact Number</th><th>Visit Date</th><th>Visit Time</th>
            <th>Channel Partner</th><th>Property Types</th><th>Remark</th><th>Status</th>
          </tr>
          ${last24HourVisits.map((r, i) => `
            <tr style="background:${i % 2 === 0 ? "#f8f9fa" : "#ffffff"};">
              <td style="text-align:center;">${i + 1}</td><td>${r.visitorName}</td><td>${r.contactNumber}</td>
              <td style="text-align:center;font-weight:bold;color:#2980b9;">${r.visitDate}</td><td style="text-align:center;">${r.visitTime}</td>
              <td>${r.channelPartner}</td><td>${r.propertyTypes}</td><td>${r.remark}</td>
              <td style="text-align:center;font-weight:bold;">${r.status}</td>
            </tr>
          `).join("")}
        </table>
        <div style="text-align:center;margin-top:20px;padding:15px;background:#f8f9fa;border-radius:5px;">
          <p><strong>Total Visits (Last 24 Hours):</strong> ${last24HourVisits.length}</p>
          <p><strong>Booked:</strong> ${last24HourVisits.filter(v => v.status === 'Booked').length}</p>
          <p><strong>Not Booked:</strong> ${last24HourVisits.filter(v => v.status === 'Not Booked').length}</p>
          <p><strong>Interested:</strong> ${last24HourVisits.filter(v => v.status === 'Interested').length}</p>
          <p style="font-size:12px;color:#7f8c8d;margin-top:10px;">📅 Data sorted by visit date (most recent first)</p>
        </div>
      </div>
    `;
    
    // Create Excel attachment with LAST 24 HOURS DATA, DATE-WISE SORTED
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Last 24 Hours Visits");
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
    
    // Style the note row
    const noteRow = worksheet.getRow(1);
    noteRow.font = { bold: true, color: { argb: 'FF000000' } }; // Black font, bold
    noteRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }; // Yellow background
    noteRow.alignment = {vertical: 'middle' , horizontal: 'center' };
    // Add actual data
    last24HourVisits.forEach((r, i) => {
      worksheet.addRow({ sno: i + 1, ...r });
    });
    
    const buffer = await workbook.xlsx.writeBuffer();
    
    // Send scheduled email with LAST 24 HOURS DATA, DATE-WISE SORTED
    const info = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: "rajch54875@gmail.com",
      subject: `Site Visit Report (Last 24h - Date Sorted) - ${new Date().toLocaleDateString("en-IN")}`,
      html: htmlTable,
      attachments: [
        {
          filename: `Site_Visit_DateSorted_Last24h_${new Date().toLocaleDateString("en-IN").replace(/\//g, '-')}.xlsx`,
          content: buffer,
        },
      ],
    });
    
    console.log("✅ Daily scheduled email sent (LAST 24 HOURS DATA - DATE SORTED):", info.messageId);
    
    // Send WhatsApp with LAST 24 HOURS DATA, DATE-WISE SORTED
    const whatsappResult = await sendWhatsAppReport("+917792097977", last24HourVisits);
    console.log(`📱 WhatsApp sent with ${whatsappResult.visitsCount} visits from last 24 hours (date sorted)`);
    
    return { 
      success: true, 
      info, 
      whatsappResult,
      message: "Daily report sent successfully (last 24 hours, date-wise sorted)", 
      visitCount: last24HourVisits.length
    };
  } catch (err) {
    console.error("❌ Error sending daily report:", err.message);
    throw err;
  }
};

// -------------------
// Manual Report API (Both Email & WhatsApp: Last 24 Hours, Date-wise Sorted)
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
    
    // Filter visits for last 24 hours only
    const last24HourVisits = filterLast24Hours(visits);
    
    // Sort by date (latest first)
    const sortedVisits = sortVisitsByDate(last24HourVisits);
    
    console.log(`📊 Filtered and sorted visits: ${visits.length} total → ${sortedVisits.length} in last 24 hours (date sorted)`);
    
    let results = {};
    
    // Send Email with LAST 24 HOURS DATA, DATE-WISE SORTED
    if (sendMethod === 'email' || sendMethod === 'both') {
      if (!to || !to.trim()) {
        return res.status(400).json({ ok: false, error: "Email recipient is required" });
      }
      
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(to.trim())) {
        return res.status(400).json({ ok: false, error: "Invalid email format" });
      }
      
      console.log(`📧 Sending email with LAST 24 HOURS DATA (DATE SORTED) to: ${to.trim()}`);
      
      // Create filtered HTML content for email with sorting note
      const filteredHtml = html || `
        <div style="font-family:Arial,sans-serif;padding:20px;">
          <h2 style="color:#2c3e50;">📊 Site Visit Report (Last 24 Hours)</h2>
          <p style="color:#7f8c8d;">Generated on ${new Date().toLocaleString("en-IN")}</p>
          <div style="padding:10px;background:#e8f4fd;border-radius:5px;margin:10px 0;">
            <p style="margin:0;color:#2980b9;font-weight:bold;">📅 This report contains only visits from the last 24 hours</p>
            <p style="margin:5px 0 0 0;color:#2980b9;font-weight:bold;">🔄 Data sorted by visit date (most recent first)</p>
          </div>
          <p><strong>Total Visits (Last 24 Hours):</strong> ${sortedVisits.length}</p>
        </div>
      `;
      
      const emailInfo = await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: to.trim(),
        subject: subject || `Site Visit Report (Last 24h - Date Sorted) - ${new Date().toLocaleDateString("en-IN")}`,
        html: filteredHtml,
        attachments: attachments.map(att => ({
          filename: att.filename,
          content: Buffer.from(att.content, att.encoding || 'base64')
        }))
      });
      
      results.email = { 
        success: true, 
        messageId: emailInfo.messageId, 
        dataType: "last_24_hours_date_sorted",
        visitCount: sortedVisits.length
      };
      console.log("✅ Manual email sent with last 24 hours data (date sorted):", emailInfo.messageId);
    }
    
    // Send WhatsApp with LAST 24 HOURS DATA, DATE-WISE SORTED
    if (sendMethod === 'whatsapp' || sendMethod === 'both') {
      if (!whatsappNumber) {
        return res.status(400).json({ ok: false, error: "WhatsApp number is required" });
      }
      
      console.log(`📱 Sending WhatsApp with LAST 24 HOURS data (DATE SORTED) to: ${whatsappNumber}`);
      const whatsappResult = await sendWhatsAppReport(whatsappNumber, sortedVisits);
      results.whatsapp = { ...whatsappResult, dataType: "last_24_hours_date_sorted" };
    }
    
    res.json({ 
      ok: true, 
      message: `Report sent successfully via ${sendMethod} (last 24 hours data, date-wise sorted)`, 
      results,
      totalVisits: visits.length,
      sentVisits: sortedVisits.length,
      note: "Both email and WhatsApp contain only last 24 hours data sorted by date (latest first)"
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
      email: "✅ Ready (Last 24h, Date sorted)",
      whatsapp: "✅ Ready (Last 24h, Date sorted)", 
      firebase: "✅ Connected"
    },
    dataFilter: "Last 24 hours only, sorted by date (latest first)"
  });
});


// -------------------
// Cron job (daily 4:55 PM IST - Both Email & WhatsApp: Last 24h, Date-sorted)
// -------------------
cron.schedule(
  "53 14 * * *",
  () => {
    console.log("⏰ Running daily reports (Email + WhatsApp: Last 24h data, date-sorted)...");
    sendDailyReport();
  },
  { timezone: "Asia/Kolkata" }
);

console.log("⏰ Daily report scheduled - Both Email & WhatsApp: Last 24 hours data, sorted by date");

// -------------------
// Start server
// -------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📧 Email service ready (sends LAST 24 HOURS data, DATE-SORTED)");
  console.log("📱 WhatsApp service ready (sends LAST 24 HOURS data, DATE-SORTED)");
  console.log("🔥 Firebase connected");
  console.log("ℹ️  Both Email & WhatsApp reports: Last 24 hours data only");
  console.log("📅 Data sorting: By visit date (most recent visits appear first)");
});
