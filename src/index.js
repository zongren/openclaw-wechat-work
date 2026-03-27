import { createChannelPlugin } from "./channel-plugin.js";
import { createWebhookHandler } from "./webhook-handler.js";
import { createAgentMenu } from "./menu.js";
import { sendText } from "./api-client.js";

export default function register(api) {
  const cfg = api.config?.channels?.wechat_work;
  if (!cfg) {
    api.logger?.warn?.("wechat_work: no config found at channels.wechat_work, skipping registration");
    return;
  }

  if (!cfg.corpId || !cfg.corpSecret || !cfg.agentId) {
    api.logger?.warn?.("wechat_work: missing corpId, corpSecret, or agentId — channel will not function");
  }

  const logger = api.logger;
  const webhookPath = cfg.webhookPath || "/wecom/callback";

  const plugin = createChannelPlugin({ cfg, logger });
  const handler = createWebhookHandler({ api, cfg });

  api.registerChannel({ plugin });
  api.registerHttpRoute({ path: webhookPath, auth: "plugin", handler });

  logger?.info?.(`wechat_work: registered channel plugin, webhook at ${webhookPath}`);

  // Gateway-only initialization: only run in full registration mode,
  // not for one-shot CLI commands (setup-only / setup-runtime).
  if (api.registrationMode !== "full") return;

  // Create agent menu on gateway start
  if (cfg.corpId && cfg.corpSecret && cfg.agentId) {
    createAgentMenu({ cfg, logger }).catch((err) => {
      logger?.warn?.(`wechat_work: menu creation failed (non-fatal): ${String(err?.message || err)}`);
    });
  }

  // Notify admin via WeChat Work when a new device pairing request arrives
  const adminUserId = cfg.adminUserId;
  if (adminUserId && typeof api.on === "function") {
    api.on("device:pairing", (event) => {
      const ctx = event.context ?? event;
      const deviceId = ctx.deviceId ?? ctx.device_id ?? ctx.id ?? "未知";
      const role = ctx.role ?? "未知";
      const text =
        `🔔 新设备配对请求\n` +
        `设备 ID：${deviceId}\n` +
        `角色：${role}\n\n` +
        `运行以下命令处理：\n` +
        `• openclaw devices approve ${deviceId}\n` +
        `• openclaw devices reject ${deviceId}`;
      sendText({ cfg, toUser: adminUserId, text, logger }).catch((err) => {
        logger?.warn?.(`wechat_work: failed to send device pairing notification: ${String(err?.message || err)}`);
      });
    });
    logger?.info?.(`wechat_work: device pairing notifications enabled (admin=${adminUserId})`);
  }
}
