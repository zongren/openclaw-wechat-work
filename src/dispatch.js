import { sendText } from "./api-client.js";
import { requestUserInput, cancelInteraction } from "./interaction.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as sessionManager from "./session-manager.js";

// ── Per-user in-memory state ──────────────────────────────────────────────────
const reasoningMode = new Map(); // userId → boolean
const feedbackMode  = new Map(); // userId → boolean
const runIdToUser       = new Map(); // runId → userId (for hook cross-referencing)
const activeDispatches  = new Map(); // fromUser → true (users with in-flight dispatches)
const lastActivity  = new Map(); // userId → timestamp

// Multi-session state:
// userId → { active: sessionName|null, sessions: Map<name, { processSessionId, startedAt, tool }> }
const userSessionStore = new Map();

function getUserStore(userId) {
  if (!userSessionStore.has(userId)) {
    userSessionStore.set(userId, { active: null, sessions: new Map() });
  }
  return userSessionStore.get(userId);
}

// ── Session registry (used by process-hooks.js) ───────────────────────────────

export function getActiveSession(userId) {
  const store = getUserStore(userId);
  if (!store.active) return null;
  return store.sessions.get(store.active) || null;
}

export function clearActiveSession(userId) {
  const store = getUserStore(userId);
  store.active = null;
}

export function findUserByProcessSession(processSessionId) {
  for (const [userId, store] of userSessionStore.entries()) {
    for (const session of store.sessions.values()) {
      if (session.processSessionId === processSessionId) return userId;
    }
  }
  return null;
}

export function registerProcessSession(userId, processSessionId) {
  // Called from process-hooks when exec creates a PTY session.
  // We store it under a pending slot if one exists, else auto-name it.
  const store = getUserStore(userId);
  const pendingName = store._pendingName || `session-${processSessionId.slice(0, 8)}`;
  delete store._pendingName;
  store.sessions.set(pendingName, {
    processSessionId,
    startedAt: Date.now(),
    tool: store._pendingTool || "claude",
  });
  delete store._pendingTool;
  store.active = pendingName;
}

export function registerRunId(runId, userId) {
  runIdToUser.set(runId, userId);
}

export function findUserByRunId(runId) {
  return runIdToUser.get(runId) || null;
}

export function getActiveDispatchUsers() {
  return [...activeDispatches.keys()];
}

export function clearRunId(runId) {
  runIdToUser.delete(runId);
}

// ── Process session detection helpers (legacy, kept for fallback) ─────────────

