# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A reactive WhatsApp Business bot: customers message a WhatsApp Business number (via Meta's Cloud API), the bot replies using Google Gemini. A human employee can take over any conversation from a built-in web inbox at `/inbox`. Node.js + Express, ES modules, no build step. Conversation state lives in Postgres (Neon free tier); the only in-memory state left is the course cache.

## Commands

```bash
npm install       # install dependencies
npm run dev        # run with auto-restart on file change (node --watch)
npm start          # run in production mode
```

There are no tests, lint, or type-check scripts configured.

To sanity-check the server boots (e.g. after touching config/env handling), populate a throwaway `.env` (see `.env.example`) and run `node server.js` — `src/config.js` throws immediately on missing required vars, so a bad env fails fast at startup rather than on first request.

Booting now also requires a reachable `DATABASE_URL`, because `server.js` awaits `initSchema()` before listening. With no Postgres at hand, `@electric-sql/pglite` (real Postgres compiled to WASM) works for local verification: import `src/db.js`, overwrite `pool.query`/`pool.connect` to delegate to a `PGlite` instance, then import `server.js`. That exercises the actual SQL without any container or install. Note `pool.query` must route multi-statement strings to PGlite's `exec()` rather than `query()`.

## Architecture

Everything flows through one webhook. `server.js` exposes `GET/POST /webhook`:

- `GET /webhook` — Meta's subscription verification handshake (checks `hub.verify_token` against `WHATSAPP_VERIFY_TOKEN`).
- `POST /webhook` — receives all WhatsApp events. Signature is verified via `isValidSignature` (HMAC-SHA256 over the raw body using `WHATSAPP_APP_SECRET`) before anything else runs. The raw body is captured by the `express.json({ verify })` hook in `server.js` because HMAC verification needs the exact bytes, not the reparsed JSON.

Meta requires a fast 200 response to the webhook POST, so `server.js` responds immediately and does the actual work (Gemini call, sending the reply) afterwards, fire-and-forget with its own try/catch.

### Module responsibilities

