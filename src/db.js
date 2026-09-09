import pg from "pg";
import { config } from "./config.js";

// Hosted Postgres (Neon included) requires TLS; a local/dev Postgres
// generally doesn't offer it at all, and forcing it there just fails the
// handshake. `rejectUnauthorized: false` matches Neon's own snippets —
// the connection is still encrypted, we just don't pin their CA.
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(config.databaseUrl);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 3,
});

pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error:", err);
});

// Called once at startup from server.js. Idempotent, so there's no
// migration tooling to run — deploys just re-assert the schema.
export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      wa_id             TEXT PRIMARY KEY,
      first_message_at  TIMESTAMPTZ NOT NULL,
      last_message_at   TIMESTAMPTZ NOT NULL,
      handed_off        BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          BIGSERIAL PRIMARY KEY,
      wa_id       TEXT NOT NULL REFERENCES conversations(wa_id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK (role IN ('user', 'model', 'agent')),
      text        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS messages_wa_id_created_at_idx
      ON messages (wa_id, created_at DESC);

    -- Which employee sent an 'agent' message. NULL on rows written before
    -- multi-user support existed, and on 'user'/'model' rows; the inbox
    -- falls back to the generic "Empleado" label when it's missing.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS author TEXT;

    -- Whether the "we'll get back to you between 10 and 17" notice already
    -- went out this session, so five messages past the window don't produce
    -- five identical replies. Reset when a new session starts.
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS after_hours_notified BOOLEAN NOT NULL DEFAULT FALSE;

    -- When an employee last replied from /inbox. Used only to keep a
    -- handoff sticky across the session-gap check in registerInboundMessage
    -- — a slow-to-answer customer shouldn't undo a handoff an employee is
    -- actively working, even though last_message_at (customer-only, by
    -- design) looks stale. NULL for conversations no employee has touched.
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_agent_message_at TIMESTAMPTZ;

    -- Audit log of every outbound template send (one row per send, so
    -- reminding the same person twice is two rows, not an overwrite).
    CREATE TABLE IF NOT EXISTS outbound_contacts (
      id            BIGSERIAL PRIMARY KEY,
      wa_id         TEXT NOT NULL REFERENCES conversations(wa_id) ON DELETE CASCADE,
      reason        TEXT,
      template_name TEXT NOT NULL,
      sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 'image' | 'document' | 'audio' | 'video' | 'sticker' when the message
    -- carried a file, NULL for plain text. Lets the inbox decide how to
    -- render without joining the (heavy) media table on every thread load.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_kind TEXT;

    -- File bytes live in their own table, deliberately: keeping BYTEA out of
    -- the messages table means a careless SELECT * on the hot path can never
    -- drag megabytes along with it.
    CREATE TABLE IF NOT EXISTS media (
      message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      mime_type  TEXT NOT NULL,
      filename   TEXT,
      bytes      BYTEA NOT NULL
    );
  `);
}
