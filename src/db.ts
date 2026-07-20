import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export async function getOrCreateLead(chatId: string, phone: string) {
  let lead = await prisma.lead.findUnique({
    where: { chatId },
  });

  if (!lead) {
    lead = await prisma.lead.create({
      data: {
        chatId,
        phone,
        history: "[]",
      },
    });
  }

  return {
    ...lead,
    history: JSON.parse(lead.history) as Message[],
  };
}

export async function updateLeadHistory(chatId: string, history: Message[]) {
  return prisma.lead.update({
    where: { chatId },
    data: {
      history: JSON.stringify(history),
      lastMessageAt: new Date(),
    },
  });
}

export async function getPendingLeads() {
  const leads = await prisma.lead.findMany({
    where: {
      paid: false,
    },
  });

  return leads.map((lead) => ({
    ...lead,
    history: JSON.parse(lead.history) as Message[],
  }));
}

export async function setLeadFollowup(
  chatId: string,
  type: "followup1" | "followup2",
  value: boolean,
) {
  return prisma.lead.update({
    where: { chatId },
    data: {
      [type]: value,
    },
  });
}

export async function markLeadPaidByPhone(phone: string) {
  return prisma.lead.updateMany({
    where: { phone },
    data: { paid: true },
  });
}
