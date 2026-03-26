import { sendText, sendMarkdown } from "./api-client.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ── Per-user in-memory state ──────────────────────────────────────────────────
const reasoningMode = new Map(); // userId → boolean
const feedbackMode  = new Map(); // userId → boolean
const lastActivity  = new Map(); // userId → timestamp

// Path where feedback is appended
const FEEDBACK_FILE = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "memory",
  "wechat-feedback.md"
);

// Per-user custom session keys for /new (fresh AI conversations)
const sessionOverrides = new Map(); // userId → sessionKey

// ── Local command handlers ────────────────────────────────────────────────────

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}小时`);
  parts.push(`${m}分钟`);
  return parts.join("");
}

async function handleStatus({ api, cfg, fromUser, sessionId }) {
  const lines = [];

  let model = "Claude";
  let lastStr = null;
  try {
    const sessions = await api.runtime?.sessions?.list?.();
    const session  = sessions?.find?.(
      (s) => s.sessionKey === sessionId || s.key === sessionId
    );
    if (session) {
      model = session.model || session.modelId || model;
      const lastAt = session.lastActivityAt || session.updatedAt || session.createdAt;
      if (lastAt) {
        lastStr = new Date(lastAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      }
    }
  } catch {
    // runtime API unavailable
  }

  lines.push(`✅ 服务运行正常`);
  lines.push(`🤖 模型：${model}`);
  lines.push(`📡 频道：企业微信`);

  const uptime = formatUptime(process.uptime());
  lines.push(`⏱️ 运行时长：${uptime}`);
  lines.push(`📦 Node.js：${process.version}`);

  const mem  = process.memoryUsage();
  const rss  = (mem.rss / 1024 / 1024).toFixed(1);
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
  lines.push(`💾 内存：${rss} MB (堆: ${heap} MB)`);

  const reasoning = reasoningMode.get(fromUser) ?? false;
  const feedback  = feedbackMode.get(fromUser) ?? false;
  lines.push(`🧠 推理模式：${reasoning ? "开启" : "关闭"}`);
  lines.push(`📝 反馈模式：${feedback ? "等待输入" : "关闭"}`);

  if (lastStr) lines.push(`🕐 最近活跃：${lastStr}`);
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  lines.push(`📅 查询时间：${now}`);

  return lines.join("\n");
}

async function handleReasoning({ fromUser }) {
  const current = reasoningMode.get(fromUser) ?? false;
  const next    = !current;
  reasoningMode.set(fromUser, next);
  return next
    ? "🧠 推理模式已开启 — 回答将更深入，速度稍慢。"
    : "💡 推理模式已关闭 — 回答恢复正常模式。";
}

function handleAbout() {
  return (
    `🤖 OpenClaw 企业微信助手\n\n` +
    `由 OpenClaw 驱动的 AI 对话助手，接入企业微信自建应用。\n\n` +
    `✨ 功能：\n` +
    `• 智能对话 — 直接发消息即可\n` +
    `• /new — 开启全新会话\n` +
    `• /clear — 清空上下文\n` +
    `• /reasoning — 深度思考模式\n` +
    `• /status — 查看服务状态\n\n` +
    `📖 文档：https://docs.openclaw.ai\n` +
    `💬 社区：https://discord.com/invite/clawd`
  );
}

async function handleFeedback({ fromUser }) {
  feedbackMode.set(fromUser, true);
  return "📝 请输入您的反馈内容，下一条消息将作为反馈提交。";
}

async function handleNew({ fromUser }) {
  // Create a fresh session key so subsequent AI dispatches start a new conversation
  const newKey = `wechat_work:${fromUser}:${Date.now()}`;
  sessionOverrides.set(fromUser, newKey);
  return "🆕 已开启新会话，上下文已清空。";
}

