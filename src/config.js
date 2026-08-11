import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
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
};
