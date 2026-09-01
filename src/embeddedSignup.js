import express from "express";
import { config } from "./config.js";
import { requireAuth } from "./inbox.js";

// Throwaway harness for answering one question before committing weeks to the
// Tech Provider process: does Meta's Embedded Signup let us onboard our own
// business portfolio, and does the Coexistence variant of the flow appear?
// It sends no WhatsApp messages and writes nothing to Postgres. Delete the
// module and its mount in server.js once that question is settled.

const GRAPH = `https://graph.facebook.com/${config.graphApiVersion}`;

// Coexistence is not a setting on the account — it's this flag on the flow,
// which swaps the "create a WABA" screen for "connect your existing WhatsApp
// Business app account".
const COEXISTENCE_FEATURE = "whatsapp_business_app_onboarding";

// Last run kept in memory only, so a token never reaches Postgres or a log
// file. Lost on restart, which is the desired lifetime for this.
let lastRun = null;

function graphGet(path, params) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return fetch(url).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `Graph ${res.status}`);
    return body;
  });
}

export const embeddedSignupRouter = express.Router();

embeddedSignupRouter.use(requireAuth);

// The browser posts the WA_EMBEDDED_SIGNUP event here as the user moves
// through the flow. These events are the only place Meta reports which
// business portfolio and WABA got picked, so they're the actual answer.
embeddedSignupRouter.post("/session", (req, res) => {
  lastRun = { ...(lastRun ?? {}), session: req.body, at: new Date().toISOString() };
  console.log("[es-test] session event:", JSON.stringify(req.body));
  res.sendStatus(204);
});

embeddedSignupRouter.post("/exchange", async (req, res) => {
  const code = req.body?.code;
  if (!code) return res.status(400).json({ error: "Falta el code." });

  try {
    // No redirect_uri here: the JS SDK popup flow doesn't use one, unlike a
    // plain redirect-based OAuth handshake.
    const token = await graphGet("oauth/access_token", {
      client_id: config.metaAppId,
      client_secret: config.whatsappAppSecret,
      code,
    });

    // debug_token is what makes this harness worth running: it reports the
    // granted scopes AND the specific WABA ids the token is scoped to, which
    // is how we confirm which portfolio the flow actually attached.
    const debug = await graphGet("debug_token", {
      input_token: token.access_token,
      access_token: `${config.metaAppId}|${config.whatsappAppSecret}`,
    });

    const result = { token, debug };

    const wabaId = debug?.data?.granular_scopes
      ?.find((s) => s.scope === "whatsapp_business_management")
      ?.target_ids?.[0];

    if (wabaId) {
      result.waba = await graphGet(wabaId, {
        fields: "id,name,currency,timezone_id,account_review_status",
        access_token: token.access_token,
      }).catch((err) => ({ error: err.message }));
    }

    lastRun = { ...(lastRun ?? {}), result, at: new Date().toISOString() };
    console.log("[es-test] exchange ok, WABA:", wabaId ?? "(ninguna)");
    res.json(result);
  } catch (err) {
    console.error("[es-test] exchange failed:", err);
    res.status(502).json({ error: err.message });
  }
});

embeddedSignupRouter.get("/last", (_req, res) => res.json(lastRun ?? {}));

