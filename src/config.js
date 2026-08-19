import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// `INBOX_USERS` is a comma-separated list of `nombre:contraseña`, where the
// name is what gets shown as the author of a reply ("María", "Juan").
// `INBOX_USER`/`INBOX_PASSWORD` stay supported as the single-user form so an
// already-deployed instance keeps booting after a pull.
function parseInboxUsers() {
  const raw = process.env.INBOX_USERS;

  if (raw) {
    const users = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf(":");
        if (separator < 1 || separator === entry.length - 1) {
          throw new Error(
            `Invalid INBOX_USERS entry: "${entry}". Expected "nombre:contraseña".`
          );
        }
        return {
          name: entry.slice(0, separator).trim(),
          password: entry.slice(separator + 1),
        };
      });

    if (!users.length) throw new Error("INBOX_USERS is set but empty.");
    return users;
  }

  return [{ name: process.env.INBOX_USER || "idhs", password: required("INBOX_PASSWORD") }];
}

export const config = {
  port: process.env.PORT || 3000,
  whatsappToken: required("WHATSAPP_TOKEN"),
  whatsappPhoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
  whatsappVerifyToken: required("WHATSAPP_VERIFY_TOKEN"),
  whatsappAppSecret: required("WHATSAPP_APP_SECRET"),
  geminiApiKey: required("GEMINI_API_KEY"),
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  responseWindowMs: Number(process.env.BOT_RESPONSE_WINDOW_MINUTES || 10) * 60 * 1000,
  sessionGapMs: Number(process.env.BOT_SESSION_GAP_HOURS || 6) * 60 * 60 * 1000,
  coursesUrl: process.env.COURSES_URL || "https://idhs.org.ar/cursos-inscripcion/",
  coursesCacheTtlMs: Number(process.env.COURSES_CACHE_TTL_HOURS || 12) * 60 * 60 * 1000,
  databaseUrl: required("DATABASE_URL"),
  inboxUsers: parseInboxUsers(),
  inboxRefreshSeconds: Number(process.env.INBOX_REFRESH_SECONDS || 30),
};
