import crypto from "node:crypto";
import { config } from "./config.js";

const GRAPH_API_BASE = `https://graph.facebook.com/${config.graphApiVersion}`;

export function isValidSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !rawBody) return false;

  const expected = crypto
    .createHmac("sha256", config.whatsappAppSecret)
    .update(rawBody)
    .digest();

  // Buffer.from(..., "hex") silently truncates on malformed input, so a
  // junk header yields a short buffer rather than throwing here.
  const received = Buffer.from(signatureHeader.replace("sha256=", ""), "hex");

  // timingSafeEqual THROWS when the lengths differ, and this runs outside
  // any try/catch in server.js — without this guard, one malformed
  // signature header crashes the whole process.
  if (received.length !== expected.length) return false;

  return crypto.timingSafeEqual(expected, received);
}

export async function sendTextMessage(to, text) {
  const url = `${GRAPH_API_BASE}/${config.whatsappPhoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`WhatsApp API error (${res.status}): ${errorBody}`);
  }

  return res.json();
}

// The only way to message someone who has never written in — WhatsApp
// requires an approved template for that, free-form text is rejected.
// `params` fill the template's {{1}}, {{2}}... body variables, in order.
export async function sendTemplateMessage(to, templateName, params = [], languageCode = "es_AR") {
  const url = `${GRAPH_API_BASE}/${config.whatsappPhoneNumberId}/messages`;

  const template = { name: templateName, language: { code: languageCode } };
  if (params.length) {
    template.components = [
      { type: "body", parameters: params.map((text) => ({ type: "text", text })) },
    ];
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`WhatsApp API error (${res.status}): ${errorBody}`);
  }

  return res.json();
}

// Message types that arrive as a media_id rather than inline content.
// 'sticker' is included because it is just a webp image as far as we care.
const MEDIA_TYPES = new Set(["image", "document", "audio", "video", "sticker"]);

// A media message carries no bytes — only an id to resolve later, and
// (sometimes) a caption. Two-step download, and the id itself expires after
// 7 days, which is why server.js fetches immediately rather than on demand.
export async function downloadMedia(mediaId) {
  const lookup = await fetch(`${GRAPH_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${config.whatsappToken}` },
  });
  if (!lookup.ok) {
    throw new Error(`WhatsApp media lookup failed (${lookup.status}): ${await lookup.text()}`);
  }

  const { url, mime_type: mimeType, file_size: fileSize } = await lookup.json();

  if (fileSize && Number(fileSize) > config.mediaMaxBytes) {
    const err = new Error(`Archivo de ${Math.round(Number(fileSize) / 1e6)} MB, por encima del límite.`);
    err.code = "MEDIA_TOO_LARGE";
    throw err;
  }

  // That URL looks like a plain CDN link but still needs the bearer token,
  // which is exactly why the browser can't load it from an <img> tag and the
  // inbox has to proxy it.
  const file = await fetch(url, {
    headers: { Authorization: `Bearer ${config.whatsappToken}` },
  });
  if (!file.ok) {
    throw new Error(`WhatsApp media download failed (${file.status})`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > config.mediaMaxBytes) {
    const err = new Error(`Archivo de ${Math.round(buffer.length / 1e6)} MB, por encima del límite.`);
    err.code = "MEDIA_TOO_LARGE";
    throw err;
  }

  return { buffer, mimeType: mimeType || "application/octet-stream" };
}

// Returns { type: "message", from, text, media } for a customer message,
// { type: "echo", to, text } for a message an employee sent from the
// WhatsApp Business app (only present when coexistence is enabled),
// or null if the payload doesn't contain an event we care about.
// `media` is null for plain text; for a media message `text` holds the
// caption, which is often empty.
export function parseWebhookEvent(payload) {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field === "messages") {
        const message = change.value?.messages?.[0];
        if (message?.type === "text") {
          return { type: "message", from: message.from, text: message.text.body, media: null };
        }

        if (MEDIA_TYPES.has(message?.type)) {
          const content = message[message.type] ?? {};
          if (content.id) {
            return {
              type: "message",
              from: message.from,
              text: content.caption ?? "",
              media: {
                id: content.id,
                kind: message.type,
                mimeType: content.mime_type ?? "application/octet-stream",
                filename: content.filename ?? null,
              },
            };
          }
        }
      }

      if (change.field === "smb_message_echoes") {
        const echo = change.value?.message_echoes?.[0];
        if (echo?.type === "text") {
          return { type: "echo", to: echo.to, text: echo.text.body };
        }
      }
    }
  }

  return null;
}
