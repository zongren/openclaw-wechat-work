import { createChannelPlugin } from "./channel-plugin.js";
import { createWebhookHandler } from "./webhook-handler.js";
import { createAgentMenu } from "./menu.js";

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

  // Create agent menu only when the gateway server is starting,
  // not for one-shot CLI commands like "openclaw hooks list".
  const isGateway = process.argv.includes("gateway");
  if (isGateway && cfg.corpId && cfg.corpSecret && cfg.agentId) {
    createAgentMenu({ cfg, logger }).catch((err) => {
      logger?.warn?.(`wechat_work: menu creation failed (non-fatal): ${String(err?.message || err)}`);
    });
  }
}
