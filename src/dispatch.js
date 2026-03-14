import { sendText } from "./api-client.js";

export async function dispatchToAgent({
  api,
  cfg,
  sessionId,
  fromUser,
  messageText,
  commandBody,
  msgId,
}) {
  const timestamp = Date.now();
  const commandAuthorized = Boolean(commandBody);
  const ctx = {
    Body: messageText,
    BodyForAgent: messageText,
    BodyForCommands: commandAuthorized ? commandBody : "",
    RawBody: messageText,
    CommandBody: commandBody || "",
    CommandAuthorized: commandAuthorized,
    CommandSource: commandAuthorized ? "text" : "",
    From: fromUser,
    To: fromUser,
    SessionKey: sessionId,
    AccountId: "default",
    ChatType: "direct",
    ConversationLabel: fromUser,
    SenderName: fromUser,
    SenderId: String(fromUser ?? "").trim().toLowerCase(),
    Provider: "wechat_work",
    Surface: "wechat_work",
    MessageSid: msgId || `wechat_work-${timestamp}`,
    Timestamp: timestamp,
    OriginatingChannel: "wechat_work",
    OriginatingTo: fromUser,
  };

  const deliver = async (payload, info) => {
    // payload is { text, mediaUrl?, mediaUrls?, mediaType? }, info is { kind: "block"|"final" }
    const text = typeof payload === "string" ? payload : payload?.text;
    if (!text) return;
    // With disableBlockStreaming, we only send on "final" (or if info is absent)
    if (info?.kind === "block") return;
    await sendText({ cfg, toUser: fromUser, text, logger: api.logger });
  };

  const onError = async (err) => {
    api.logger?.error?.(`wechat_work: dispatch error for session=${sessionId}: ${String(err?.message || err)}`);
    try {
      await sendText({
        cfg,
        toUser: fromUser,
        text: "\u62b1\u6b49\uff0c\u5904\u7406\u6d88\u606f\u65f6\u51fa\u73b0\u4e86\u9519\u8bef\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002",
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
