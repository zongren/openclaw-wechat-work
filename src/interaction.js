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

  // Try vote_interaction card (single-select radio list — works where button_interaction fails)
  let cardSent = false;
  if (type === "choice" && Array.isArray(options) && options.length > 0) {
    try {
      await sendTemplateCard({
        cfg,
        toUser,
        templateCard: {
          card_type: "vote_interaction",
          task_id: taskId,
          main_title: { title: prompt.slice(0, 128) },
          checkbox: {
            question_key: taskId,
            option_list: options.map((opt, i) => ({
              id: String(i + 1),
              text: opt.slice(0, 128),
              is_checked: false,
            })),
            mode: 0,  // 0 = single select (radio)
          },
          submit_button: { text: "确认", key: "submit" },
        },
        logger,
      });
      cardSent = true;
    } catch (err) {
      logger?.info?.(`wechat_work: vote_interaction card failed, using text fallback: ${String(err?.message || err)}`);
    }
  } else if (type === "confirm") {
    try {
      await sendTemplateCard({
        cfg,
        toUser,
        templateCard: {
          card_type: "vote_interaction",
          task_id: taskId,
          main_title: { title: prompt.slice(0, 128) },
          checkbox: {
            question_key: taskId,
            option_list: [
              { id: "yes", text: "是", is_checked: false },
              { id: "no",  text: "否", is_checked: false },
            ],
            mode: 0,
          },
          submit_button: { text: "确认", key: "submit" },
        },
        logger,
      });
      cardSent = true;
    } catch (err) {
      logger?.info?.(`wechat_work: vote_interaction card failed, using text fallback: ${String(err?.message || err)}`);
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

export function resolveInteraction({ fromUser, reply, eventKey, taskId, selectedOptionId }) {
  const entry = pendingInteractions.get(fromUser);
  if (!entry) return false;

  // Template card event (vote_interaction submit or button_interaction click)
  if (eventKey || selectedOptionId) {
    if (taskId && entry.taskId !== taskId) return false; // stale card

    // vote_interaction: selectedOptionId is the option's `id` field (1-based index string or "yes"/"no")
    const optionId = selectedOptionId || eventKey;

    if (entry.type === "choice") {
      // vote_interaction uses numeric id strings ("1", "2", ...)
      const idx = parseInt(optionId, 10) - 1;
      if (!isNaN(idx) && entry.options && idx >= 0 && idx < entry.options.length) {
        clearTimeout(entry.timeoutTimer);
        pendingInteractions.delete(fromUser);
        entry.resolve({ value: entry.options[idx], raw: optionId, type: "card" });
        return true;
      }
      // Fallback: button_interaction choice_N style
      const match = optionId.match(/^choice_(\d+)$/);
      if (match) {
        const idx2 = parseInt(match[1], 10) - 1;
        if (entry.options && idx2 >= 0 && idx2 < entry.options.length) {
          clearTimeout(entry.timeoutTimer);
          pendingInteractions.delete(fromUser);
          entry.resolve({ value: entry.options[idx2], raw: optionId, type: "card" });
          return true;
        }
      }
    } else if (entry.type === "confirm") {
      // vote_interaction uses "yes"/"no" ids
      if (optionId === "yes" || optionId === "confirm_yes") {
        clearTimeout(entry.timeoutTimer);
        pendingInteractions.delete(fromUser);
        entry.resolve({ value: true, raw: optionId, type: "card" });
        return true;
      }
      if (optionId === "no" || optionId === "confirm_no") {
        clearTimeout(entry.timeoutTimer);
        pendingInteractions.delete(fromUser);
        entry.resolve({ value: false, raw: optionId, type: "card" });
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
