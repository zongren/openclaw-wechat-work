import { sendText } from "./api-client.js";

export function createChannelPlugin({ cfg, logger }) {
  return {
    id: "wechat_work",
    meta: {
      id: "wechat_work",
      label: "\u4f01\u4e1a\u5fae\u4fe1 WeChat Work",
      docsPath: "/channels/wechat_work",
      blurb: "\u4f01\u4e1a\u5fae\u4fe1\u81ea\u5efa\u5e94\u7528\u6d88\u606f\u901a\u9053\u3002",
      aliases: ["wecom", "wework"],
    },
    capabilities: {
      chatTypes: ["direct"],
    },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (_cfg, _accountId) => ({
        accountId: "default",
        corpId: cfg.corpId,
        agentId: cfg.agentId,
      }),
      isConfigured: () =>
        Boolean(cfg.corpId && cfg.corpSecret && cfg.agentId),
      describeAccount: () => ({
        accountId: "default",
        configured: Boolean(cfg.corpId && cfg.corpSecret && cfg.agentId),
        running: true,
        connected: true,
      }),
    },
    status: {
      buildAccountSnapshot: () => ({
        accountId: "default",
        configured: Boolean(cfg.corpId && cfg.corpSecret && cfg.agentId),
        running: true,
        connected: true,
      }),
      buildChannelSummary: () => ({
        configured: Boolean(cfg.corpId && cfg.corpSecret && cfg.agentId),
        running: true,
        connected: true,
      }),
    },
    outbound: {
      deliveryMode: "direct",
      resolveTarget: ({ to }) => {
        if (!to) return { ok: false, error: new Error("WeCom requires --to <userId>") };
        return { ok: true, to: typeof to === "string" ? { toUser: to } : to };
      },
      sendText: async ({ to, text }) => {
        const toUser = typeof to === "string" ? to : to?.toUser;
        await sendText({ cfg, toUser, text, logger });
        return { ok: true, provider: "wechat_work" };
      },
    },
    inbound: {
      deliverReply: async ({ to, text }) => {
        const toUser = typeof to === "string" ? to : to?.toUser;
        await sendText({ cfg, toUser, text, logger });
        return { ok: true };
      },
    },
  };
}
