import { XMLParser } from "fast-xml-parser";

const MAX_BODY_BYTES = 1024 * 1024;

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

export function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function parseXml(xmlString) {
  const parsed = xmlParser.parse(xmlString);
  return parsed?.xml ?? parsed;
}

export function extractInboundEnvelope(msgObj) {
  if (!msgObj || typeof msgObj !== "object") return null;
  const str = (v) => {
    const s = String(v ?? "").trim();
    return s || "";
  };
  return {
    msgType: str(msgObj.MsgType).toLowerCase(),
    fromUser: str(msgObj.FromUserName),
    msgId: str(msgObj.MsgId),
    content: str(msgObj.Content),
    eventType: str(msgObj.Event).toLowerCase(),
    eventKey: str(msgObj.EventKey),
    createTime: str(msgObj.CreateTime),
    taskId: str(msgObj.TaskId),
  };
}
