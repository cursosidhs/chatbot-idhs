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
        THEN $2 ELSE conversations.first_message_at END,
      handed_off = CASE
        WHEN $2 - conversations.last_message_at > make_interval(secs => $3)
        THEN FALSE ELSE conversations.handed_off END
    RETURNING wa_id, first_message_at, last_message_at, handed_off
    `,
    [waId, now, gapSeconds]
  );

  return rows[0];
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
export async function appendUserMessage(waId, text) {
  await pool.query(
    "INSERT INTO messages (wa_id, role, text) VALUES ($1, 'user', $2)",
    [waId, text]
  );
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
// rule and the 24h billing window are measured from.
export async function appendAgentMessage(waId, text, author = null) {
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
      "UPDATE conversations SET handed_off = TRUE WHERE wa_id = $1",
      [waId]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
      "SELECT role, text, author, created_at FROM messages WHERE wa_id = $1 ORDER BY created_at ASC, id ASC",
      [waId]
    ),
  ]);

  if (!convo.rows[0]) return null;
  return { ...convo.rows[0], messages: messages.rows };
}
