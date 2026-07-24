import express from "express";
import { config } from "./src/config.js";
import { generateReply } from "./src/gemini.js";
import {
  parseWebhookEvent,
  isValidSignature,
  sendTextMessage,
} from "./src/whatsapp.js";
import {
  appendTurn,
  getHistory,
  markHandedOff,
  registerInboundMessage,
  shouldBotRespond,
} from "./src/conversationStore.js";

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsappVerifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const signature = req.get("x-hub-signature-256");
  if (!isValidSignature(req.rawBody, signature)) {
    return res.sendStatus(401);
  }

  // Meta expects a fast 200 OK; do the real work after responding.
  res.sendStatus(200);

  const event = parseWebhookEvent(req.body);
  if (!event) return;

  // An employee sent this from the WhatsApp Business app (coexistence).
  // Hand the conversation off to them and never speak in it again this session.
  if (event.type === "echo") {
    markHandedOff(event.to);
    return;
  }

  const { from, text } = event;
  registerInboundMessage(from);

  if (!shouldBotRespond(from)) return;

  try {
    const history = getHistory(from);
    const reply = await generateReply(history, text);
    appendTurn(from, text, reply);
    await sendTextMessage(from, reply);
  } catch (err) {
    console.error("Error handling incoming message:", err);
  }
});

app.get("/", (_req, res) => {
  res.send("WhatsApp Gemini bot is running.");
});

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});
