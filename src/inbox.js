import crypto from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { sendTextMessage, sendTemplateMessage } from "./whatsapp.js";
import {
  appendAgentMessage,
  getConversation,
  getMedia,
  isOptedOut,
  listConversations,
  logOutboundContact,
  registerOutboundContact,
  setOptedOut,
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

// Agent messages show who sent them; everything older than multi-user
// support (author IS NULL) still reads as the generic "Empleado".
function authorLabel(role, author) {
  if (role === "agent" && author) return author;
  return ROLE_LABELS[role] ?? role;
}

// A customer controls the mime type of anything they send. Rendering an
// attacker-supplied text/html inline, on our own origin, would be stored XSS
// with the employee's session — so only these types are ever served inline,
// and everything else is forced to download as an opaque binary.
const INLINE_SAFE = [/^image\//, /^audio\//, /^video\//, /^application\/pdf$/];

function isInlineSafe(mimeType) {
  return INLINE_SAFE.some((pattern) => pattern.test(mimeType));
}

// Quotes, newlines and non-ASCII would let a filename break out of the
// Content-Disposition header, so the fallback keeps only tame characters.
function safeFilename(filename, fallback) {
  const cleaned = String(filename ?? "").replace(/[^\w.\- ]+/g, "").trim();
  return cleaned || fallback;
}

// Hashing first means differing lengths don't throw and don't leak length
// through timing, unlike comparing the raw strings.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function requireAuth(req, res, next) {
  const header = req.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const [user, ...rest] = Buffer.from(encoded, "base64").toString().split(":");
    const password = rest.join(":");

    // Checks every configured user without breaking out early, so how long
    // this takes doesn't reveal which names exist.
    let matched = null;
    for (const candidate of config.inboxUsers) {
      const hit = safeEqual(user, candidate.name) && safeEqual(password, candidate.password);
      if (hit) matched = candidate;
    }

    if (matched) {
      req.inboxAuthor = matched.name;
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

// Escapes '<' so a message containing a literal "</script>" can't close the
// <script> tag early and inject markup — JSON.stringify alone doesn't guard
// against that, since message text is attacker-controlled (a customer's
// WhatsApp message).
function toScriptSafeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Renders the permission toggle ("Activar notificaciones" / blocked /
// active) plus, on the conversations list, the check that fires a browser
// Notification for any conversation whose last_message_at moved forward.
// last_message_at only advances on an inbound customer message — never on
// a bot or agent reply, see conversationStore.js — so comparing it against
// what we saw on the previous load is exactly "is there an unread message
// from a customer", no extra role check needed.
//
// State lives in localStorage, not a JS variable, because the page does a
// full reload on every poll (autoRefreshScript) — there is no long-lived
// script context to hold it in. `convos` is omitted on pages other than the
// list (e.g. a single conversation thread), which still renders the toggle
// but skips the check.
function notificationScript(convos) {
  const data = convos
    ? toScriptSafeJson(
        convos.map((c) => ({
          waId: c.wa_id,
          lastMessageAt: c.last_message_at,
          preview: (c.last_text || "").slice(0, 120),
        }))
      )
    : "null";

  return `
<span id="notif-status" class="meta"></span>
<script>
(function () {
  var el = document.getElementById("notif-status");
  if (!el || !("Notification" in window)) return;

  function renderToggle() {
    el.innerHTML = "";
    if (Notification.permission === "granted") {
      el.textContent = "🔔 Notificaciones activas";
    } else if (Notification.permission === "denied") {
      el.textContent = "🔕 Notificaciones bloqueadas por el navegador";
    } else {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-sm";
      btn.textContent = "🔔 Activar notificaciones";
      btn.onclick = function () { Notification.requestPermission().then(renderToggle); };
      el.appendChild(btn);
    }
  }
  renderToggle();

  var convos = ${data};
  if (!convos) return;

  // Baseline tracking runs on every load regardless of permission state —
  // otherwise the first load where permission happens to be "granted"
  // always looks like firstRun (localStorage was never written while
  // permission was still "default"), and silently swallows the very first
  // new message instead of notifying about it.
  var STORAGE_KEY = "inboxSeenAt";
  var seen;
  try { seen = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch (e) { seen = {}; }

  // Empty storage means this is the first load ever (or it got cleared) —
  // record a baseline instead of notifying about the whole conversation
  // history at once.
  var firstRun = Object.keys(seen).length === 0;
  var canNotify = Notification.permission === "granted";

  convos.forEach(function (c) {
    var prev = seen[c.waId];
    var isNew = !firstRun && (!prev || new Date(c.lastMessageAt) > new Date(prev));
    if (isNew && canNotify) {
      var n = new Notification("Nuevo mensaje de " + c.waId, {
        body: c.preview || "(sin texto)",
        tag: "inbox-" + c.waId,
        renotify: true,
      });
      n.onclick = function () {
        window.focus();
        location.href = "/inbox/" + encodeURIComponent(c.waId);
      };
    }
    seen[c.waId] = c.lastMessageAt;
  });

  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(seen)); } catch (e) {}
})();
</script>`;
}

// Without an explicit timeZone, toLocaleString uses the process's local
// zone — on Render that's UTC, not Buenos Aires, so every timestamp in the
// inbox was three hours ahead of the real time (this was a real bug, not
// hypothetical: caught because a reply logged at "15:32" landed while the
// clock read 12:44 local). Pinned explicitly rather than relying on the
// host's TZ setting, since that's infrastructure config, not app config.
function formatTime(date) {
  return new Date(date).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Polls by reloading the page, but never at the cost of losing work:
// a half-written reply, or a hidden tab (a background tab reloading every
// 30s would hold Render's free instance awake — and its 750 h/month
// budget — for nothing). Deliberately not <meta http-equiv="refresh">,
// which can't be conditional and would wipe a draft mid-sentence.
const autoRefreshScript = `
<script>
(function () {
  var everyMs = ${Number(config.inboxRefreshSeconds) * 1000};
  if (!everyMs) return;

  function shouldSkip() {
    if (document.hidden) return true;
    // Never reload out from under someone mid-typing: a half-written reply,
    // or a search box being used (reloading would drop what they typed and
    // bounce them back to the unfiltered list).
    var fields = document.querySelectorAll("textarea, input[type=search]");
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].value.trim() !== "" || document.activeElement === fields[i]) return true;
    }
    return false;
  }

  setInterval(function () {
    if (!shouldSkip()) location.reload();
  }, everyMs);
})();
</script>`;

function layout(title, body) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #FAFEFF;
    --text: #000000;
    --muted: rgba(0, 0, 0, .62);
    --border: rgba(0, 0, 0, .14);
    --surface: rgba(0, 0, 0, .04);
    --primary: #362DFF;          /* acción principal / empleado */
    --primary-contrast: #FAFEFF;
    --secondary: #717CFC;        /* bot */
    --bot-bg: rgba(113, 124, 252, .14);
    --bot-border: #717CFC;
    --agent-bg: rgba(54, 45, 255, .10);
    --agent-border: #362DFF;
    --warn-bg: #b4530022;
    --warn-border: #b4530066;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000000;
      --text: #FAFEFF;
      --muted: rgba(250, 254, 255, .65);
      --border: rgba(250, 254, 255, .18);
      --surface: rgba(250, 254, 255, .07);
      --primary: #717CFC;        /* más visible que #362DFF sobre negro */
      --primary-contrast: #000000;
      --bot-bg: rgba(113, 124, 252, .20);
      --agent-bg: rgba(54, 45, 255, .38);
      --agent-border: #717CFC;
    }
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem;
         max-width: 46rem; margin-inline: auto; line-height: 1.5;
         background: var(--bg); color: var(--text); }
  h1 { font-size: 1.25rem; color: var(--text); }
  a { color: var(--primary); }
  ul.convos { list-style: none; padding: 0; }
  ul.convos li { border-bottom: 1px solid var(--border);
                 border-left: 4px solid transparent; border-radius: .3rem;
                 transition: background .15s; }
  ul.convos li.convo-bot   { border-left-color: var(--bot-border); background: var(--bot-bg); }
  ul.convos li.convo-agent { border-left-color: var(--agent-border); background: var(--agent-bg); }
  ul.convos a { display: block; padding: .75rem .6rem; text-decoration: none; color: var(--text); }
  .meta { font-size: .8rem; color: var(--muted); }
  .badge { font-size: .7rem; font-weight: 600; border-radius: 999px;
           padding: .1rem .55rem; margin-left: .4rem; white-space: nowrap;
           display: inline-block; }
  .badge-bot { background: var(--bot-bg); color: var(--secondary); border: 1px solid var(--bot-border); }
  .badge-agent { background: var(--agent-border); color: var(--primary-contrast); }
  .badge-warn { background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--text); }
  .msg { padding: .5rem .75rem; border-radius: .6rem; margin: .4rem 0;
         max-width: 85%; white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg.user  { background: var(--surface); }
  .msg.model { background: var(--bot-bg); border: 1px solid var(--bot-border); margin-left: auto; }
  .msg.agent { background: var(--agent-bg); border: 1px solid var(--agent-border); margin-left: auto; }
  form { display: flex; gap: .5rem; margin-top: 1rem; }
  form.search { margin: .5rem 0 1rem; align-items: center; flex-wrap: wrap; }
  input[type="search"] { flex: 1; min-width: 10rem; font: inherit; padding: .5rem;
             border-radius: .5rem; border: 1px solid var(--border); background: transparent;
             color: var(--text); }
  .clear { font-size: .85rem; color: var(--muted); }
  textarea { flex: 1; min-height: 3.5rem; font: inherit; padding: .5rem;
             border-radius: .5rem; border: 1px solid var(--border); background: transparent;
             color: var(--text); }
  button { font: inherit; padding: .5rem 1rem; border-radius: .5rem;
           border: none; background: var(--primary); color: var(--primary-contrast);
           cursor: pointer; }
  button:hover { opacity: .88; }
  button[disabled] { opacity: .5; cursor: not-allowed; }
  .warn { background: var(--warn-bg); border: 1px solid var(--warn-border); padding: .6rem .8rem;
          border-radius: .5rem; font-size: .85rem; color: var(--text); }
  form.newcontact { flex-direction: column; align-items: stretch; max-width: 26rem; }
  form.newcontact label { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; }
  form.newcontact input[type="text"] { font: inherit; padding: .5rem; border-radius: .5rem;
             border: 1px solid var(--border); background: transparent; color: var(--text); }
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: .5rem;
             flex-wrap: wrap; }
  .toolbar a { font-weight: 600; text-decoration: none; }
  .toolbar-actions { display: flex; align-items: center; gap: .75rem; }
  .btn-sm { font-size: .8rem; padding: .3rem .7rem; }
  img.media { display: block; max-width: 100%; max-height: 20rem; border-radius: .4rem;
              margin-top: .4rem; }
  a.file { display: inline-block; margin-top: .4rem; }
</style>
</head>
<body>${body}${autoRefreshScript}</body>
</html>`;
}

export const inboxRouter = express.Router();

inboxRouter.use(requireAuth);
inboxRouter.use(express.urlencoded({ extended: false }));

inboxRouter.get("/", async (req, res) => {
  const search = typeof req.query.q === "string" ? req.query.q : "";
  const convos = await listConversations({ search });

  const items = convos
    .map((c) => {
      const who = authorLabel(c.last_role, c.last_author);
      const preview = c.last_text ? `${who}: ${c.last_text}` : "(sin mensajes)";
      const statusClass = c.handed_off ? "convo-agent" : "convo-bot";
      const badge = c.handed_off
        ? '<span class="badge badge-agent">🧑‍💼 Empleado</span>'
        : '<span class="badge badge-bot">🤖 Bot</span>';
      const optOutBadge = c.opted_out ? '<span class="badge badge-warn">no contactar</span>' : "";
      return `<li class="${statusClass}"><a href="/inbox/${encodeURIComponent(c.wa_id)}">
        <strong>${escapeHtml(c.wa_id)}</strong>${badge}${optOutBadge}
        <div class="meta">${escapeHtml(formatTime(c.last_message_at))}</div>
        <div>${escapeHtml(preview.slice(0, 120))}</div>
      </a></li>`;
    })
    .join("");

  const searchBox = `
    <form class="search" method="get" action="/inbox">
      <input type="search" name="q" value="${escapeHtml(search)}"
             placeholder="Buscar por número o texto…" aria-label="Buscar conversaciones">
      <button type="submit">Buscar</button>
      ${search ? '<a class="clear" href="/inbox">Limpiar</a>' : ""}
    </form>`;

  let results;
  if (convos.length) {
    results = `<ul class="convos">${items}</ul>`;
  } else if (search) {
    results = `<p>Ningún resultado para <strong>${escapeHtml(search)}</strong>.</p>`;
  } else {
    results = "<p>Todavía no hay conversaciones.</p>";
  }

  const heading = search
    ? `${convos.length} resultado${convos.length === 1 ? "" : "s"}`
    : "Conversaciones";

  const toolbar = `<div class="toolbar">
    <h1>${escapeHtml(heading)}</h1>
    <div class="toolbar-actions">
      ${notificationScript(convos)}
      <a href="/inbox/nuevo">+ Nuevo contacto</a>
    </div>
  </div>`;

  res.send(layout("Conversaciones", `${toolbar}${searchBox}${results}`));
});

// Contactar primero a alguien que nunca escribió requiere una plantilla
// aprobada por Meta — WhatsApp rechaza texto libre para business-initiated.
inboxRouter.get("/nuevo", (_req, res) => {
  res.send(
    layout(
      "Nuevo contacto",
      `<p><a href="/inbox">← Volver</a></p>
       <h1>Nuevo contacto</h1>
       <p class="meta">Para escribirle primero a alguien que nunca te contactó, WhatsApp exige
       una plantilla ya aprobada — no se puede mandar texto libre acá.</p>
       <form class="newcontact" method="post" action="/inbox/nuevo">
         <label>Número, con código de país, sin "+" ni espacios
           <input type="text" name="wa_id" required pattern="[0-9]{8,15}" placeholder="5491133334444">
         </label>
         <label>Motivo (para tu propio registro, no se envía)
           <input type="text" name="reason" placeholder="pago pendiente / clase no vista">
         </label>
         <label>Nombre exacto de la plantilla aprobada
           <input type="text" name="template_name" required placeholder="recordatorio_pago">
         </label>
         <label>Variables de la plantilla en orden, separadas por "|" (dejar vacío si no tiene)
           <input type="text" name="params" placeholder="Juan Pérez|Curso de Ayurveda">
         </label>
         <button type="submit">Enviar plantilla</button>
       </form>`
    )
  );
});

// Serves a stored photo/PDF from our own origin. Registered before
// GET /:waId so "media" isn't mistaken for a phone number.
inboxRouter.get("/media/:messageId", async (req, res) => {
  if (!/^\d+$/.test(req.params.messageId)) return res.sendStatus(400);

  const file = await getMedia(req.params.messageId);
  if (!file) return res.status(404).send("Archivo no encontrado.");

  const inline = isInlineSafe(file.mime_type);
  const fallbackName = `archivo-${req.params.messageId}`;

  // Anything not on the inline allowlist is downloaded as an opaque binary,
  // and nosniff stops the browser from second-guessing that decision.
  res.setHeader("Content-Type", inline ? file.mime_type : "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${safeFilename(file.filename, fallbackName)}"`
  );

  // res.end, not res.send: send() appends "; charset=utf-8" to the content
  // type and JSON-serializes anything it doesn't recognize as a Buffer —
  // and a driver may hand back bytea as a plain Uint8Array, which would
  // arrive at the browser as `{"0":137,"1":80,...}` instead of a PNG.
  const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes);
  res.setHeader("Content-Length", bytes.length);
  res.end(bytes);
});

