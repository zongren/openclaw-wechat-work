import { splitWecomText, getByteLength } from "./text-utils.js";

const WECOM_API_BASE = "https://qyapi.weixin.qq.com";

const tokenCache = { token: null, expiresAt: 0, refreshPromise: null };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getAccessToken(cfg) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token;
  }

  if (tokenCache.refreshPromise) {
    return tokenCache.refreshPromise;
  }

  tokenCache.refreshPromise = (async () => {
    try {
      const url = `${WECOM_API_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.corpSecret)}`;
      const res = await fetch(url);
      const json = await res.json();
      if (!json?.access_token) {
        throw new Error(`WeCom gettoken failed: ${JSON.stringify(json)}`);
      }
      tokenCache.token = json.access_token;
      tokenCache.expiresAt = Date.now() + (json.expires_in || 7200) * 1000;
      return tokenCache.token;
    } finally {
      tokenCache.refreshPromise = null;
    }
  })();

  return tokenCache.refreshPromise;
}

export async function sendText({ cfg, toUser, text, logger }) {
  const chunks = splitWecomText(text);
  logger?.info?.(`wechat_work: splitting message into ${chunks.length} chunks, total bytes=${getByteLength(text)}`);

  for (let i = 0; i < chunks.length; i += 1) {
    logger?.info?.(`wechat_work: sending chunk ${i + 1}/${chunks.length}, bytes=${getByteLength(chunks[i])}`);
    const accessToken = await getAccessToken(cfg);
    const sendUrl = `${WECOM_API_BASE}/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    const body = {
      touser: toUser,
      msgtype: "text",
      agentid: cfg.agentId,
      text: { content: chunks[i] },
      safe: 0,
    };
    const res = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.errcode && json.errcode !== 0) {
      logger?.error?.(`wechat_work: send failed: ${JSON.stringify(json)}`);
      throw new Error(`WeCom send failed: errcode=${json.errcode} errmsg=${json.errmsg}`);
    }
    logger?.info?.(`wechat_work: message sent ok (to=${toUser}, msgid=${json?.msgid ?? "n/a"})`);
    if (i < chunks.length - 1) {
      await sleep(300);
    }
  }
}

export async function createMenu({ cfg, menuDef, logger }) {
  const accessToken = await getAccessToken(cfg);
  const url = `${WECOM_API_BASE}/cgi-bin/menu/create?access_token=${encodeURIComponent(accessToken)}&agentid=${encodeURIComponent(cfg.agentId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(menuDef),
  });
  const json = await res.json();
  if (json.errcode && json.errcode !== 0) {
    throw new Error(`WeCom menu create failed: errcode=${json.errcode} errmsg=${json.errmsg}`);
  }
  logger?.info?.("wechat_work: agent menu created successfully");
  return json;
}

