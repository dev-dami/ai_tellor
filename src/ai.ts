import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { Message } from "./db.js";

// Resolve prompt path relative to project root
const promptPath = path.resolve(process.cwd(), "src/prompts/barber-sales.txt");
const systemPrompt = fs.readFileSync(promptPath, "utf8");

const client = new OpenAI({
  apiKey: process.env.XIAOMI_API_KEY || "dummy-key",
  baseURL: process.env.XIAOMI_BASE_URL || "https://api.xiaomi.ai/v1",
});

export async function generateReply(history: Message[], userMessage: string): Promise<string> {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];

  try {
    const res = await client.chat.completions.create({
      model: process.env.XIAOMI_MODEL || "mimo-v2.5",
      // biome-ignore lint/suspicious/noExplicitAny: bypass OpenAI SDK version differences
      messages: messages as any,
      temperature: 0.7,
    });

    return (
      res.choices[0].message.content ||
      "I apologize, but I could not generate a reply. Please try again."
    );
  } catch (error) {
    console.error("Error generating AI reply:", error);
    throw error;
  }
}
