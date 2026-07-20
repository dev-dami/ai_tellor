// src/server.ts
import dotenv from "dotenv";
import crypto from "crypto";
import express from "express";

// src/whatsapp.ts
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
var sock = null;
var onMessageCallback = null;
function onWhatsAppMessage(callback) {
  onMessageCallback = callback;
}
async function sendWaMessage(chatId, text) {
  if (!sock) {
    throw new Error("WhatsApp client is not connected or initialized yet.");
  }
  const jid = chatId.includes("@") ? chatId : `${chatId}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
}
async function initializeWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  console.log("Initializing WhatsApp Baileys socket connection...");
  sock = makeWASocket({
    auth: state,
    // biome-ignore lint/suspicious/noExplicitAny: bypass pino version typings mismatch
    logger: pino({ level: "silent" }),
    printQRInTerminal: false
  });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("\n--- SCAN THIS QR CODE WITH WHATSAPP ---");
      qrcode.generate(qr, { small: true });
      console.log("----------------------------------------\n");
    }
    if (connection === "close") {
      const error = lastDisconnect?.error;
      const statusCode = error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `WhatsApp connection closed: ${error?.message || "unknown error"}. Reconnecting: ${shouldReconnect}`
      );
      if (shouldReconnect) {
        initializeWhatsApp();
      }
    } else if (connection === "open") {
      console.log("WhatsApp client (Baileys) is ready and connected!");
    }
  });
  sock.ev.on("messages.upsert", async (m) => {
    if (m.type === "notify") {
      for (const msg of m.messages) {
        if (msg.key.fromMe) continue;
        const chatId = msg.key.remoteJid;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
        if (chatId && text && onMessageCallback) {
          try {
            await onMessageCallback(chatId, text);
          } catch (err) {
            console.error("Error handling incoming WhatsApp message:", err);
          }
        }
      }
    }
  });
}

// src/ai.ts
import fs from "fs";
import path from "path";
import OpenAI from "openai";
var promptPath = path.resolve(process.cwd(), "src/prompts/barber-sales.txt");
var systemPrompt = fs.readFileSync(promptPath, "utf8");
var client = new OpenAI({
  apiKey: process.env.XIAOMI_API_KEY || "dummy-key",
  baseURL: process.env.XIAOMI_BASE_URL || "https://api.xiaomi.ai/v1"
});
async function generateReply(history, userMessage) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage }
  ];
  try {
    const res = await client.chat.completions.create({
      model: process.env.XIAOMI_MODEL || "mimo-v2.5",
      // biome-ignore lint/suspicious/noExplicitAny: bypass OpenAI SDK version differences
      messages,
      temperature: 0.7
    });
    return res.choices[0].message.content || "I apologize, but I could not generate a reply. Please try again.";
  } catch (error) {
    console.error("Error generating AI reply:", error);
    throw error;
  }
}

// src/paystack.ts
import axios from "axios";
var api = axios.create({
  baseURL: "https://api.paystack.co",
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET || ""}`
  }
});
async function createPaymentLink(email, amount, reference) {
  try {
    const callbackUrl = process.env.CALLBACK_URL || "https://yourdomain.com/payment/success";
    const res = await api.post("/transaction/initialize", {
      email,
      amount: amount * 100,
      // Paystack expects amount in kobo (subunit)
      reference,
      callback_url: callbackUrl
    });
    if (res.data?.status && res.data?.data) {
      return res.data.data.authorization_url;
    }
    throw new Error(res.data?.message || "Failed to initialize transaction");
  } catch (error) {
    const err = error;
    console.error(
      "Error creating Paystack payment link:",
      err.response?.data || err.message || String(error)
    );
    throw error;
  }
}

// src/db.ts
import { PrismaClient } from "@prisma/client";
var prisma = new PrismaClient();
async function getOrCreateLead(chatId, phone) {
  let lead = await prisma.lead.findUnique({
    where: { chatId }
  });
  if (!lead) {
    lead = await prisma.lead.create({
      data: {
        chatId,
        phone,
        history: "[]"
      }
    });
  }
  return {
    ...lead,
    history: JSON.parse(lead.history)
  };
}
async function updateLeadHistory(chatId, history) {
  return prisma.lead.update({
    where: { chatId },
    data: {
      history: JSON.stringify(history),
      lastMessageAt: /* @__PURE__ */ new Date()
    }
  });
}
async function getPendingLeads() {
  const leads = await prisma.lead.findMany({
    where: {
      paid: false
    }
  });
  return leads.map((lead) => ({
    ...lead,
    history: JSON.parse(lead.history)
  }));
}
async function setLeadFollowup(chatId, type, value) {
  return prisma.lead.update({
    where: { chatId },
    data: {
      [type]: value
    }
  });
}
async function markLeadPaidByPhone(phone) {
  return prisma.lead.updateMany({
    where: { phone },
    data: { paid: true }
  });
}

