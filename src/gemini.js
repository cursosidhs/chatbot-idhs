import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "./config.js";

const genAI = new GoogleGenerativeAI(config.geminiApiKey);
const model = genAI.getGenerativeModel({
  model: config.geminiModel,
  systemInstruction:
    "Sos un asistente de WhatsApp. Respondé breve, claro y en el mismo idioma que te escriban.",
});

export async function generateReply(history, userText) {
  const chat = model.startChat({
    history: history.map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    })),
  });

  const result = await chat.sendMessage(userText);
  return result.response.text().trim();
}
