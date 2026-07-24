import { config } from "./config.js";

const MAX_TURNS = 10;
const conversations = new Map();

function isNewSession(convo, now) {
  return !convo || now - convo.lastMessageAt > config.sessionGapMs;
}

export function registerInboundMessage(waId, now = Date.now()) {
  let convo = conversations.get(waId);
  if (isNewSession(convo, now)) {
    convo = { firstMessageAt: now, lastMessageAt: now, handedOff: false, turns: [] };
    conversations.set(waId, convo);
  } else {
    convo.lastMessageAt = now;
  }
  return convo;
}

export function markHandedOff(waId, now = Date.now()) {
  const convo = conversations.get(waId) ?? registerInboundMessage(waId, now);
  convo.handedOff = true;
}

export function shouldBotRespond(waId, now = Date.now()) {
  const convo = conversations.get(waId);
  if (!convo || convo.handedOff) return false;
  return now - convo.firstMessageAt <= config.responseWindowMs;
}

export function getHistory(waId) {
  return conversations.get(waId)?.turns ?? [];
}

export function appendTurn(waId, userText, botText) {
  const convo = conversations.get(waId);
  if (!convo) return;
  convo.turns.push({ role: "user", text: userText }, { role: "model", text: botText });
  convo.turns = convo.turns.slice(-MAX_TURNS * 2);
}
