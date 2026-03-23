/**
 * s3-client.js
 *
 * Minimal S3-compatible PUT Object client.
 * Uses only Node.js built-ins (node:crypto + native fetch).
 * Implements AWS Signature Version 4 for authentication.
 *
 * Supports: MinIO, Cloudflare R2, AWS S3, and any S3-compatible service.
 */

import crypto from "node:crypto";

// ── Sig V4 helpers ────────────────────────────────────────────────────────────

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function hexHash(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function toHex(buf) {
  return Buffer.isBuffer(buf) ? buf.toString("hex") : buf;
}

function getSigningKey(secretKey, dateStamp, region, service) {
  const kDate    = hmac("AWS4" + secretKey, dateStamp);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  return kSigning;
}

function formatDate(date) {
  return date.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z"; // 20240101T120000Z
}

function formatDateStamp(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, ""); // 20240101
}

// ── URL construction ──────────────────────────────────────────────────────────

function buildEndpointUrl(cfg, bucket, key) {
  const endpoint = cfg.s3Endpoint.replace(/\/$/, "");

  // Path-style: {endpoint}/{bucket}/{key}  (used by MinIO by default)
  // Virtual-hosted style: {bucket}.{endpoint}/{key}  (used by AWS S3)
  // Detect by whether endpoint looks like an AWS regional endpoint
  const isAws = /s3\.[a-z0-9-]+\.amazonaws\.com$/.test(endpoint.replace(/^https?:\/\//, ""));

  if (isAws) {
    // Virtual-hosted style for AWS
    const base = endpoint.replace(/^(https?:\/\/)/, `$1${bucket}.`);
    return `${base}/${key}`;
  }

  // Path-style for MinIO / R2 / custom
  return `${endpoint}/${bucket}/${key}`;
}

function buildPublicUrl(cfg, bucket, key) {
  return buildEndpointUrl(cfg, bucket, key);
}

// ── Main upload function ──────────────────────────────────────────────────────

/**
 * Upload text content to S3-compatible storage.
 *
 * @param {object} cfg - Plugin config with s3Endpoint, s3Bucket, s3AccessKey, s3SecretKey, s3Region
 * @param {object} options
 * @param {string} options.content - Text content to upload
 * @param {string} options.key    - S3 object key (e.g. "wecom-output/2026-01-01/123-spider-web.txt")
 * @returns {Promise<string>} Public URL of the uploaded object
 */
export async function upload(cfg, { content, key }) {
  const {
    s3Endpoint,
    s3Bucket,
    s3AccessKey,
    s3SecretKey,
    s3Region = "us-east-1",
  } = cfg;

  if (!s3Endpoint || !s3Bucket || !s3AccessKey || !s3SecretKey) {
    throw new Error("S3 configuration incomplete (missing endpoint, bucket, or credentials)");
  }

  const body = Buffer.from(content, "utf8");
  const now = new Date();
  const amzDate = formatDate(now);
  const dateStamp = formatDateStamp(now);
  const service = "s3";
  const algorithm = "AWS4-HMAC-SHA256";

  const url = buildEndpointUrl(cfg, s3Bucket, key);
  const parsedUrl = new URL(url);
  const host = parsedUrl.host;
  const canonicalUri = parsedUrl.pathname;

  const payloadHash = hexHash(body);
  const contentType = "text/plain; charset=utf-8";

  // Canonical headers (must be sorted)
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;

  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${s3Region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    hexHash(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");

  const signingKey = getSigningKey(s3SecretKey, dateStamp, s3Region, service);
  const signature = toHex(hmac(signingKey, stringToSign));

  const authHeader =
    `${algorithm} Credential=${s3AccessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": authHeader,
      "Content-Type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      "Content-Length": String(body.byteLength),
    },
    body,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`S3 upload failed: ${response.status} ${errBody.slice(0, 200)}`);
  }

  return buildPublicUrl(cfg, s3Bucket, key);
}