embeddedSignupRouter.get("/", (_req, res) => {
  const ready = Boolean(config.metaAppId && config.metaEsConfigId);

  const setup = ready
    ? ""
    : `<p class="warn">Faltan <code>META_APP_ID</code> y/o <code>META_ES_CONFIG_ID</code> en el entorno.
       El App ID está en el App Dashboard; el Config ID sale de crear una configuración en
       Facebook Login for Business con la plantilla <em>WhatsApp Embedded Signup</em>.</p>`;

  res.send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prueba de Embedded Signup</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 32px 20px 64px; }
  main { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }
  h1 { font-size: 1.5rem; margin: 0; }
  h2 { font-size: 1.05rem; margin: 0 0 8px; }
  p { margin: 0; }
  code { background: rgba(128,128,128,.18); padding: 1px 5px; border-radius: 3px; font-size: .88em; }
  .warn { padding: 12px 16px; border-left: 4px solid #c47f1a; background: rgba(196,127,26,.1); }
  .row { display: flex; flex-wrap: wrap; gap: 10px; }
  button { font: inherit; padding: 10px 18px; border: 1px solid currentColor;
           background: transparent; color: inherit; cursor: pointer; border-radius: 4px; }
  button:hover:not(:disabled) { background: rgba(128,128,128,.14); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  pre { background: rgba(128,128,128,.12); padding: 14px; border-radius: 4px;
        overflow-x: auto; font-size: 12.5px; line-height: 1.5; margin: 0; white-space: pre-wrap;
        word-break: break-word; max-height: 460px; }
  ol { margin: 0; padding-left: 1.2em; }
  li { margin-bottom: 6px; }
</style>
</head>
<body>
<main>
  <h1>Prueba de Embedded Signup</h1>
  <p>Banco de pruebas temporal. No manda mensajes ni toca la base de datos.
     El <code>APP_SECRET</code> nunca sale del servidor: el canje del code se hace acá atrás.</p>

  ${setup}

  <section>
    <h2>Qué mirar</h2>
    <ol>
      <li>Con <strong>Coexistence</strong>, la pantalla de crear WABA tiene que ser reemplazada
          por una que ofrezca conectar la cuenta existente de WhatsApp Business.</li>
      <li>En el selector de portafolio, confirmá si aparece <strong>el portafolio propio</strong>
          (el que ya es dueño de la app) o sólo se puede crear uno nuevo.</li>
      <li>Al terminar, mirá <code>granular_scopes</code> abajo: los <code>target_ids</code> dicen
          a qué WABA quedó atado el token.</li>
    </ol>
  </section>

  <section>
    <h2>Lanzar el flujo</h2>
    <div class="row">
      <button id="plain" ${ready ? "" : "disabled"}>Flujo normal</button>
      <button id="coex" ${ready ? "" : "disabled"}>Flujo Coexistence</button>
    </div>
  </section>

  <section>
    <h2>Registro</h2>
    <pre id="log">Esperando…</pre>
  </section>
</main>

<script async defer crossorigin="anonymous" src="https://connect.facebook.net/es_LA/sdk.js"></script>
<script>
  const APP_ID = ${JSON.stringify(config.metaAppId)};
  const CONFIG_ID = ${JSON.stringify(config.metaEsConfigId)};
  const VERSION = ${JSON.stringify(config.graphApiVersion)};
  const COEXISTENCE = ${JSON.stringify(COEXISTENCE_FEATURE)};

  const logEl = document.getElementById("log");
  let lines = [];

  // textContent, never innerHTML: this panel renders whatever Meta sends back.
  function log(label, payload) {
    const stamp = new Date().toLocaleTimeString("es-AR");
    const body = payload === undefined ? "" : "\\n" + JSON.stringify(payload, null, 2);
    lines.push("[" + stamp + "] " + label + body);
    logEl.textContent = lines.join("\\n\\n");
    logEl.scrollTop = logEl.scrollHeight;
  }

  window.fbAsyncInit = function () {
    FB.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: true, version: VERSION });
    log("SDK listo.");
  };

  // Meta reports progress through the flow by postMessage, not through the
  // login callback. Origin is checked because any page can postMessage here.
  window.addEventListener("message", (event) => {
    if (!/(^|\\.)facebook\\.com$/.test(new URL(event.origin).hostname)) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type !== "WA_EMBEDDED_SIGNUP") return;

    log("Evento de sesión", data);
    fetch("session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).catch(() => log("No se pudo guardar el evento en el servidor."));
  });

  async function exchange(code) {
    log("Canjeando el code…");
    try {
      const res = await fetch("exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      log(res.ok ? "Resultado del canje" : "Falló el canje", await res.json());
    } catch (err) {
      log("Error de red al canjear: " + err.message);
    }
  }

  function launch(featureType) {
    if (typeof FB === "undefined") return log("El SDK todavía no cargó, probá de nuevo.");

    const extras = { setup: {}, sessionInfoVersion: "3" };
    if (featureType) extras.featureType = featureType;

    log("Abriendo el flujo" + (featureType ? " (Coexistence)" : "") + "…");

    FB.login(
      (response) => {
        const code = response?.authResponse?.code;
        if (code) return exchange(code);
        log("El flujo se cerró sin devolver un code.", response);
      },
      {
        config_id: CONFIG_ID,
        response_type: "code",
        override_default_response_type: true,
        extras,
      }
    );
  }

  document.getElementById("plain").onclick = () => launch(null);
  document.getElementById("coex").onclick = () => launch(COEXISTENCE);
</script>
</body>
</html>`);
});
