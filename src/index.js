import { createChannelPlugin } from "./channel-plugin.js";
import { createWebhookHandler } from "./webhook-handler.js";
import { createAgentMenu } from "./menu.js";
import { sendText } from "./api-client.js";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(_execFile);

// Prevent duplicate initialization when OpenClaw calls register() multiple times
let _initialized = false;

export default function register(api) {
  if (_initialized) return;
  _initialized = true;

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

  // Gateway-only initialization: skip for one-shot CLI commands
  if (!process.argv.includes("gateway")) return;

  // Create agent menu on gateway start
  if (cfg.corpId && cfg.corpSecret && cfg.agentId) {
    createAgentMenu({ cfg, logger }).catch((err) => {
      logger?.warn?.(`wechat_work: menu creation failed (non-fatal): ${String(err?.message || err)}`);
    });
  }

  // Poll for pending device pairing requests and notify admin via WeChat Work
  const adminUserId = cfg.adminUserId;
  if (adminUserId) {
    _startDevicePairingPoller({ cfg, logger, adminUserId });
  }
}

// ── Device pairing poller ─────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000;
const _seenRequestIds = new Set();

async function _startDevicePairingPoller({ cfg, logger, adminUserId }) {
  // Snapshot existing pending requests on startup so we don't re-notify them
  try {
    const initial = await _fetchPendingDevices();
    for (const d of initial) _seenRequestIds.add(d.requestId);
    logger?.info?.(`wechat_work: device pairing poller started (${initial.length} pre-existing pending requests ignored)`);
  } catch (err) {
    logger?.warn?.(`wechat_work: device pairing initial poll failed: ${String(err?.message || err)}`);
  }

  const timer = setInterval(async () => {
    try {
      const pending = await _fetchPendingDevices();
      for (const device of pending) {
        if (_seenRequestIds.has(device.requestId)) continue;
        _seenRequestIds.add(device.requestId);

        const text =
          `🔔 新设备配对请求\n` +
          `设备 ID：${device.deviceId}\n` +
          `平台：${device.platform || "未知"}\n` +
          `角色：${device.role || "未知"}\n\n` +
          `处理命令：\n` +
          `• openclaw devices approve ${device.requestId}\n` +
          `• openclaw devices reject ${device.requestId}`;

        sendText({ cfg, toUser: adminUserId, text, logger }).catch((err) => {
          logger?.warn?.(`wechat_work: failed to send device pairing notification: ${String(err?.message || err)}`);
        });
      }
    } catch {
      // Polling errors are transient — stay silent
    }
  }, POLL_INTERVAL_MS);
  timer.unref();
}

async function _fetchPendingDevices() {
  const { stdout } = await execFile("openclaw", ["devices", "list", "--json"], { timeout: 15_000 });
  // Strip any plugin log prefix lines before the JSON object
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) return [];
  const data = JSON.parse(stdout.slice(jsonStart));
  return Array.isArray(data.pending) ? data.pending : [];
}
