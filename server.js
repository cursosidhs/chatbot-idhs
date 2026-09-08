import express from "express";
import { config } from "./src/config.js";
import { generateReply } from "./src/gemini.js";
import {
  parseWebhookEvent,
  isValidSignature,
  sendTextMessage,
  downloadMedia,
} from "./src/whatsapp.js";
import {
  appendBotMessage,
  appendUserMessage,
  attachMedia,
  getHistory,
  markAfterHoursNotified,
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
import { embeddedSignupRouter } from "./src/embeddedSignup.js";

// Sent when Gemini is down after its retries. Deliberately doesn't promise
// that a human will reply *instead* of the bot: the outage is usually brief,
// and the bot should still answer the customer's next message normally.
const FALLBACK_REPLY =
  "Perdón, estoy con un problema técnico para responderte en este momento. " +
  "Tu consulta quedó registrada y una persona del equipo la va a ver.";

// Sent once per session when a message lands outside the bot's response
// window and no employee has taken the conversation. Edit the hours here.
const AFTER_HOURS_REPLY =
  "¡Gracias por escribirnos! Tu consulta quedó registrada y una persona del " +
  "equipo se va a poner en contacto con vos de 10 a 17 hs.";

// Placeholder text stored for a media message that arrived without a caption.
const MEDIA_LABELS = {
  image: "imagen",
  document: "documento",
  audio: "audio",
  video: "video",
  sticker: "sticker",
};

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

  const { from, text, media } = event;

  try {
    const convo = await registerInboundMessage(from);

    // History is read before the new message is stored, so the model gets
    // prior turns as context and the new text as the actual prompt.
    const history = await getHistory(from);

    // Media messages carry no bytes, only an id that expires in 7 days, so
    // the file is fetched now rather than when an employee opens the thread.
    // The stored text is the caption, or a placeholder so the row still reads
    // sensibly in the inbox and in Gemini's history.
    const storedText = text || (media ? `[${MEDIA_LABELS[media.kind] ?? "archivo"}]` : "");
    const messageId = await appendUserMessage(from, storedText, media?.kind ?? null);

    if (media) {
      try {
        const { buffer, mimeType } = await downloadMedia(media.id);
        await attachMedia(messageId, {
          mimeType: media.mimeType || mimeType,
          filename: media.filename,
          buffer,
        });
      } catch (err) {
        // The message row stays either way: the employee needs to know
        // something arrived even when the file itself couldn't be saved.
        console.error("Could not store incoming media:", err.message);
      }
    }

    // An employee already owns this conversation: no automatic message of
    // any kind, including the after-hours notice.
    if (convo.handed_off) return;

    // handed_off is already ruled out above, so a false here means the
    // response window has passed. Tell the customer when someone will get
    // back to them instead of leaving them with silence — but only once per
    // session, so five messages don't produce five identical replies.
    if (!shouldBotRespond(convo)) {
      if (!convo.after_hours_notified) {
        await sendTextMessage(from, AFTER_HOURS_REPLY);
        await appendBotMessage(from, AFTER_HOURS_REPLY);
        await markAfterHoursNotified(from);
      }
      return;
    }

    // Gemini can't see the file, so answering a caption-less photo would be
    // guesswork. Leave it for a human instead of inventing a reply.
    if (media && !text) return;

    // Only fetch/inject the course list when the message looks like it's
    // asking about one — keeps token usage (and Gemini free-tier RPM/TPM
    // budget) down on the messages that don't need it.
    let coursesContext;
    if (looksLikeCourseQuery(text)) {
      const courses = await getCourses();
      coursesContext = formatCoursesForPrompt(courses);
    }

    let reply;
    try {
      reply = await generateReply(history, text, coursesContext);
      console.log("Gemini reply:", reply);
    } catch (err) {
      // Gemini already retried the transient cases and still failed. Saying
      // something beats silence: otherwise the customer has no idea whether
      // the message arrived, and the number no longer has an app where
      // anyone would notice.
      console.error("Gemini unavailable, sending fallback:", err.message);
      reply = FALLBACK_REPLY;
    }

    // Send first, store second: a stored-but-undelivered message would show
    // in /inbox as if the customer had been answered, and the employee would
    // never follow up. The reverse (delivered but unlogged) is recoverable.
    await sendTextMessage(from, reply);
    await appendBotMessage(from, reply);
  } catch (err) {
    console.error("Error handling incoming message:", err);
  }
});

app.use("/inbox", inboxRouter);

// Temporary: only there to evaluate whether Coexistence is reachable for us.
// Remove this mount and src/embeddedSignup.js once that's decided.
app.use("/es-test", embeddedSignupRouter);

app.get("/", (_req, res) => {
  res.send("WhatsApp Gemini bot is running.");
});

// Assert the schema before accepting traffic, so a request never hits a
// missing table on a fresh database.
await initSchema();

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);
});