// src/scheduler.ts
import cron from "node-cron";
function startScheduler() {
  console.log("Scheduler initialized (running every hour)...");
  cron.schedule("0 * * * *", async () => {
    try {
      console.log("Running scheduled follow-up check...");
      const leads = await getPendingLeads();
      for (const lead of leads) {
        const hours = (Date.now() - lead.lastMessageAt.getTime()) / 36e5;
        if (hours > 24 && !lead.followup1) {
          try {
            await sendWaMessage(
              lead.chatId,
              "Did you finish the 5-minute video? Most students decide after watching the beard section."
            );
            await setLeadFollowup(lead.chatId, "followup1", true);
            console.log(`Sent follow-up 1 to ${lead.chatId}`);
          } catch (err) {
            console.error(`Error sending follow-up 1 to ${lead.chatId}:`, err);
          }
        } else if (hours > 48 && !lead.followup2) {
          try {
            await sendWaMessage(
              lead.chatId,
              "Quick question: what is the biggest thing stopping you right now \u2014 money, time, or confidence?"
            );
            await setLeadFollowup(lead.chatId, "followup2", true);
            console.log(`Sent follow-up 2 to ${lead.chatId}`);
          } catch (err) {
            console.error(`Error sending follow-up 2 to ${lead.chatId}:`, err);
          }
        }
      }
    } catch (error) {
      console.error("Error running scheduler task:", error);
    }
  });
}

// src/server.ts
dotenv.config();
var app = express();
app.use(express.json());
var delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function sendMessageWithDelay(chatId, text) {
  const ms = Math.floor(Math.random() * 4e3) + 2e3;
  console.log(`Simulating typing: waiting ${ms}ms before replying to ${chatId}`);
  await delay(ms);
  await sendWaMessage(chatId, text);
}
startScheduler();
onWhatsAppMessage(async (chatId, text) => {
  const cleanText = text.trim();
  if (chatId.includes("@g.us")) {
    return;
  }
  console.log(`Received message from ${chatId}: "${cleanText}"`);
  if (/^barber$/i.test(cleanText)) {
    await getOrCreateLead(chatId, chatId);
    await prisma.lead.update({
      where: { chatId },
      data: {
        history: "[]",
        followup1: false,
        followup2: false,
        paid: false,
        lastMessageAt: /* @__PURE__ */ new Date()
      }
    });
    await sendMessageWithDelay(
      chatId,
      `\u{1F44B} Welcome! Here's the 5-minute barber lesson video:
https://youtu.be/your-unlisted-video

Watch it and reply READY when done.`
    );
    return;
  }
  const lead = await getOrCreateLead(chatId, chatId);
  if (lead.paid) {
    console.log(`Lead ${chatId} has already paid. Skipping sales AI.`);
    return;
  }
  const history = lead.history;
  try {
    const aiReply = await generateReply(history, cleanText);
    if (aiReply.includes("PAYMENT_INTENT:FULL")) {
      const reference = crypto.randomUUID();
      const link = await createPaymentLink(`${chatId}@lead.local`, 12e4, reference);
      const replyText = `Perfect. Here is the FULL payment link:
${link}

Once payment is completed, I'll send your class schedule.`;
      const updatedHistory2 = [
        ...history,
        { role: "user", content: cleanText },
        { role: "assistant", content: "Perfect. Here is the FULL payment link: [link-omitted]" }
      ];
      await updateLeadHistory(chatId, updatedHistory2);
      await sendMessageWithDelay(chatId, replyText);
      return;
    }
    if (aiReply.includes("PAYMENT_INTENT:PLAN")) {
      const reference = crypto.randomUUID();
      const link = await createPaymentLink(`${chatId}@lead.local`, 5e4, reference);
      const replyText = `Great choice. Here is the \u20A650,000 deposit link:
${link}

Your seat is reserved immediately after payment.`;
      const updatedHistory2 = [
        ...history,
        { role: "user", content: cleanText },
        {
          role: "assistant",
          content: "Great choice. Here is the \u20A650,000 deposit link: [link-omitted]"
        }
      ];
      await updateLeadHistory(chatId, updatedHistory2);
      await sendMessageWithDelay(chatId, replyText);
      return;
    }
    const updatedHistory = [
      ...history,
      { role: "user", content: cleanText },
      { role: "assistant", content: aiReply }
    ];
    await updateLeadHistory(chatId, updatedHistory);
    await sendMessageWithDelay(chatId, aiReply);
  } catch (err) {
    console.error(`Error processing message for ${chatId}:`, err);
  }
});
app.post("/webhooks/paystack", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  if (!signature) {
    console.warn("Paystack webhook received without signature header.");
    return res.status(400).send("Missing signature header");
  }
  const paystackSecret = process.env.PAYSTACK_SECRET || "";
  const hash = crypto.createHmac("sha512", paystackSecret).update(JSON.stringify(req.body)).digest("hex");
  if (hash !== signature) {
    console.warn("Paystack webhook signature verification failed.");
    return res.status(400).send("Invalid signature");
  }
  const event = req.body;
  if (event.event === "charge.success") {
    const email = event.data.customer.email;
    if (email?.endsWith("@lead.local")) {
      const phone = email.replace("@lead.local", "");
      console.log(`Payment success event received for phone: ${phone}`);
      try {
        await markLeadPaidByPhone(phone);
        await sendWaMessage(
          phone,
          "\u2705 Payment received successfully!\n\nWelcome to the Barber Academy.\n\nNext steps:\n1. Join the student group\n2. Receive your class schedule\n3. Get your starter clipper guide"
        );
        console.log(`Payment notification sent to ${phone}`);
      } catch (err) {
        console.error(`Error completing payment for ${phone}:`, err);
      }
    }
  }
  res.sendStatus(200);
});
app.get("/health", (_req, res) => {
  res.json({ status: "ok", whatsapp: sock?.user ? "connected" : "disconnected" });
});
var PORT = process.env.PORT || 3e3;
app.listen(PORT, () => {
  console.log(`Barber Bot Server running on port ${PORT}`);
});
initializeWhatsApp().catch((err) => {
  console.error("Failed to initialize WhatsApp connection:", err);
});
//# sourceMappingURL=server.js.map