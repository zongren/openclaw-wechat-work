import { sendText, updateTemplateCard } from "./api-client.js";
import { MENU_KEY_MAP } from "./menu.js";
import { dispatchToAgent } from "./dispatch.js";
import { hasPendingInteraction, resolveInteraction } from "./interaction.js";

const WELCOME_TEXT = "\u4f60\u597d\uff0c\u6211\u662f AI \u52a9\u624b\uff0c\u76f4\u63a5\u53d1\u6d88\u606f\u5373\u53ef\u5f00\u59cb\u5bf9\u8bdd\u3002";

export async function processInbound({ api, cfg, inbound }) {
  const { msgType, fromUser, content, eventType, eventKey, msgId, taskId } = inbound;

  // ── Interaction intercept: capture reply if user has a pending interaction
  if (msgType === "text" && content && hasPendingInteraction(fromUser)) {
    if (!content.startsWith("/")) {
      const result = resolveInteraction({ fromUser, reply: content });
      if (result === true) return;
      if (result === "retry") {
        await sendText({ cfg, toUser: fromUser, text: "输入无效，请按提示重新输入。", logger: api.logger });
        return;
      }
    }
  }

  if (msgType === "text" && content) {
    const sessionId = `wechat_work:${fromUser}`;
    api.logger?.info?.(`wechat_work: text from=${fromUser} content=${content.slice(0, 80)}`);
    await dispatchToAgent({
      api,
      cfg,
      sessionId,
      fromUser,
      messageText: content,
      commandBody: content.startsWith("/") ? content : "",
      msgId,
    });
    return;
  }

  if (msgType === "event") {
    if (eventType === "click" && eventKey) {
      const commandText = MENU_KEY_MAP[eventKey];
      if (commandText) {
        const sessionId = `wechat_work:${fromUser}`;
        api.logger?.info?.(`wechat_work: menu click from=${fromUser} key=${eventKey} -> ${commandText}`);
        await dispatchToAgent({
          api,
          cfg,
          sessionId,
          fromUser,
          messageText: commandText,
          commandBody: commandText,
          msgId: msgId || `event-${Date.now()}`,
        });
        return;
      }
    }

    if (eventType === "template_card_event" && eventKey) {
      const result = resolveInteraction({ fromUser, eventKey, taskId });
      if (result === true) {
        updateTemplateCard({ cfg, toUser: fromUser, taskId, clickedKey: eventKey, logger: api.logger }).catch(() => {});
        return;
      }
      return; // stale card click — ignore silently
    }

    if (eventType === "subscribe" || eventType === "enter_agent") {
      api.logger?.info?.(`wechat_work: ${eventType} event from=${fromUser}`);
      await sendText({ cfg, toUser: fromUser, text: WELCOME_TEXT, logger: api.logger });
      return;
    }

    api.logger?.info?.(`wechat_work: ignoring event type=${eventType} key=${eventKey || "n/a"}`);
    return;
  }

  api.logger?.info?.(`wechat_work: ignoring unsupported msgType=${msgType}`);
}