async function handleRestart({ api, cfg, fromUser }) {
  api.logger?.info?.(`wechat_work: restart requested by user=${fromUser}`);
  try {
    await sendText({ cfg, toUser: fromUser, text: "🔄 正在重启网关，请稍候...", logger: api.logger });
  } catch {
    // best-effort
  }
  setTimeout(() => {
    api.logger?.info?.("wechat_work: restarting process");
    // Spawn a detached copy of ourselves, then exit — works on macOS without a process manager
    const child = spawn(process.argv[0], process.argv.slice(1), {
      detached: true,
      stdio: "inherit",
      env: process.env,
    });
    child.unref();
    process.exit(0);
  }, 1000);
  return null;
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

export async function dispatchToAgent({
  api,
  cfg,
  sessionId,
  fromUser,
  messageText,
  commandBody,
  msgId,
}) {
  const text = (messageText || "").trim();
  const lower = text.toLowerCase();

  if (lower === "/new" || lower === "/clear") {
    const reply = await handleNew({ fromUser });
    await sendText({ cfg, toUser: fromUser, text: reply, logger: api.logger });
    return;
  }

  if (lower === "/status") {
    const reply = await handleStatus({ api, cfg, fromUser, sessionId });
    await sendText({ cfg, toUser: fromUser, text: reply, logger: api.logger });
    return;
  }

  if (lower === "/reasoning") {
    const reply = await handleReasoning({ fromUser });
    await sendText({ cfg, toUser: fromUser, text: reply, logger: api.logger });
    return;
  }

  if (lower === "/about" || lower === "/help") {
    const reply = handleAbout();
    await sendText({ cfg, toUser: fromUser, text: reply, logger: api.logger });
    return;
  }

  if (lower === "/feedback") {
    const reply = await handleFeedback({ fromUser });
    await sendText({ cfg, toUser: fromUser, text: reply, logger: api.logger });
    return;
  }

  if (lower === "/restart") {
    await handleRestart({ api, cfg, fromUser });
    return;
  }

  // ── Feedback intercept ────────────────────────────────────────────────────
  if (feedbackMode.get(fromUser)) {
    feedbackMode.set(fromUser, false);
    api.logger?.info?.(`wechat_work: feedback from user=${fromUser}: ${text}`);
    await sendText({ cfg, toUser: fromUser, text: "✅ 感谢您的反馈，已记录！", logger: api.logger });
    return;
  }

  // ── AI dispatch ───────────────────────────────────────────────────────────
  await dispatchAI({ api, cfg, sessionId, fromUser, messageText: text, msgId });
}

async function dispatchAI({ api, cfg, sessionId, fromUser, messageText, msgId }) {
  const useReasoning = reasoningMode.get(fromUser) ?? false;

  // Use per-user session override if set by /new, else fall back to webhook-derived key
  const effectiveSessionId = sessionOverrides.get(fromUser) || sessionId;

  lastActivity.set(fromUser, Date.now());

  const timestamp = Date.now();
  const commandBody = messageText.startsWith("/") ? messageText : "";
  const commandAuthorized = Boolean(commandBody);
  const effectiveCommandBody = useReasoning && !commandBody
    ? "/think " + messageText
    : commandBody || "";

  const ctx = {
    Body:             messageText,
    BodyForAgent:     messageText,
    BodyForCommands:  commandAuthorized ? commandBody : "",
    RawBody:          messageText,
    CommandBody:      effectiveCommandBody,
    CommandAuthorized: commandAuthorized,
    CommandSource:    commandAuthorized ? "text" : "",
    From:             fromUser,
    To:               fromUser,
    SessionKey:       effectiveSessionId,
    AccountId:        "default",
    ChatType:         "direct",
    ConversationLabel: fromUser,
    SenderName:       fromUser,
    SenderId:         String(fromUser ?? "").trim().toLowerCase(),
    Provider:         "wechat_work",
    Surface:          "wechat_work",
    MessageSid:       msgId || `wechat_work-${timestamp}`,
    Timestamp:        timestamp,
    OriginatingChannel: "wechat_work",
    OriginatingTo:    fromUser,
    ...(useReasoning ? { ReasoningMode: true } : {}),
  };

  const deliver = async (payload, info) => {
    const text = typeof payload === "string" ? payload : payload?.text;
    if (!text) return;
    if (info?.kind === "block") return;
    await sendMarkdown({ cfg, toUser: fromUser, text, logger: api.logger });
  };

  const onError = async (err) => {
    api.logger?.error?.(`wechat_work: dispatch error for session=${effectiveSessionId}: ${String(err?.message || err)}`);
    try {
      await sendText({
        cfg,
        toUser: fromUser,
        text: "抱歉，处理消息时出现了错误，请稍后重试。",
        logger: api.logger,
      });
    } catch (sendErr) {
      api.logger?.error?.(`wechat_work: failed to send error message: ${String(sendErr?.message || sendErr)}`);
    }
  };

  try {
    await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg: api.config,
      dispatcherOptions: {
        deliver,
        onError,
      },
      replyOptions: {
        disableBlockStreaming: true,
        routeOverrides: {
          sessionKey: effectiveSessionId,
          accountId: "default",
        },
      },
    });
  } catch (err) {
    await onError(err);
  }
}
