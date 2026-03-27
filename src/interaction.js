import { sendText } from "./api-client.js";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// userId → { resolve, reject, type, options, timeoutTimer }
const pendingInteractions = new Map();

export function hasPendingInteraction(fromUser) {
  return pendingInteractions.has(fromUser);
}

export function cancelInteraction(fromUser, reason) {
  const entry = pendingInteractions.get(fromUser);
  if (!entry) return;
  clearTimeout(entry.timeoutTimer);
  pendingInteractions.delete(fromUser);
  entry.reject(new Error(reason || "cancelled"));
}

export async function requestUserInput({ cfg, toUser, type, prompt, options, logger }) {
  if (pendingInteractions.has(toUser)) {
    cancelInteraction(toUser, "superseded");
  }

  let textMessage;
  if (type === "choice" && Array.isArray(options) && options.length > 0) {
    const numbered = options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    textMessage = `${prompt}\n\n请回复数字选择：\n${numbered}`;
  } else if (type === "confirm") {
    textMessage = `${prompt}\n\n请回复"是"或"否"确认。`;
  } else {
    textMessage = `${prompt}\n\n请直接输入您的回答：`;
  }
  await sendText({ cfg, toUser, text: textMessage, logger });

  return new Promise((resolve, reject) => {
    const timeoutTimer = setTimeout(async () => {
      pendingInteractions.delete(toUser);
      try {
        await sendText({ cfg, toUser, text: "⏰ 操作超时，请重新发起。", logger });
      } catch {
        // best-effort
      }
      reject(new Error("interaction timeout"));
    }, TIMEOUT_MS);

    pendingInteractions.set(toUser, {
      resolve,
      reject,
      type,
      options: options || null,
      timeoutTimer,
    });
  });
}

export function resolveInteraction({ fromUser, reply }) {
  const entry = pendingInteractions.get(fromUser);
  if (!entry) return false;
  if (reply == null) return false;

  const trimmed = reply.trim();

  if (entry.type === "choice") {
    const num = parseInt(trimmed, 10);
    if (isNaN(num) || num < 1 || !entry.options || num > entry.options.length) {
      return "retry";
    }
    clearTimeout(entry.timeoutTimer);
    pendingInteractions.delete(fromUser);
    entry.resolve({ value: entry.options[num - 1], raw: trimmed, type: "text" });
    return true;
  }

  if (entry.type === "confirm") {
    const lower = trimmed.toLowerCase();
    if (lower === "是" || lower === "yes" || lower === "y" || lower === "1") {
      clearTimeout(entry.timeoutTimer);
      pendingInteractions.delete(fromUser);
      entry.resolve({ value: true, raw: trimmed, type: "text" });
      return true;
    }
    if (lower === "否" || lower === "no" || lower === "n" || lower === "0") {
      clearTimeout(entry.timeoutTimer);
      pendingInteractions.delete(fromUser);
      entry.resolve({ value: false, raw: trimmed, type: "text" });
      return true;
    }
    return "retry";
  }

  // type === "text" — any reply is valid
  clearTimeout(entry.timeoutTimer);
  pendingInteractions.delete(fromUser);
  entry.resolve({ value: trimmed, raw: trimmed, type: "text" });
  return true;
}
