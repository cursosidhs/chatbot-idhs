import express from "express";
import { config } from "./src/config.js";
import { generateReply } from "./src/gemini.js";
import {
  parseWebhookEvent,
  isValidSignature,
  sendTextMessage,
} from "./src/whatsapp.js";
import {
  appendBotMessage,
  appendUserMessage,
  getHistory,
  markHandedOff,
  registerInboundMessage,
  shouldBotRespond,
} from "./src/conversationStore.js";
import {
  formatCoursesForPrompt,
  getCourses,
  looksLikeCourseQuery,
} from "./src/coursesStore.js";
import { initSchema } from "./src/db.js";
import { inboxRouter } from "./src/inbox.js";

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
    markHandedOff(event.to).catch((err) =>
      console.error("Error marking conversation handed off:", err)
    );
    return;
  }

  const { from, text } = event;

  try {
    const convo = await registerInboundMessage(from);

    // History is read before the new message is stored, so the model gets
    // prior turns as context and the new text as the actual prompt.
    const history = await getHistory(from);
    await appendUserMessage(from, text);

    if (!shouldBotRespond(convo)) return;

    // Only fetch/inject the course list when the message looks like it's
    // asking about one — keeps token usage (and Gemini free-tier RPM/TPM
    // budget) down on the messages that don't need it.
    let coursesContext;
    if (looksLikeCourseQuery(text)) {
      const courses = await getCourses();
      coursesContext = formatCoursesForPrompt(courses);
    }

    const reply = await generateReply(history, text, coursesContext);
    console.log("Gemini reply:", reply);
    await appendBotMessage(from, reply);
    await sendTextMessage(from, reply);
  } catch (err) {
    console.error("Error handling incoming message:", err);
  }
});

app.use("/inbox", inboxRouter);

app.get("/", (_req, res) => {
  res.send("WhatsApp Gemini bot is running.");
});

// Assert the schema before accepting traffic, so a request never hits a
// missing table on a fresh database.
await initSchema();

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});
