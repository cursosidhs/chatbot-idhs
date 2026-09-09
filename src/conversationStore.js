import { config } from "./config.js";
import { pool } from "./db.js";

const MAX_TURNS = 10;

// Roles stored in `messages`:
//   'user'  — the customer
//   'model' — the bot (Gemini)
//   'agent' — a human employee replying from the inbox
// Gemini only understands 'user'/'model', so 'agent' is mapped to 'model'
// when replaying history (both are "the business" from the model's POV).
function toGeminiRole(role) {
  return role === "user" ? "user" : "model";
}

// Upsert + session-boundary check in a single statement so two messages
// arriving at once can't race into two different sessions. A gap longer
// than sessionGapMs resets firstMessageAt and clears handedOff, which is
// what makes the next message count as a brand new conversation.
//
// The gap is measured against last_message_at (customer-only) AND, when
// set, last_agent_message_at — a new session only starts once BOTH are
// stale. Without the second check, an employee who replies to a slow
// customer (say, 10h after their last message) gets undone the moment that
// customer answers: last_message_at alone would already be past the gap,
// so the reply would look like the start of a fresh, un-handed-off session
// even though the employee is actively on it. This was a real bug, caught
// via an actual conversation transcript where the bot replied minutes after
// an employee confirmed a payment.
export async function registerInboundMessage(waId, now = new Date()) {
  const gapSeconds = Math.floor(config.sessionGapMs / 1000);

  const { rows } = await pool.query(
    `
    INSERT INTO conversations (wa_id, first_message_at, last_message_at, handed_off)
    VALUES ($1, $2, $2, FALSE)
    ON CONFLICT (wa_id) DO UPDATE SET
      last_message_at = $2,
      first_message_at = CASE
        WHEN $2 - conversations.last_message_at > make_interval(secs => $3)
         AND (conversations.last_agent_message_at IS NULL
              OR $2 - conversations.last_agent_message_at > make_interval(secs => $3))
        THEN $2 ELSE conversations.first_message_at END,
      handed_off = CASE
        WHEN $2 - conversations.last_message_at > make_interval(secs => $3)
         AND (conversations.last_agent_message_at IS NULL
              OR $2 - conversations.last_agent_message_at > make_interval(secs => $3))
        THEN FALSE ELSE conversations.handed_off END,
      after_hours_notified = CASE
        WHEN $2 - conversations.last_message_at > make_interval(secs => $3)
         AND (conversations.last_agent_message_at IS NULL
              OR $2 - conversations.last_agent_message_at > make_interval(secs => $3))
        THEN FALSE ELSE conversations.after_hours_notified END
    RETURNING wa_id, first_message_at, last_message_at, handed_off, after_hours_notified
    `,
    [waId, now, gapSeconds]
  );

  return rows[0];
}

export async function markAfterHoursNotified(waId) {
  await pool.query(
    "UPDATE conversations SET after_hours_notified = TRUE WHERE wa_id = $1",
    [waId]
  );
}

// Takes the row returned by registerInboundMessage rather than re-querying,
// so handling a message costs one round trip instead of two (Neon's free
// tier bills compute time, and the DB may be waking from scale-to-zero).
export function shouldBotRespond(convo, now = new Date()) {
  if (!convo || convo.handed_off) return false;
  return now - convo.first_message_at <= config.responseWindowMs;
}

export async function markHandedOff(waId, now = new Date()) {
  await pool.query(
    `
    INSERT INTO conversations (wa_id, first_message_at, last_message_at, handed_off)
    VALUES ($1, $2, $2, TRUE)
    ON CONFLICT (wa_id) DO UPDATE SET handed_off = TRUE
    `,
    [waId, now]
  );
}

export async function getHistory(waId) {
  const { rows } = await pool.query(
    `
    SELECT role, text FROM (
      SELECT role, text, created_at, id
      FROM messages
      WHERE wa_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    ) recent
    ORDER BY created_at ASC, id ASC
    `,
    [waId, MAX_TURNS * 2]
  );

  return rows.map((row) => ({ role: toGeminiRole(row.role), text: row.text }));
}

// Recorded for EVERY inbound message, including ones the bot stays silent
// on — otherwise a handed-off conversation would show up empty in the
// inbox, which is exactly when a human needs to read it.
// Returns the new message id so the caller can attach media to it.
// `mediaKind` is null for plain text.
export async function appendUserMessage(waId, text, mediaKind = null) {
  const { rows } = await pool.query(
    "INSERT INTO messages (wa_id, role, text, media_kind) VALUES ($1, 'user', $2, $3) RETURNING id",
    [waId, text, mediaKind]
  );
  return rows[0].id;
}