inboxRouter.post("/nuevo", async (req, res) => {
  const waId = (req.body.wa_id ?? "").trim();
  const reason = (req.body.reason ?? "").trim();
  const templateName = (req.body.template_name ?? "").trim();
  const params = (req.body.params ?? "").trim()
    ? req.body.params.split("|").map((p) => p.trim())
    : [];

  if (!waId || !templateName) {
    return res
      .status(400)
      .send(
        layout(
          "Nuevo contacto",
          `<p class="warn">Falta el número o el nombre de la plantilla.</p>
           <p><a href="/inbox/nuevo">← Volver</a></p>`
        )
      );
  }

  if (await isOptedOut(waId)) {
    return res
      .status(409)
      .send(
        layout(
          "Nuevo contacto",
          `<p class="warn">${escapeHtml(waId)} pidió no recibir más mensajes — no se envió nada.</p>
           <p><a href="/inbox">← Volver</a></p>`
        )
      );
  }

  try {
    await sendTemplateMessage(waId, templateName, params);
    await registerOutboundContact(waId);
    await logOutboundContact(waId, reason, templateName);
    const sentText = `[Plantilla "${templateName}"]${params.length ? " " + params.join(" · ") : ""}`;
    await appendAgentMessage(waId, sentText, req.inboxAuthor);
  } catch (err) {
    console.error("Error sending template:", err);
    return res
      .status(502)
      .send(
        layout(
          "Nuevo contacto",
          `<p class="warn">No se pudo enviar la plantilla: ${escapeHtml(err.message)}</p>
           <p><a href="/inbox/nuevo">← Volver</a></p>`
        )
      );
  }

  res.redirect(`/inbox/${encodeURIComponent(waId)}`);
});

