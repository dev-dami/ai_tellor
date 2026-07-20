import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

let sock: WASocket | null = null;
let onMessageCallback: ((chatId: string, text: string) => Promise<void>) | null = null;

export function onWhatsAppMessage(callback: (chatId: string, text: string) => Promise<void>) {
  onMessageCallback = callback;
}

export async function sendWaMessage(chatId: string, text: string) {
  if (!sock) {
    throw new Error("WhatsApp client is not connected or initialized yet.");
  }
  // Standardize JID to WhatsApp Web format: phone@s.whatsapp.net
  const jid = chatId.includes("@") ? chatId : `${chatId}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
}

export async function initializeWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  console.log("Initializing WhatsApp Baileys socket connection...");

  sock = makeWASocket({
    auth: state,
    // biome-ignore lint/suspicious/noExplicitAny: bypass pino version typings mismatch
    logger: pino({ level: "silent" }) as any,
    printQRInTerminal: false,
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
      const error = lastDisconnect?.error as
        | { output?: { statusCode?: number }; message?: string }
        | undefined;
      const statusCode = error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `WhatsApp connection closed: ${error?.message || "unknown error"}. Reconnecting: ${shouldReconnect}`,
      );

      if (shouldReconnect) {
        // Reinitialize the connection
        initializeWhatsApp();
      }
    } else if (connection === "open") {
      console.log("WhatsApp client (Baileys) is ready and connected!");
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    if (m.type === "notify") {
      for (const msg of m.messages) {
        // Ignore messages sent by the bot itself
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
export { sock };
