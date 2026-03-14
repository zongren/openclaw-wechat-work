const DEDUPE_TTL_MS = 5 * 60 * 1000;
const seen = new Map();

function buildDedupeKey(msgObj) {
  const msgId = String(msgObj?.MsgId ?? "").trim();
  if (msgId) return `id:${msgId}`;
  const fromUser = String(msgObj?.FromUserName ?? "").trim().toLowerCase();
  const createTime = String(msgObj?.CreateTime ?? "").trim();
  const msgType = String(msgObj?.MsgType ?? "").trim().toLowerCase();
  const stableHint = String(
    msgObj?.Content ?? msgObj?.MediaId ?? msgObj?.EventKey ?? msgObj?.Event ?? "",
  )
    .trim()
    .slice(0, 160);
  if (!fromUser && !createTime && !msgType && !stableHint) return null;
  return `${fromUser}|${createTime}|${msgType}|${stableHint}`;
}

export function markMessageSeen(msgObj) {
  const key = buildDedupeKey(msgObj);
  if (!key) return true;

  const now = Date.now();
  for (const [k, expiresAt] of seen) {
    if (expiresAt <= now) seen.delete(k);
  }

  const existing = seen.get(key);
  if (typeof existing === "number" && existing > now) return false;

  seen.set(key, now + DEDUPE_TTL_MS);
  return true;
}
