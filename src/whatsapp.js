import crypto from "node:crypto";
import { config } from "./config.js";

const GRAPH_API_BASE = "https://graph.facebook.com/v20.0";

export function isValidSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac("sha256", config.whatsappAppSecret)
    .update(rawBody)
    .digest("hex");

  const received = signatureHeader.replace("sha256=", "");

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(received, "hex")
  );
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

// Returns { type: "message", from, text } for a customer message,
// { type: "echo", to, text } for a message an employee sent from the
// WhatsApp Business app (only present when coexistence is enabled),
// or null if the payload doesn't contain a text event we care about.
export function parseWebhookEvent(payload) {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field === "messages") {
        const message = change.value?.messages?.[0];
        if (message?.type === "text") {
          return { type: "message", from: message.from, text: message.text.body };
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
