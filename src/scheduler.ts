import cron from "node-cron";
import { sendWaMessage } from "./whatsapp.js";
import { getPendingLeads, setLeadFollowup } from "./db.js";

export function startScheduler() {
  console.log("Scheduler initialized (running every hour)...");

  // Every hour
  cron.schedule("0 * * * *", async () => {
    try {
      console.log("Running scheduled follow-up check...");
      const leads = await getPendingLeads();

      for (const lead of leads) {
        const hours = (Date.now() - lead.lastMessageAt.getTime()) / 3600000;

        if (hours > 24 && !lead.followup1) {
          try {
            await sendWaMessage(
              lead.chatId,
              "Did you finish the 5-minute video? Most students decide after watching the beard section.",
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
              "Quick question: what is the biggest thing stopping you right now — money, time, or confidence?",
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
