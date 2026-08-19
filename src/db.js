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
  `);
}
