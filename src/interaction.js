import crypto from "node:crypto";
import { sendText, sendTemplateCard } from "./api-client.js";

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// userId → { resolve, reject, type, options, taskId, timeoutTimer }
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
  // Cancel any existing pending interaction for this user
  if (pendingInteractions.has(toUser)) {
    cancelInteraction(toUser, "superseded");
  }

  const taskId = crypto.randomUUID();

  // Try template card first (best UX — tappable buttons)
  let cardSent = false;
  if (type === "choice" && Array.isArray(options) && options.length > 0) {
    try {
      const buttonList = options.map((opt, i) => ({
        text: opt.slice(0, 32),   // button text max ~32 chars
        style: 1,
        key: `choice_${i + 1}`,
      }));
      await sendTemplateCard({
        cfg,
        toUser,
        templateCard: {
          card_type: "button_interaction",
          task_id: taskId,
          main_title: { title: prompt.slice(0, 128) },
          button: { button_list: buttonList },
        },
        logger,
      });
      cardSent = true;
    } catch (err) {
      logger?.info?.(`wechat_work: template card send failed, using text fallback: ${String(err?.message || err)}`);
    }
  } else if (type === "confirm") {
    try {
      await sendTemplateCard({
        cfg,
        toUser,
        templateCard: {
          card_type: "button_interaction",
          task_id: taskId,
          main_title: { title: prompt.slice(0, 128) },
          button: {
            button_list: [
              { text: "是", style: 1, key: "confirm_yes" },
              { text: "否", style: 2, key: "confirm_no" },
            ],
          },
        },
        logger,
      });
      cardSent = true;
    } catch (err) {
      logger?.info?.(`wechat_work: template card send failed, using text fallback: ${String(err?.message || err)}`);
    }
  }

  // Text fallback — only when card failed or for free-text prompts
  if (!cardSent) {
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
  }

  // Create Promise and store pending entry
  return new Promise((resolve, reject) => {
    const timeoutTimer = setTimeout(async () => {
      pendingInteractions.delete(toUser);
      try {
        await sendText({ cfg, toUser, text: "⏰ 操作超时，请重新发起。", logger });
      } catch {
        // best-effort timeout notification
      }
      reject(new Error("interaction timeout"));
    }, TIMEOUT_MS);

    pendingInteractions.set(toUser, {
      resolve,
      reject,
      type,
      options: options || null,
      taskId,
      timeoutTimer,
    });
  });
}

export function resolveInteraction({ fromUser, reply, eventKey, taskId }) {
  const entry = pendingInteractions.get(fromUser);
  if (!entry) return false;

  // Template card event — verify taskId matches
  if (eventKey) {
    if (taskId && entry.taskId !== taskId) return false; // stale card

    if (entry.type === "choice") {
      const match = eventKey.match(/^choice_(\d+)$/);
      if (match) {
        const idx = parseInt(match[1], 10) - 1;
        if (entry.options && idx >= 0 && idx < entry.options.length) {
          clearTimeout(entry.timeoutTimer);
          pendingInteractions.delete(fromUser);
          entry.resolve({ value: entry.options[idx], raw: eventKey, type: "card" });
          return true;
        }
      }
    } else if (entry.type === "confirm") {
      if (eventKey === "confirm_yes" || eventKey === "confirm_no") {
        clearTimeout(entry.timeoutTimer);
        pendingInteractions.delete(fromUser);
        entry.resolve({ value: eventKey === "confirm_yes", raw: eventKey, type: "card" });
        return true;
      }
    }
    return false;
  }

  // Text reply
  if (reply == null) return false;
  const trimmed = reply.trim();

  if (entry.type === "choice") {
    const num = parseInt(trimmed, 10);
    if (isNaN(num) || num < 1 || !entry.options || num > entry.options.length) {
      return "retry"; // invalid — hint will be sent by caller or we handle here
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
