import * as cheerio from "cheerio";
import { config } from "./config.js";

const FINISHED_STATUS = "Finalizado";
const COURSE_KEYWORDS = [
  "curso",
  "diplomatura",
  "taller",
  "jornada",
  "programa",
  "capacitacion",
  "posgrado",
  "especializacion",
  "carrera",
  "inscripcion",
  "inscribir",
  "anotar",
  "formacion",
];

let cache = { courses: [], fetchedAt: 0 };
let inFlight = null;

function normalize(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Cheap heuristic gate so we only pay the extra Gemini tokens (and stay
// under the free-tier RPM/TPM caps) when the message actually looks
// course-related, instead of injecting the course list on every message.
export function looksLikeCourseQuery(text) {
  const normalized = normalize(text);
  return COURSE_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function parseCourses(html) {
  const $ = cheerio.load(html);
  const courses = [];

  $("article.qode-cl-item").each((_, el) => {
    const anchor = $(el).find("h4.qode-cli-title a").first();
    const title = (anchor.attr("title") || anchor.text()).trim();
    const url = anchor.attr("href");
    const status = $(el).find(".tags-01").first().text().trim();

    if (!title || !url || status === FINISHED_STATUS) return;

    courses.push({ title, url, status });
  });

  return courses;
}

async function fetchCourses() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(config.coursesUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; IDHSBot/1.0)" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch courses page: ${res.status}`);
    }
    return parseCourses(await res.text());
  } finally {
    clearTimeout(timeout);
  }
}

// Lazy, TTL-based in-memory cache (mirrors conversationStore.js: no
// persistence, resets on restart). Concurrent callers during a cold start
// share the same in-flight fetch instead of scraping the page multiple
// times. On fetch failure, serves whatever was cached before (possibly
// empty) rather than throwing into the webhook handler.
export async function getCourses(now = Date.now()) {
  if (cache.courses.length && now - cache.fetchedAt < config.coursesCacheTtlMs) {
    return cache.courses;
  }

  if (!inFlight) {
    inFlight = fetchCourses()
      .then((courses) => {
        cache = { courses, fetchedAt: now };
        return courses;
      })
      .catch((err) => {
        console.error("Error fetching courses:", err);
        return cache.courses;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}

export function formatCoursesForPrompt(courses) {
  return courses
    .map((c) => {
      const suffix = c.status && c.status !== "Inscripción Abierta" ? ` (${c.status})` : "";
      return `- ${c.title}${suffix}: ${c.url}`;
    })
    .join("\n");
}
