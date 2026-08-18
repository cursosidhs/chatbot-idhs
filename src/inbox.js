import crypto from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { sendTextMessage } from "./whatsapp.js";
import {
  appendAgentMessage,
  getConversation,
  listConversations,
} from "./conversationStore.js";

// Meta only lets you send free-form messages within 24h of the customer's
// last message. Past that it needs a pre-approved (paid) template, which
// this inbox doesn't do — so the UI warns instead of silently failing.
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const ROLE_LABELS = {
  user: "Cliente",
  model: "Bot",
  agent: "Empleado",
};

// Hashing first means differing lengths don't throw and don't leak length
// through timing, unlike comparing the raw strings.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAuth(req, res, next) {
  const header = req.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const [user, ...rest] = Buffer.from(encoded, "base64").toString().split(":");
    const password = rest.join(":");
    if (safeEqual(user, config.inboxUser) && safeEqual(password, config.inboxPassword)) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="IDHS inbox"');
  res.status(401).send("Autenticación requerida.");
}

// Every value rendered below can contain attacker-controlled text (a
// customer can put anything in a WhatsApp message), so nothing reaches the
// page without going through this.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(date) {
  return new Date(date).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function layout(title, body) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem;
         max-width: 46rem; margin-inline: auto; line-height: 1.5; }
  h1 { font-size: 1.25rem; }
  a { color: inherit; }
  ul.convos { list-style: none; padding: 0; }
  ul.convos li { border-bottom: 1px solid #8884; }
  ul.convos a { display: block; padding: .75rem .25rem; text-decoration: none; }
  .meta { font-size: .8rem; opacity: .7; }
  .badge { font-size: .7rem; border: 1px solid #8886; border-radius: 999px;
           padding: .05rem .5rem; margin-left: .4rem; }
  .msg { padding: .5rem .75rem; border-radius: .6rem; margin: .4rem 0;
         max-width: 85%; white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg.user  { background: #8882; }
  .msg.model { background: #2f7d5b33; margin-left: auto; }
  .msg.agent { background: #2f5f9e33; margin-left: auto; }
  form { display: flex; gap: .5rem; margin-top: 1rem; }
  textarea { flex: 1; min-height: 3.5rem; font: inherit; padding: .5rem;
             border-radius: .5rem; border: 1px solid #8886; background: transparent;
             color: inherit; }
  button { font: inherit; padding: .5rem 1rem; border-radius: .5rem;
           border: 1px solid #8886; background: #2f7d5b; color: #fff; cursor: pointer; }
  button[disabled] { opacity: .5; cursor: not-allowed; }
  .warn { background: #b4530022; border: 1px solid #b4530066; padding: .6rem .8rem;
          border-radius: .5rem; font-size: .85rem; }
</style>
</head>
<body>${body}</body>
</html>`;
}

export const inboxRouter = express.Router();

inboxRouter.use(requireAuth);
inboxRouter.use(express.urlencoded({ extended: false }));

inboxRouter.get("/", async (_req, res) => {
  const convos = await listConversations();

  const items = convos
    .map((c) => {
      const who = ROLE_LABELS[c.last_role] ?? "";
      const preview = c.last_text ? `${who}: ${c.last_text}` : "(sin mensajes)";
      const badge = c.handed_off ? '<span class="badge">atendido por humano</span>' : "";
      return `<li><a href="/inbox/${encodeURIComponent(c.wa_id)}">
        <strong>${escapeHtml(c.wa_id)}</strong>${badge}
        <div class="meta">${escapeHtml(formatTime(c.last_message_at))}</div>
        <div>${escapeHtml(preview.slice(0, 120))}</div>
      </a></li>`;
    })
    .join("");

  res.send(
    layout(
      "Conversaciones",
      `<h1>Conversaciones</h1>
       ${convos.length ? `<ul class="convos">${items}</ul>` : "<p>Todavía no hay conversaciones.</p>"}`
    )
  );
});

inboxRouter.get("/:waId", async (req, res) => {
  const convo = await getConversation(req.params.waId);
  if (!convo) return res.status(404).send("Conversación no encontrada.");

  const expired = Date.now() - new Date(convo.last_message_at) > SERVICE_WINDOW_MS;

  const messages = convo.messages
    .map(
      (m) => `<div class="msg ${m.role}">
        <div class="meta">${escapeHtml(ROLE_LABELS[m.role] ?? m.role)} · ${escapeHtml(formatTime(m.created_at))}</div>
        ${escapeHtml(m.text)}
      </div>`
    )
    .join("");

  const form = expired
    ? `<p class="warn">Pasaron más de 24 h desde el último mensaje del cliente.
       WhatsApp no permite responder texto libre fuera de esa ventana: haría falta
       una plantilla aprobada (con costo), que este panel todavía no envía.</p>`
    : `<form method="post" action="/inbox/${encodeURIComponent(convo.wa_id)}/reply">
         <textarea name="text" required maxlength="4000" placeholder="Escribí tu respuesta…"></textarea>
         <button type="submit">Enviar</button>
       </form>
       <p class="meta">Al responder, el bot deja de contestar en esta conversación.</p>`;

  res.send(
    layout(
      `Conversación ${convo.wa_id}`,
      `<p><a href="/inbox">← Volver</a></p>
       <h1>${escapeHtml(convo.wa_id)}</h1>
       ${messages}
       ${form}`
    )
  );
});

inboxRouter.post("/:waId/reply", async (req, res) => {
  const waId = req.params.waId;
  const text = (req.body.text ?? "").trim();
  if (!text) return res.redirect(`/inbox/${encodeURIComponent(waId)}`);

  try {
    await sendTextMessage(waId, text);
    await appendAgentMessage(waId, text);
  } catch (err) {
    console.error("Error sending agent reply:", err);
    return res
      .status(502)
      .send(
        layout(
          "Error",
          `<p class="warn">No se pudo enviar el mensaje: ${escapeHtml(err.message)}</p>
           <p><a href="/inbox/${encodeURIComponent(waId)}">← Volver</a></p>`
        )
      );
  }

  res.redirect(`/inbox/${encodeURIComponent(waId)}`);
});
