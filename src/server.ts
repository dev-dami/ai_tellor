import dotenv from "dotenv";
// Load environment variables first
dotenv.config();

import crypto from "node:crypto";
import express from "express";
import { initializeWhatsApp, onWhatsAppMessage, sendWaMessage, sock } from "./whatsapp.js";
import { generateReply } from "./ai.js";
import { createPaymentLink } from "./paystack.js";
import {
  getOrCreateLead,
  updateLeadHistory,
  markLeadPaidByPhone,
  prisma,
  type Message,
} from "./db.js";
import { startScheduler } from "./scheduler.js";

const app = express();
app.use(express.json());

// Helper for human-like random typing delays (2 to 6 seconds)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendMessageWithDelay(chatId: string, text: string) {
  const ms = Math.floor(Math.random() * 4000) + 2000; // 2000ms - 6000ms
  console.log(`Simulating typing: waiting ${ms}ms before replying to ${chatId}`);
  await delay(ms);
  await sendWaMessage(chatId, text);
}

// Start follow-up check cron jobs
startScheduler();

// WhatsApp Message Handler
onWhatsAppMessage(async (chatId, text) => {
  const cleanText = text.trim();

  // If the message is from a group, ignore
  if (chatId.includes("@g.us")) {
    return;
  }

  console.log(`Received message from ${chatId}: "${cleanText}"`);

  // Trigger command
  if (/^barber$/i.test(cleanText)) {
    // Reset lead state for a new funnel run
    await getOrCreateLead(chatId, chatId);
    await prisma.lead.update({
      where: { chatId },
      data: {
        history: "[]",
        followup1: false,
        followup2: false,
        paid: false,
        lastMessageAt: new Date(),
      },
    });

    await sendMessageWithDelay(
      chatId,
      `👋 Welcome! Here's the 5-minute barber lesson video:\nhttps://youtu.be/your-unlisted-video\n\nWatch it and reply READY when done.`,
    );
    return;
  }

  // Load existing lead or create one
  const lead = await getOrCreateLead(chatId, chatId);

  // If the lead has already paid, do not run the sales funnel
  if (lead.paid) {
    console.log(`Lead ${chatId} has already paid. Skipping sales AI.`);
    return;
  }

  const history = lead.history;

  try {
    const aiReply = await generateReply(history, cleanText);

    // Detect payment intent: FULL PAYMENT
    if (aiReply.includes("PAYMENT_INTENT:FULL")) {
      const reference = crypto.randomUUID();
      const link = await createPaymentLink(`${chatId}@lead.local`, 120000, reference);

      const replyText = `Perfect. Here is the FULL payment link:\n${link}\n\nOnce payment is completed, I'll send your class schedule.`;

      const updatedHistory: Message[] = [
        ...history,
        { role: "user", content: cleanText },
        { role: "assistant", content: "Perfect. Here is the FULL payment link: [link-omitted]" },
      ];
      await updateLeadHistory(chatId, updatedHistory);
      await sendMessageWithDelay(chatId, replyText);
      return;
    }

    // Detect payment intent: DEPOSIT PLAN
    if (aiReply.includes("PAYMENT_INTENT:PLAN")) {
      const reference = crypto.randomUUID();
      const link = await createPaymentLink(`${chatId}@lead.local`, 50000, reference);

      const replyText = `Great choice. Here is the ₦50,000 deposit link:\n${link}\n\nYour seat is reserved immediately after payment.`;

      const updatedHistory: Message[] = [
        ...history,
        { role: "user", content: cleanText },
        {
          role: "assistant",
          content: "Great choice. Here is the ₦50,000 deposit link: [link-omitted]",
        },
      ];
      await updateLeadHistory(chatId, updatedHistory);
      await sendMessageWithDelay(chatId, replyText);
      return;
    }

    // Standard AI conversational flow
    const updatedHistory: Message[] = [
      ...history,
      { role: "user", content: cleanText },
      { role: "assistant", content: aiReply },
    ];

    await updateLeadHistory(chatId, updatedHistory);
    await sendMessageWithDelay(chatId, aiReply);
  } catch (err) {
    console.error(`Error processing message for ${chatId}:`, err);
  }
});

// Paystack Webhook endpoint (with signature verification)
app.post("/webhooks/paystack", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];

  if (!signature) {
    console.warn("Paystack webhook received without signature header.");
    return res.status(400).send("Missing signature header");
  }

  const paystackSecret = process.env.PAYSTACK_SECRET || "";
  const hash = crypto
    .createHmac("sha512", paystackSecret)
    .update(JSON.stringify(req.body))
    .digest("hex");

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
        // Mark as paid in SQLite DB
        await markLeadPaidByPhone(phone);

        // Notify user of successful payment
        await sendWaMessage(
          phone,
          "✅ Payment received successfully!\n\nWelcome to the Barber Academy.\n\nNext steps:\n1. Join the student group\n2. Receive your class schedule\n3. Get your starter clipper guide",
        );
        console.log(`Payment notification sent to ${phone}`);
      } catch (err) {
        console.error(`Error completing payment for ${phone}:`, err);
      }
    }
  }

  res.sendStatus(200);
});

// Basic Health Check endpoint
app.get("/health", (_req, res) => {
  res.json({ status: "ok", whatsapp: sock?.user ? "connected" : "disconnected" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Barber Bot Server running on port ${PORT}`);
});

// Initialize WhatsApp connection asynchronously
initializeWhatsApp().catch((err) => {
  console.error("Failed to initialize WhatsApp connection:", err);
});