inboxRouter.get("/:waId", async (req, res) => {
  const convo = await getConversation(req.params.waId);
  if (!convo) return res.status(404).send("Conversación no encontrada.");

  const expired = Date.now() - new Date(convo.last_message_at) > SERVICE_WINDOW_MS;

  const messages = convo.messages
    .map((m) => {
      let attachment = "";
      if (m.media_kind) {
        const href = `/inbox/media/${m.id}`;
        if (m.media_mime_type && /^image\//.test(m.media_mime_type)) {
          attachment = `<a href="${href}" target="_blank" rel="noopener">
            <img class="media" src="${href}" alt="${escapeHtml(m.text)}" loading="lazy">
          </a>`;
        } else if (m.media_mime_type) {
          const name = escapeHtml(m.media_filename || `${m.media_kind}`);
          attachment = `<a class="file" href="${href}" target="_blank" rel="noopener">📎 ${name}</a>`;
        } else {
          // The row exists but the download failed — say so rather than
          // rendering a broken link.
          attachment = `<div class="meta">⚠️ El archivo no se pudo guardar. Pedíselo de nuevo al cliente.</div>`;
        }
      }

      return `<div class="msg ${m.role}">
        <div class="meta">${escapeHtml(authorLabel(m.role, m.author))} · ${escapeHtml(formatTime(m.created_at))}</div>
        ${escapeHtml(m.text)}
        ${attachment}
      </div>`;
    })
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

  // Opt-out only gates future outbound-template sends from "Nuevo contacto"
  // — it never blocks a normal reply here, since the person may still be
  // mid-conversation.
  const optOut = convo.opted_out
    ? `<p class="meta">🚫 Pidió no recibir más mensajes iniciados por nosotros.</p>`
    : `<form method="post" action="/inbox/${encodeURIComponent(convo.wa_id)}/opt-out">
         <button type="submit">Marcar "no contactar de nuevo"</button>
       </form>`;

  // Jump to the newest message (and the reply box right under it) instead
  // of landing at the top of a long thread — otherwise every auto-refresh
  // would scroll the employee away from what they were reading.
  const scrollToLatest = `<script>window.scrollTo(0, document.body.scrollHeight);</script>`;

  res.send(
    layout(
      `Conversación ${convo.wa_id}`,
      `<p><a href="/inbox">← Volver</a></p>
       <div class="toolbar">
         <h1>${escapeHtml(convo.wa_id)}</h1>
         ${notificationScript()}
       </div>
       ${messages}
       ${form}
       ${optOut}
       ${scrollToLatest}`
    )
  );
});

inboxRouter.post("/:waId/reply", async (req, res) => {
  const waId = req.params.waId;
  const text = (req.body.text ?? "").trim();
  if (!text) return res.redirect(`/inbox/${encodeURIComponent(waId)}`);

  try {
    await sendTextMessage(waId, text);
    await appendAgentMessage(waId, text, req.inboxAuthor);
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

inboxRouter.post("/:waId/opt-out", async (req, res) => {
  await setOptedOut(req.params.waId, true);
  res.redirect(`/inbox/${encodeURIComponent(req.params.waId)}`);
});