export async function attachMedia(messageId, { mimeType, filename, buffer }) {
  await pool.query(
    `
    INSERT INTO media (message_id, mime_type, filename, bytes)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (message_id) DO NOTHING
    `,
    [messageId, mimeType, filename, buffer]
  );
}

export async function getMedia(messageId) {
  const { rows } = await pool.query(
    "SELECT mime_type, filename, bytes FROM media WHERE message_id = $1",
    [messageId]
  );
  return rows[0] ?? null;
}

export async function appendBotMessage(waId, text) {
  await pool.query(
    "INSERT INTO messages (wa_id, role, text) VALUES ($1, 'model', $2)",
    [waId, text]
  );
}

// A human replied from the inbox: record it and silence the bot for the
// rest of this session (same effect markHandedOff has for coexistence
// echoes). Deliberately does NOT touch last_message_at — that column
// tracks the customer's last message, which is what both the session-gap
// rule and the 24h billing window are measured from. last_agent_message_at
// is the separate column that keeps the handoff itself alive across that
// same session-gap check — see registerInboundMessage.
export async function appendAgentMessage(waId, text, author = null, now = new Date()) {
  // Needs a single checked-out client: pool.query() can hand each
  // statement a different connection, which would break the transaction.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO messages (wa_id, role, text, author) VALUES ($1, 'agent', $2, $3)",
      [waId, text, author]
    );
    await client.query(
      "UPDATE conversations SET handed_off = TRUE, last_agent_message_at = $2 WHERE wa_id = $1",
      [waId, now]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Creates the conversation row when WE start it — an outbound template to
// someone who never wrote in has no existing row to attach to. Starts
// handed_off = TRUE: the bot has no context for "pago pendiente" or "clase
// no vista" campaigns, so any reply goes to a human, never to Gemini.
// ON CONFLICT DO NOTHING: if this wa_id already has a conversation (they
// did write in before), leave its state exactly as it was.
export async function registerOutboundContact(waId, now = new Date()) {
  await pool.query(
    `
    INSERT INTO conversations (wa_id, first_message_at, last_message_at, handed_off)
    VALUES ($1, $2, $2, TRUE)
    ON CONFLICT (wa_id) DO NOTHING
    `,
    [waId, now]
  );
}

export async function logOutboundContact(waId, reason, templateName) {
  await pool.query(
    "INSERT INTO outbound_contacts (wa_id, reason, template_name) VALUES ($1, $2, $3)",
    [waId, reason || null, templateName]
  );
}

// `%` and `_` are wildcards to ILIKE, so a search for "50%" or "curso_1"
// would silently match far more than the employee typed. Escaping them
// (and the escape character itself) keeps the search literal.
function toLikePattern(term) {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// `search` matches the phone number or any message in the conversation.
// When searching, the preview shows the message that actually matched
// rather than the latest one — otherwise a hit on "ayurveda" would preview
// an unrelated "gracias" and look like a false positive.
export async function listConversations({ limit = 50, search = "" } = {}) {
  const term = search.trim() ? toLikePattern(search.trim()) : null;

  const { rows } = await pool.query(
    `
    SELECT c.wa_id, c.last_message_at, c.handed_off,
           m.text AS last_text, m.role AS last_role, m.author AS last_author
    FROM conversations c
    LEFT JOIN LATERAL (
      SELECT text, role, author FROM messages
      WHERE wa_id = c.wa_id
      ORDER BY
        CASE WHEN $2::text IS NOT NULL AND text ILIKE $2 ESCAPE '\\' THEN 0 ELSE 1 END,
        created_at DESC, id DESC
      LIMIT 1
    ) m ON TRUE
    WHERE $2::text IS NULL
       OR c.wa_id ILIKE $2 ESCAPE '\\'
       OR EXISTS (
            SELECT 1 FROM messages
            WHERE wa_id = c.wa_id AND text ILIKE $2 ESCAPE '\\'
          )
    ORDER BY c.last_message_at DESC
    LIMIT $1
    `,
    [limit, term]
  );

  return rows;
}

export async function getConversation(waId) {
  const [convo, messages] = await Promise.all([
    pool.query(
      "SELECT wa_id, first_message_at, last_message_at, handed_off FROM conversations WHERE wa_id = $1",
      [waId]
    ),
    pool.query(
      `
      SELECT m.id, m.role, m.text, m.author, m.created_at, m.media_kind,
             md.filename AS media_filename, md.mime_type AS media_mime_type
      FROM messages m
      LEFT JOIN media md ON md.message_id = m.id
      WHERE m.wa_id = $1
      ORDER BY m.created_at ASC, m.id ASC
      `,
      [waId]
    ),
  ]);

  if (!convo.rows[0]) return null;
  return { ...convo.rows[0], messages: messages.rows };
}