function detectProcessSession(text) {
  const m = text.match(/session(?:\s+ID)?[:\s]*`([^`]+)`/i);
  return m ? m[1] : null;
}

function detectSessionEnd(text) {
  return /session\s+(ended|closed|terminated|exited)/i.test(text);
}

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

  // Show tmux CLI sessions from session-manager
  const sessions = sessionManager.listSessions(fromUser);
  if (sessions.length > 0) {
    lines.push(``);
    lines.push(`🖥️ CLI 会话 (${sessions.length}个):`);
    for (const s of sessions) {
      const marker = s.active ? "▶" : "·";
      const status = s.dead ? "✗ 已结束" : "✓";
      lines.push(`  ${marker} [${s.name}] ${s.tool}  ${s.uptime}  ${status}`);
    }
  }

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
    `• /status — 查看服务状态\n` +
    `• /spawn [名称] [命令] — 启动后台 CLI 会话\n` +
    `• /list — 列出所有后台会话\n` +
    `• /switch <名称> — 切换到指定会话\n` +
    `• /kill <名称> — 终止指定会话\n` +
    `• /exit — 退出当前会话\n\n` +
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
    api.logger?.info?.("wechat_work: exiting process for restart");
    process.exit(0);
  }, 1000);
  return null;
}

// ── PTY session commands (delegate to session-manager) ────────────────────────

function handleList({ fromUser }) {
  const sessions = sessionManager.listSessions(fromUser);
  if (sessions.length === 0) {
    return "📭 当前没有 CLI 会话。\n发送 /claude [名称] 启动一个。";
  }
  const lines = [`🖥️ CLI 会话 (${sessions.length}个):\n`];
  for (const s of sessions) {
    const marker = s.active ? "▶ 【当前】" : "·";
    const status = s.dead ? " ✗ 已结束" : "";
    lines.push(`${marker} ${s.name}`);
    lines.push(`  工具：${s.tool}  运行时长：${s.uptime}${status}`);
  }
  lines.push(`\n发送 /switch <名称> 切换会话，/kill <名称> 终止会话，/exit 退出转发模式。`);
  return lines.join("\n");
}

async function handleSwitch({ fromUser, args }) {
  const name = args.trim();
  if (!name) return "⚠️ 用法：/switch <名称>";
  try {
    await sessionManager.switchSession(fromUser, name);
    return `✅ 已切换到会话 "${name}"。\n输入消息将直接发送到此会话。\n发送 /exit 退出转发模式。`;
  } catch (err) {
    return `❌ ${err.message}`;
  }
}

async function handleKill({ fromUser, args }) {
  const name = args.trim();
  if (!name) return "⚠️ 用法：/kill <名称>";
  try {
    await sessionManager.killSession(fromUser, name);
    return `🗑️ 已终止会话 "${name}"。`;
  } catch (err) {
    return `❌ ${err.message}`;
  }
}

// handleSpawn: set pending metadata so registerProcessSession can name the session
function handleSpawn({ fromUser, args }) {
  // args format: "[name] [command]"  e.g. "myproject claude" or just "myproject"
  const parts = args.trim().split(/\s+/);
  const name  = parts[0] || `session-${Date.now().toString(36)}`;
  const tool  = parts[1] || "claude";
  const store = getUserStore(fromUser);
  if (store.sessions.has(name)) {
    return `⚠️ 会话 "${name}" 已存在。请先 /kill ${name} 或选择其他名称。`;
  }
  // Set pending slot so registerProcessSession picks up the right name
  store._pendingName = name;
  store._pendingTool = tool;
  // Return null → falls through to AI dispatch with a spawn directive
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
  // ── Active tmux session intercept ────────────────────────────────────────
  // If user has an active direct CLI session, route non-command messages to it
  // and bypass the AI dispatcher entirely.
  const text0 = (messageText || "").trim();
  const lower0 = text0.toLowerCase();
  const activeSession = sessionManager.getActiveSession(fromUser);
  if (activeSession && !lower0.startsWith("/")) {
    try {
      await sessionManager.sendInput(fromUser, text0);
    } catch (err) {
      await sendText({ cfg, toUser: fromUser, text: `❌ ${err.message}`, logger: api.logger });
    }
    return;
  }

  // ── Command routing ───────────────────────────────────────────────────────
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

  if (lower === "/exit") {
    sessionManager.exitSession(fromUser);
    await sendText({ cfg, toUser: fromUser, text: "✅ 已退出转发模式，恢复正常 AI 对话。", logger: api.logger });
    return;
  }

  if (lower.startsWith("/claude")) {
    const parts = text.trim().split(/\s+/);
    const name = parts[1] || undefined; // session-manager auto-generates if undefined
    try {
      const { name: finalName } = await sessionManager.spawnSession(fromUser, name, "useclaude", ["zqsy_codeclub3"]);
      await sendText({
        cfg,
        toUser: fromUser,
        text: `🚀 正在启动 [${finalName}]... Claude Code 准备好后将自动发送输出。\n发送 /exit 退出转发模式。`,
        logger: api.logger,
      });
    } catch (err) {
      await sendText({ cfg, toUser: fromUser, text: `❌ ${err.message}`, logger: api.logger });
    }
    return;
  }

  if (lower === "/list") {
    const reply = handleList({ fromUser });
    await sendText({ cfg, toUser: fromUser, text: reply, logger: api.logger });
    return;
  }

  if (lower.startsWith("/switch")) {
    const args = text.slice("/switch".length).trim();
    const reply = await handleSwitch({ fromUser, args });
    await sendText({ cfg, toUser: fromUser, text: reply, logger: api.logger });
    return;
  }

  if (lower.startsWith("/kill")) {
    const args = text.slice("/kill".length).trim();
    const reply = await handleKill({ fromUser, args });
    await sendText({ cfg, toUser: fromUser, text: reply, logger: api.logger });
    return;
  }

  if (lower.startsWith("/spawn")) {
    const args = text.slice("/spawn".length).trim();
    const spawnReply = handleSpawn({ fromUser, args });
    if (spawnReply) {
      await sendText({ cfg, toUser: fromUser, text: spawnReply, logger: api.logger });
      return;
    }
    // fall through to AI with spawn directive injected
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

async function dispatchAI({ api, cfg, sessionId, fromUser, messageText, msgId, runId }) {
  const store = getUserStore(fromUser);
  const useReasoning = reasoningMode.get(fromUser) ?? false;

  // Use per-user session override if set by /new, else fall back to webhook-derived key
  const effectiveSessionId = sessionOverrides.get(fromUser) || sessionId;

  // Inject spawn directive if pending
  let finalText = messageText;
  if (store._pendingName) {
    const name = store._pendingName;
    const tool = store._pendingTool ?? "claude";
    delete store._pendingName;
    delete store._pendingTool;
    finalText = `[SPAWN_SESSION name=${JSON.stringify(name)} tool=${JSON.stringify(tool)}]\n${messageText}`;
  }

  lastActivity.set(fromUser, Date.now());

  const timestamp = Date.now();
  const commandBody = finalText.startsWith("/") ? finalText : "";
  const commandAuthorized = Boolean(commandBody);
  const effectiveCommandBody = useReasoning && !commandBody
    ? "/think " + finalText
    : commandBody || "";

  const ctx = {
    Body:             finalText,
    BodyForAgent:     finalText,
    BodyForCommands:  commandAuthorized ? commandBody : "",
    RawBody:          finalText,
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
    await sendText({ cfg, toUser: fromUser, text, logger: api.logger });
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

  activeDispatches.set(fromUser, true);
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
  } finally {
    activeDispatches.delete(fromUser);
    // Clean up runId correlation to prevent Map growth
    if (runId) clearRunId(runId);
  }
}