- **`src/config.js`** — the only place that reads `process.env`. Everything else imports `config` from here. Required vars throw at import time if missing (see `required()`); bot-behavior tuning vars (`BOT_RESPONSE_WINDOW_MINUTES`, `BOT_SESSION_GAP_HOURS`, `COURSES_CACHE_TTL_HOURS`, `COURSES_URL`) and `INBOX_USER` have defaults.
- **`src/db.js`** — the `pg` pool and `initSchema()`. Schema is asserted with `CREATE TABLE IF NOT EXISTS` on every boot, so there is no migration tool; changing a column means writing the `ALTER` yourself. TLS is enabled unless the URL points at localhost, because hosted Postgres requires it and local Postgres usually doesn't offer it.
- **`src/whatsapp.js`** — all outbound Graph API calls (`sendTextMessage`), inbound webhook parsing (`parseWebhookEvent`), and HMAC verification (`isValidSignature`). `parseWebhookEvent` returns a discriminated shape: `{ type: "message", from, text }` for a customer message, `{ type: "echo", to, text }` for a message an employee sent from the official WhatsApp Business app, or `null`. **`isValidSignature` must compare buffer lengths before calling `crypto.timingSafeEqual`** — that function throws on a length mismatch, and it runs outside any try/catch in `server.js`, so skipping the check turns any malformed `x-hub-signature-256` header into a remote process kill. (This was a real bug, fixed; don't reintroduce it.)
- **`src/conversationStore.js`** — every read/write of conversation state, all async and Postgres-backed. Two tables: `conversations` (`wa_id`, `first_message_at`, `last_message_at`, `handed_off`) and `messages` (`wa_id`, `role`, `text`, `created_at`). This is the piece that implements the bot's behavioral rules (below), plus the queries the inbox needs (`listConversations`, `getConversation`, `appendAgentMessage`).
  - `role` is `'user'` | `'model'` | `'agent'`; Gemini only understands user/model, so `'agent'` maps to `'model'` when replaying history.
  - `registerInboundMessage` does the session-boundary check inside a single `INSERT … ON CONFLICT DO UPDATE`, so two near-simultaneous messages can't race into two different sessions. It **returns the row**, and `shouldBotRespond(convo)` takes that row rather than re-querying — one round trip per message instead of two.
  - `appendAgentMessage` deliberately does **not** touch `last_message_at`: that column tracks the *customer's* last message, which is what both the session-gap rule and the 24h service window are measured from. Bumping it on an agent reply would keep a session alive forever.
- **`src/coursesStore.js`** — scrapes the institute's own course listing page (`COURSES_URL`, cheerio-based) and caches the result in memory with a TTL (`COURSES_CACHE_TTL_HOURS`), same no-persistence pattern as `conversationStore.js`. `looksLikeCourseQuery(text)` is a keyword gate `server.js` checks before calling `getCourses()`, so the scrape/prompt-injection only happens for messages that look course-related. `formatCoursesForPrompt(courses)` renders the cached list as `title: url` lines for `generateReply`.
- **`src/gemini.js`** — wraps the Gemini SDK. `generateReply(history, userText, coursesContext)` replays `history` (the store's `turns`, mapped to Gemini's `{role, parts}` shape) into a fresh `startChat` call each time rather than keeping a long-lived chat session per user — simpler, and fine since history is already capped. `coursesContext` (from `coursesStore.js`, when present) is appended to only this call's outgoing message, not to what `server.js` later saves via `appendTurn` — so it isn't resent on every subsequent turn.

- **`src/inbox.js`** — the employee-facing web inbox mounted at `/inbox`, as an Express Router: conversation list, thread view, and a reply form. Server-rendered HTML strings (the project has no build step and no template engine, deliberately). Two things here are security-critical and easy to break:
  - **Everything rendered goes through `escapeHtml`.** Message bodies are attacker-controlled — a customer can put `<script>` in a WhatsApp message, and it would execute in the employee's browser.
  - **`safeEqual` hashes both sides before `timingSafeEqual`**, so mismatched credential lengths neither throw nor leak length through timing.

### Bot behavior rules (the actual product logic)

These four rules are the point of the project and are implemented jointly by `server.js`'s webhook handler and `conversationStore.js` — read both together to understand the flow:

1. **Only responds early in a conversation.** `shouldBotRespond` returns true only within `BOT_RESPONSE_WINDOW_MINUTES` (default 10) of `firstMessageAt`.
2. **Session boundary.** `registerInboundMessage` treats a customer message as starting a *new* conversation (resetting `firstMessageAt`, clearing `handedOff`) if more than `BOT_SESSION_GAP_HOURS` (default 6) has passed since `lastMessageAt`.
3. **Yields to human employees.** Two independent triggers set `handed_off = true`, after which the bot stays silent for the rest of that session regardless of the time window:
   - An employee replies from `/inbox` → `appendAgentMessage`. This is the path that actually runs today.
   - Meta's "coexistence" feature is enabled and an employee replies from the WhatsApp Business app → arrives as an `smb_message_echoes` event → `markHandedOff`. Inert unless coexistence is on (not broken — just has nothing to trigger it). Note coexistence can't be self-served from the App Dashboard; it requires the Embedded Signup flow and Tech Provider status, which is why the inbox exists.
4. **Never initiates.** The bot only ever reacts to inbound `messages` events; nothing in the codebase sends a message except in direct response to one — the `/inbox` reply form included, which can only reply inside an existing conversation. This is structural, not a checked condition.

### Course lookup

Separate from the four bot behavior rules above — this lets the bot answer "¿tienen un curso de X?" with the real, current link instead of a static/hardcoded one. Implemented in `src/coursesStore.js`, wired into `server.js`'s webhook handler right before the `generateReply` call:

1. `looksLikeCourseQuery(text)` checks the inbound message (accent-stripped) against a keyword list (`curso`, `diplomatura`, `taller`, `inscripcion`, etc.). If it doesn't match, nothing else in this flow runs for that message — no scrape, no extra prompt tokens.
2. If it matches, `getCourses()` returns the in-memory cached course list, scraping `COURSES_URL` first if the cache is empty or older than `COURSES_CACHE_TTL_HOURS` (default 12h). Concurrent calls during a refresh share one in-flight fetch rather than scraping in parallel. Courses tagged "Finalizado" on the site are filtered out.
3. The list is formatted (`formatCoursesForPrompt`) and appended to the *outgoing message only* in `generateReply` — never written into `conversationStore`'s history — so it isn't re-sent on later turns of the same conversation.
4. `gemini.js`'s `systemInstruction` tells the model to answer only from that injected block when present, and not invent courses or links otherwise.

This was deliberately built as a lazy in-memory TTL cache rather than a cron job or a database table: Render's free tier sleeps the service after 15 min idle and caps it at 750 instance-hours/month, so a cron that pings the service just to refresh a cache would burn free hours for no benefit. Traffic-triggered lazy refresh gets the same effect (avoid scraping on every message) without extra moving parts. It stayed in memory even after Postgres arrived — course data is derived, disposable, and cheap to re-fetch, unlike conversation history.

If `idhs.org.ar`'s HTML structure changes, the cheerio selectors in `coursesStore.js` (`article.qode-cl-item`, `h4.qode-cli-title a`, `.tags-01`) may stop matching. `getCourses()` logs the failure and serves whatever was last cached (or an empty array on a cold cache) rather than throwing into the webhook handler.

### Webhook field subscriptions this depends on

Configured in the Meta App dashboard, not in code — but the code silently no-ops if these aren't subscribed:

- `messages` — required, this is the whole bot.
- `smb_message_echoes` — required for rule 3 above; only relevant once coexistence is enabled on the number.

## Known constraints worth knowing before changing things

- **Every inbound message is persisted before the bot decides whether to answer.** `server.js` calls `appendUserMessage` *before* the `shouldBotRespond` early-return. If you move that write back inside the "bot replies" branch, handed-off conversations stop recording customer messages and show up empty in the inbox — which is exactly when a human needs to read them.
- **The course cache is still process-local.** `coursesStore.js` keeps its cache in memory, so it resets on restart and would be duplicated per instance under multiple replicas. Conversation state no longer has this problem.
- **Free-tier database economics.** Neon's free tier is permanent but bills compute time and scales to zero when idle, so keep per-message queries few (see the one-round-trip note on `registerInboundMessage`). Render's own free Postgres is a trap for this project: it expires 30 days after creation and is deleted after a 14-day grace period.
- **WhatsApp free-tier economics**: user-initiated conversations are free within the 24h session window; business-initiated messages need pre-approved templates and are paid. This is why the bot never initiates (rule 4) — it's a cost/policy constraint, not just a UX choice.
- **Gemini free-tier economics**: the free tier is rate-limited (RPM/TPM/RPD), not billed per token — so the keyword gate on course lookups exists to conserve rate-limit budget on messages that don't need the extra context, not to save money.
- **Scraping a third-party site.** `coursesStore.js` depends on `idhs.org.ar`'s current HTML structure (see "Course lookup" above). It's not an API contract — a site redesign can silently break it, degrading gracefully to stale/empty course data rather than crashing.
- **`/inbox` can send WhatsApp messages as the institute.** It is protected only by Basic Auth over HTTPS, so `INBOX_PASSWORD` is a real credential, not a dev convenience. Any feature added there inherits that blast radius.
- **The inbox can't message outside the 24h service window.** Free-form sends only work within 24h of the customer's last message; past that Meta requires a paid approved template, which this codebase does not implement. `src/inbox.js` detects the expiry and swaps the reply form for an explanation rather than letting the send fail.
