import { sendText } from "./api-client.js";
import fs from "node:fs/promises";
import path from "node:path";

// ── Per-user in-memory state ──────────────────────────────────────────────────
const reasoningMode = new Map(); // userId → boolean
const feedbackMode  = new Map(); // userId → boolean

// Path where feedback is appended
const FEEDBACK_FILE = path.join(
  "C:\\home\\zongren\\.openclaw\\workspace\\memory",
  "wechat-feedback.md"
);

// ── Local command handlers ────────────────────────────────────────────────────

async function handleStatus({ api, cfg, fromUser, sessionId }) {
  let text;
  try {
    // Try to get real session info from the runtime
    const sessions = await api.runtime?.sessions?.list?.();
    const session  = sessions?.find?.(
      (s) => s.sessionKey === sessionId || s.key === sessionId
    );

    if (session) {
      const model    = session.model || session.modelId || "Claude";
      const lastAt   = session.lastActivityAt || session.updatedAt || session.createdAt;
      const lastStr  = lastAt
        ? new Date(lastAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
        : "未知";
      text =
        `✅ 服务运行正常\n` +
        `🤖 模型：${model}\n` +
        `📡 频道：企业微信\n` +
        `🕐 最近活跃：${lastStr}`;
    } else {
      throw new Error("session not found");
    }
  } catch {
    // Fallback — runtime API doesn't expose what we need
    text =
      `✅ 服务运行正常\n` +
      `🤖 模型：Claude\n` +
      `📡 频道：企业微信`;
  }
  return text;
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
  const normalizedCommand = (commandBody || "").trim().split(/\s+/)[0].toLowerCase();
  const isCommand = Boolean(normalizedCommand);

  // ── Feedback intercept: if the user is in feedback mode, capture next message
  if (!isCommand && feedbackMode.get(fromUser)) {
    feedbackMode.set(fromUser, false);
    try {
      const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      const entry     = `\n## ${timestamp}\n\n${messageText}\n`;
      await fs.mkdir(path.dirname(FEEDBACK_FILE), { recursive: true });
      await fs.appendFile(FEEDBACK_FILE, entry, "utf8");
    } catch (err) {
      api.logger?.error?.(`wechat_work: failed to write feedback: ${String(err?.message || err)}`);
    }
    try {
      await sendText({ cfg, toUser: fromUser, text: "✅ 感谢您的反馈，已记录！", logger: api.logger });
    } catch (err) {
      api.logger?.error?.(`wechat_work: failed to send feedback ack: ${String(err?.message || err)}`);
    }
    return;
  }

  // ── Local commands
  if (isCommand) {
    let replyText;

    switch (normalizedCommand) {
      case "/status":
        replyText = await handleStatus({ api, cfg, fromUser, sessionId });
        break;

      case "/reasoning":
        replyText = await handleReasoning({ fromUser });
        break;

      case "/about":
        replyText = handleAbout();
        break;

      case "/feedback":
        replyText = await handleFeedback({ fromUser });
        break;

      default:
        replyText = null; // not a local command — fall through to AI runtime
    }

    if (replyText !== null) {
      api.logger?.info?.(`wechat_work: local command from=${fromUser} cmd=${normalizedCommand}`);
      try {
        await sendText({ cfg, toUser: fromUser, text: replyText, logger: api.logger });
      } catch (err) {
        api.logger?.error?.(`wechat_work: failed to send local command reply: ${String(err?.message || err)}`);
      }
      return;
    }
  }

  // ── Regular AI dispatch ───────────────────────────────────────────────────

  const timestamp       = Date.now();
  const commandAuthorized = Boolean(commandBody);

  // If reasoning mode is on, signal the runtime via CommandBody prefix
  const useReasoning = reasoningMode.get(fromUser) ?? false;
  const effectiveCommandBody = useReasoning && !commandBody
    ? "/think " + messageText   // hint: ask runtime to use extended thinking
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
    SessionKey:       sessionId,
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
    // Reasoning flag — runtimes that support it can pick this up
    ...(useReasoning ? { ReasoningMode: true } : {}),
  };

  const deliver = async (payload, info) => {
    const text = typeof payload === "string" ? payload : payload?.text;
    if (!text) return;
    if (info?.kind === "block") return;
    await sendText({ cfg, toUser: fromUser, text, logger: api.logger });
  };

  const onError = async (err) => {
    api.logger?.error?.(`wechat_work: dispatch error for session=${sessionId}: ${String(err?.message || err)}`);
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
          sessionKey: sessionId,
          accountId: "default",
        },
      },
    });
  } catch (err) {
    await onError(err);
  }
}
