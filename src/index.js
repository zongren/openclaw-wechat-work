import { createChannelPlugin } from "./channel-plugin.js";
import { createWebhookHandler } from "./webhook-handler.js";
import { createAgentMenu } from "./menu.js";
import { createProcessHooks } from "./process-hooks.js";
import * as sessionManager from "./session-manager.js";

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

  // Register process output hooks (for AI-mediated sessions)
  if (typeof api.on === "function") {
    const hooks = createProcessHooks({ cfg, logger });
    api.on("before_tool_call", hooks.beforeToolCall);
    api.on("after_tool_call", hooks.afterToolCall);
    api.on("tool_result_persist", hooks.toolResultPersist);
    logger?.info?.("wechat_work: registered process hooks (before_tool_call, after_tool_call, tool_result_persist)");
  } else {
    logger?.info?.("wechat_work: api.on() not available, skipping process hooks");
  }

  // Initialize session manager (tmux-based direct CLI sessions)
  sessionManager.init({ cfg, logger }).catch((err) => {
    logger?.warn?.(`wechat_work: session manager init failed (non-fatal): ${String(err?.message || err)}`);
  });

  // Fire-and-forget menu creation
  if (cfg.corpId && cfg.corpSecret && cfg.agentId) {
    createAgentMenu({ cfg, logger }).catch((err) => {
      logger?.warn?.(`wechat_work: menu creation failed (non-fatal): ${String(err?.message || err)}`);
    });
  }
}
