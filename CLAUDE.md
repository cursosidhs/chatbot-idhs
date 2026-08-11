# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A reactive WhatsApp Business bot: customers message a WhatsApp Business number (via Meta's Cloud API), the bot replies using Google Gemini. Node.js + Express, ES modules, no build step, no database (all state in memory).

## Commands

```bash
npm install       # install dependencies
npm run dev        # run with auto-restart on file change (node --watch)
npm start          # run in production mode
```

There are no tests, lint, or type-check scripts configured.

To sanity-check the server boots (e.g. after touching config/env handling), populate a throwaway `.env` (see `.env.example`) and run `node server.js` — `src/config.js` throws immediately on missing required vars, so a bad env fails fast at startup rather than on first request.

## Architecture

Everything flows through one webhook. `server.js` exposes `GET/POST /webhook`:

- `GET /webhook` — Meta's subscription verification handshake (checks `hub.verify_token` against `WHATSAPP_VERIFY_TOKEN`).
- `POST /webhook` — receives all WhatsApp events. Signature is verified via `isValidSignature` (HMAC-SHA256 over the raw body using `WHATSAPP_APP_SECRET`) before anything else runs. The raw body is captured by the `express.json({ verify })` hook in `server.js` because HMAC verification needs the exact bytes, not the reparsed JSON.

Meta requires a fast 200 response to the webhook POST, so `server.js` responds immediately and does the actual work (Gemini call, sending the reply) afterwards, fire-and-forget with its own try/catch.

### Module responsibilities

- **`src/config.js`** — the only place that reads `process.env`. Everything else imports `config` from here. Required vars throw at import time if missing (see `required()`); bot-behavior tuning vars (`BOT_RESPONSE_WINDOW_MINUTES`, `BOT_SESSION_GAP_HOURS`, `COURSES_CACHE_TTL_HOURS`, `COURSES_URL`) have defaults.
- **`src/whatsapp.js`** — all outbound Graph API calls (`sendTextMessage`) and inbound webhook parsing (`parseWebhookEvent`). `parseWebhookEvent` returns a discriminated shape: `{ type: "message", from, text }` for a customer message, `{ type: "echo", to, text }` for a message an employee sent from the official WhatsApp Business app, or `null`.
- **`src/conversationStore.js`** — in-memory `Map` keyed by WhatsApp ID (`waId`), holding per-conversation state (`firstMessageAt`, `lastMessageAt`, `handedOff`, `turns`). This is the piece that implements the bot's behavioral rules (below). **Resets on process restart** — there is no persistence layer by design.
- **`src/coursesStore.js`** — scrapes the institute's own course listing page (`COURSES_URL`, cheerio-based) and caches the result in memory with a TTL (`COURSES_CACHE_TTL_HOURS`), same no-persistence pattern as `conversationStore.js`. `looksLikeCourseQuery(text)` is a keyword gate `server.js` checks before calling `getCourses()`, so the scrape/prompt-injection only happens for messages that look course-related. `formatCoursesForPrompt(courses)` renders the cached list as `title: url` lines for `generateReply`.
- **`src/gemini.js`** — wraps the Gemini SDK. `generateReply(history, userText, coursesContext)` replays `history` (the store's `turns`, mapped to Gemini's `{role, parts}` shape) into a fresh `startChat` call each time rather than keeping a long-lived chat session per user — simpler, and fine since history is already capped. `coursesContext` (from `coursesStore.js`, when present) is appended to only this call's outgoing message, not to what `server.js` later saves via `appendTurn` — so it isn't resent on every subsequent turn.

### Bot behavior rules (the actual product logic)

These four rules are the point of the project and are implemented jointly by `server.js`'s webhook handler and `conversationStore.js` — read both together to understand the flow:

1. **Only responds early in a conversation.** `shouldBotRespond` returns true only within `BOT_RESPONSE_WINDOW_MINUTES` (default 10) of `firstMessageAt`.
2. **Session boundary.** `registerInboundMessage` treats a customer message as starting a *new* conversation (resetting `firstMessageAt`, clearing `handedOff`) if more than `BOT_SESSION_GAP_HOURS` (default 6) has passed since `lastMessageAt`.
3. **Yields to human employees.** This depends on Meta's WhatsApp "coexistence" feature being enabled on the phone number (lets the official WhatsApp Business app and the Cloud API run on the same number simultaneously). When enabled, employee-sent messages arrive at the webhook as `smb_message_echoes` events instead of the normal `messages` field. `server.js` routes those to `markHandedOff`, which sets `handedOff = true` for that `waId` — the bot then stays silent for the rest of that session regardless of the time window. Without coexistence active, this event never arrives, so this rule is inert (not broken — just has nothing to trigger it).
4. **Never initiates.** The bot only ever reacts to inbound `messages` events; nothing in the codebase sends a message except in direct response to one. This is structural, not a checked condition — there's no code path that lets the bot speak first.

### Course lookup

Separate from the four bot behavior rules above — this lets the bot answer "¿tienen un curso de X?" with the real, current link instead of a static/hardcoded one. Implemented in `src/coursesStore.js`, wired into `server.js`'s webhook handler right before the `generateReply` call:

1. `looksLikeCourseQuery(text)` checks the inbound message (accent-stripped) against a keyword list (`curso`, `diplomatura`, `taller`, `inscripcion`, etc.). If it doesn't match, nothing else in this flow runs for that message — no scrape, no extra prompt tokens.
2. If it matches, `getCourses()` returns the in-memory cached course list, scraping `COURSES_URL` first if the cache is empty or older than `COURSES_CACHE_TTL_HOURS` (default 12h). Concurrent calls during a refresh share one in-flight fetch rather than scraping in parallel. Courses tagged "Finalizado" on the site are filtered out.
3. The list is formatted (`formatCoursesForPrompt`) and appended to the *outgoing message only* in `generateReply` — never written into `conversationStore`'s history — so it isn't re-sent on later turns of the same conversation.
4. `gemini.js`'s `systemInstruction` tells the model to answer only from that injected block when present, and not invent courses or links otherwise.

This was deliberately built as a lazy in-memory TTL cache rather than a cron job or a database: Render's free tier sleeps the service after 15 min idle and caps it at 750 instance-hours/month, so a cron that pings the service just to refresh a cache would burn free hours for no benefit. Traffic-triggered lazy refresh gets the same effect (avoid scraping on every message) without extra infrastructure, consistent with the project's no-DB, in-memory-only design.

If `idhs.org.ar`'s HTML structure changes, the cheerio selectors in `coursesStore.js` (`article.qode-cl-item`, `h4.qode-cli-title a`, `.tags-01`) may stop matching. `getCourses()` logs the failure and serves whatever was last cached (or an empty array on a cold cache) rather than throwing into the webhook handler.

### Webhook field subscriptions this depends on

Configured in the Meta App dashboard, not in code — but the code silently no-ops if these aren't subscribed:

- `messages` — required, this is the whole bot.
- `smb_message_echoes` — required for rule 3 above; only relevant once coexistence is enabled on the number.

## Known constraints worth knowing before changing things

- **No persistence.** Conversation state and history live only in the `Map` in `conversationStore.js`. A restart (including Render's free-tier idle sleep/wake cycle) silently resets every conversation's window and history. If this ever needs to survive restarts, that Map is the thing to replace.
- **Single-process only.** State is process-local; this would break under multiple instances/replicas without moving state to a shared store. This also applies to the course cache in `coursesStore.js`.
- **WhatsApp free-tier economics**: user-initiated conversations are free within the 24h session window; business-initiated messages need pre-approved templates and are paid. This is why the bot never initiates (rule 4) — it's a cost/policy constraint, not just a UX choice.
- **Gemini free-tier economics**: the free tier is rate-limited (RPM/TPM/RPD), not billed per token — so the keyword gate on course lookups exists to conserve rate-limit budget on messages that don't need the extra context, not to save money.
- **Scraping a third-party site.** `coursesStore.js` depends on `idhs.org.ar`'s current HTML structure (see "Course lookup" above). It's not an API contract — a site redesign can silently break it, degrading gracefully to stale/empty course data rather than crashing.
