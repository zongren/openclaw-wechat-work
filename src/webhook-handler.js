import { computeSignature, decryptPayload } from "./crypto.js";
import { readRequestBody, parseXml, extractInboundEnvelope } from "./xml-parser.js";
import { markMessageSeen } from "./dedup.js";
import { processInbound } from "./inbound-processor.js";

export function createWebhookHandler({ api, cfg }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const msgSignature = url.searchParams.get("msg_signature") ?? "";
      const timestamp = url.searchParams.get("timestamp") ?? "";
      const nonce = url.searchParams.get("nonce") ?? "";
      const echostr = url.searchParams.get("echostr") ?? "";

      if (!cfg.callbackToken || !cfg.callbackAesKey) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("WeCom plugin not configured (missing callbackToken/callbackAesKey)");
        return;
      }

      // GET: callback URL verification
      if (req.method === "GET") {
        if (!echostr) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("wecom webhook ok");
          return;
        }

        const expectedSig = computeSignature(cfg.callbackToken, timestamp, nonce, echostr);
        if (expectedSig !== msgSignature) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Invalid signature");
          return;
        }

        const { msg: plainEchostr } = decryptPayload(cfg.callbackAesKey, echostr);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(plainEchostr);
        api.logger?.info?.("wechat_work: verified callback URL");
        return;
      }

      // Only accept POST beyond this point
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, POST");
        res.end();
        return;
      }

      // POST: message handling
      let encrypt = "";
      try {
        const rawXml = await readRequestBody(req);
        const incoming = parseXml(rawXml);
        encrypt = String(incoming?.Encrypt ?? "");
      } catch (err) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Invalid request body");
        api.logger?.warn?.(`wechat_work: failed to parse callback body: ${String(err?.message || err)}`);
        return;
      }

      if (!encrypt) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Missing Encrypt");
        return;
      }

      const expectedSig = computeSignature(cfg.callbackToken, timestamp, nonce, encrypt);
      if (expectedSig !== msgSignature) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Invalid signature");
        return;
      }

      // Return 200 immediately before processing
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("success");

      // Decrypt and process (fire-and-forget)
      let msgObj;
      try {
        const { msg: decryptedXml } = decryptPayload(cfg.callbackAesKey, encrypt);
        msgObj = parseXml(decryptedXml);
      } catch (err) {
        api.logger?.error?.(`wechat_work: failed to decrypt payload: ${String(err?.message || err)}`);
        return;
      }

      if (!markMessageSeen(msgObj)) {
        api.logger?.info?.(`wechat_work: duplicate inbound skipped msgId=${msgObj?.MsgId ?? "n/a"}`);
        return;
      }

      const inbound = extractInboundEnvelope(msgObj);
      if (!inbound?.msgType) {
        api.logger?.warn?.("wechat_work: inbound message missing MsgType, dropped");
        return;
      }

      if (!inbound.fromUser) {
        api.logger?.warn?.("wechat_work: inbound message missing FromUserName, dropped");
        return;
      }

      api.logger?.info?.(
        `wechat_work inbound: from=${inbound.fromUser} msgType=${inbound.msgType} content=${(inbound.content ?? "").slice(0, 80)}`,
      );

      // Fire-and-forget: do not await, so POST returns immediately
      processInbound({ api, cfg, inbound }).catch((err) => {
        api.logger?.error?.(`wechat_work: processInbound failed: ${String(err?.message || err)}`);
      });
    } catch (err) {
      api.logger?.error?.(`wechat_work: webhook handler failed: ${String(err?.message || err)}`);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Internal error");
      }
    }
  };
}
