/**
 * session-manager.js
 *
 * Direct CLI-to-WeChat bridge via tmux.
 * Spawns Claude Code (or other CLI tools) in tmux sessions,
 * captures output via log files, and forwards to WeChat users.
 * Bypasses OpenClaw's AI dispatcher entirely.
 */

import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";

import { sendText } from "./api-client.js";
import { requestUserInput } from "./interaction.js";
import { splitWecomText } from "./text-utils.js";
import * as s3Client from "./s3-client.js";

const execFile = promisify(_execFile);

// ── Module-level state ─────────────────────────────────────────────────────────

let _cfg = null;
let _logger = null;
let _tmuxAvailable = false;

// Map<userId, { active: string|null, sessions: Map<name, SessionRecord> }>
const store = new Map();

const SESSION_DIR = path.join(os.tmpdir(), "wechat-sessions");
const MAX_SESSIONS_PER_USER = 10;
const IDLE_FLUSH_MS = 500;
const LARGE_OUTPUT_BYTES = 6144; // ~3 WeChat chunks
const LIVENESS_INTERVAL_MS = 30_000;

// ── ANSI stripping ────────────────────────────────────────────────────────────

// Covers: standard CSI sequences, OSC sequences (including OSC 8 hyperlinks),
// character set designations, bracketed paste, 256-color/truecolor, etc.
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|\(B)/g;

function stripAnsi(text) {
  return text.replace(ANSI_REGEX, "");
}

// ── Prompt detection ──────────────────────────────────────────────────────────

// Trust prompt: Claude Code's "Do you trust the files in this folder?" dialog
const TRUST_PROMPT_REGEX = /trust\s+the\s+files|1\.\s+Yes.*trust|Do you trust/i;

// Numbered list with at least 2 items (choice prompt)
const NUMBERED_LIST_REGEX = /(?:^|\n)\s*1[.)]\s+\S[^\n]*(?:\n\s*\d+[.)]\s+\S[^\n]*){1,}/;

// Y/N style confirm prompts
const CONFIRM_REGEX = /\?\s*\(?(?:y(?:es)?)[/|](?:n(?:o)?)\)?\s*:?\s*$|\?\s*\(Y\/n\)\s*$|\?\s*\(y\/N\)\s*$/im;

function detectPromptType(text) {
  if (TRUST_PROMPT_REGEX.test(text)) return "trust";
  if (NUMBERED_LIST_REGEX.test(text)) return "choice";
  if (CONFIRM_REGEX.test(text)) return "confirm";
  return null;
}

function extractNumberedOptions(text) {
  const options = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)[.)]\s+(.+)/);
    if (m) options.push(m[2].trim());
  }
  return options;
}

// ── Session name generation ───────────────────────────────────────────────────

const ADJECTIVES = ["blue", "swift", "calm", "bold", "dark", "deep", "fast", "keen", "pure", "wild"];
const NOUNS = ["fox", "owl", "bee", "oak", "sea", "sky", "sun", "arc", "bay", "elm"];

function generateSessionName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

function validateSessionName(name) {
  if (!name || name.trim().length === 0) return false;
  if (name.length > 64) return false;
  return true;
}

// ── Store helpers ─────────────────────────────────────────────────────────────

function getOrCreateUserStore(userId) {
  if (!store.has(userId)) {
    store.set(userId, { active: null, sessions: new Map() });
  }
  return store.get(userId);
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function init({ cfg, logger }) {
  _cfg = cfg;
  _logger = logger;

  // Check tmux availability
  try {
    await execFile("tmux", ["-V"]);
    _tmuxAvailable = true;
    logger?.info?.("wechat_work: tmux is available");
  } catch {
    _tmuxAvailable = false;
    logger?.warn?.("wechat_work: tmux not found in PATH — /claude sessions will not work");
    return;
  }

  // Ensure session directory exists
  await fs.mkdir(SESSION_DIR, { recursive: true });

  // Clean up stale files from previous runs
  await _cleanupStaleFiles();

  // Recover live sessions
  await _recoverSessions();

  // Start liveness check
  _startLivenessCheck();
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function spawnSession(userId, name, tool = "claude") {
  if (!_tmuxAvailable) {
    throw new Error("tmux 未安装，无法启动 CLI 会话。");
  }

  const finalName = name || generateSessionName();

  if (!validateSessionName(finalName)) {
    throw new Error("会话名称无效（不能为空或超过64字符）。");
  }

  const userStore = getOrCreateUserStore(userId);

  if (userStore.sessions.has(finalName)) {
    throw new Error(`会话 "${finalName}" 已存在，请先 /kill ${finalName} 或使用其他名称。`);
  }

  if (userStore.sessions.size >= MAX_SESSIONS_PER_USER) {
    throw new Error(`已达到最大会话数 (${MAX_SESSIONS_PER_USER})，请先终止一个会话。`);
  }

  const shortId = randomBytes(4).toString("hex");
  const tmuxName = `wechat-${shortId}`;
  const logFile = path.join(SESSION_DIR, `${shortId}.log`);
  const metaFile = path.join(SESSION_DIR, `${shortId}.meta.json`);

  // Create empty log file first (so pipe-pane has a target)
  await fs.writeFile(logFile, "", { flag: "w" });

  // Write metadata sidecar
  await fs.writeFile(metaFile, JSON.stringify({
    userId,
    name: finalName,
    startedAt: Date.now(),
    tool,
  }), "utf8");

  // Create tmux session
  try {
    await execFile("tmux", ["new-session", "-d", "-s", tmuxName, "-c", os.homedir()]);
  } catch (err) {
    // Clean up on failure
    await fs.unlink(logFile).catch(() => {});
    await fs.unlink(metaFile).catch(() => {});
    throw new Error(`无法创建 tmux 会话: ${err.message}`);
  }

  // Attach pipe-pane to capture output
  try {
    await execFile("tmux", ["pipe-pane", "-o", "-t", tmuxName, `cat >> ${logFile}`]);
  } catch (err) {
    await execFile("tmux", ["kill-session", "-t", tmuxName]).catch(() => {});
    await fs.unlink(logFile).catch(() => {});
    await fs.unlink(metaFile).catch(() => {});
    throw new Error(`无法附加输出捕获: ${err.message}`);
  }

  // Launch the tool
  await execFile("tmux", ["send-keys", "-t", tmuxName, tool, "Enter"]);

  // Build session record
  const record = {
    shortId,
    name: finalName,
    tool,
    startedAt: Date.now(),
    tmuxName,
    logFile,
    metaFile,
    userId,
    offset: 0,
    buffer: "",
    flushTimer: null,
    watcherClose: null,
    dead: false,
    pendingPrompt: false,
  };

  _watchLogFile(record);
  userStore.sessions.set(finalName, record);
  userStore.active = finalName;

  _logger?.info?.(`wechat_work: spawned tmux session name=${finalName} shortId=${shortId} tool=${tool} user=${userId}`);

  return { shortId, name: finalName };
}

export async function sendInput(userId, text) {
  const userStore = store.get(userId);
  if (!userStore?.active) {
    throw new Error("没有活跃的会话。");
  }
  const record = userStore.sessions.get(userStore.active);
  if (!record || record.dead) {
    throw new Error(`会话 "${userStore.active}" 已结束。`);
  }

  // Two-call pattern: -l sends text literally (no key-name interpretation),
  // second call sends Enter as a special key. Prevents shell injection.
  await execFile("tmux", ["send-keys", "-l", "-t", record.tmuxName, text]);
  await execFile("tmux", ["send-keys", "-t", record.tmuxName, "Enter"]);
}

export async function killSession(userId, name) {
  const userStore = store.get(userId);
  if (!userStore?.sessions.has(name)) {
    throw new Error(`找不到会话 "${name}"。`);
  }
  const record = userStore.sessions.get(name);
  await _destroyRecord(record, userStore, name);
}

export function exitSession(userId) {
  const userStore = store.get(userId);
  if (userStore) userStore.active = null;
}

export async function switchSession(userId, name) {
  const userStore = store.get(userId);
  if (!userStore?.sessions.has(name)) {
    const names = userStore ? [...userStore.sessions.keys()].join(", ") || "(无)" : "(无)";
    throw new Error(`找不到会话 "${name}"。可用会话：${names}`);
  }
  const record = userStore.sessions.get(name);
  if (record.dead) {
    throw new Error(`会话 "${name}" 已结束，无法切换。`);
  }
  userStore.active = name;
}

export function listSessions(userId) {
  const userStore = store.get(userId);
  if (!userStore || userStore.sessions.size === 0) return [];
  const result = [];
  for (const [name, record] of userStore.sessions.entries()) {
    const uptimeSec = Math.floor((Date.now() - record.startedAt) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    result.push({
      name,
      tool: record.tool,
      uptime: h > 0 ? `${h}h ${m}m` : `${m}m`,
      active: userStore.active === name,
      dead: record.dead,
    });
  }
  return result;
}

export function getActiveSession(userId) {
  const userStore = store.get(userId);
  if (!userStore?.active) return null;
  const record = userStore.sessions.get(userStore.active);
  if (!record || record.dead) return null;
  return record;
}

export function isTmuxAvailable() {
  return _tmuxAvailable;
}

// ── Output pipeline ───────────────────────────────────────────────────────────

function _watchLogFile(record) {
  let watcher;
  try {
    watcher = watch(record.logFile, () => {
      _onFileChange(record).catch((err) => {
        _logger?.warn?.(`wechat_work: watch error for ${record.name}: ${err.message}`);
      });
    });
  } catch (err) {
    _logger?.warn?.(`wechat_work: failed to watch log file for ${record.name}: ${err.message}`);
    return;
  }

  record.watcherClose = () => {
    try { watcher.close(); } catch {}
  };
}

async function _onFileChange(record) {
  if (record.dead) return;

  let stat;
  try {
    stat = await fs.stat(record.logFile);
  } catch {
    return; // file gone
  }

  if (stat.size <= record.offset) return; // no new bytes

  // Read new bytes since last offset
  let fd;
  try {
    fd = await fs.open(record.logFile, "r");
    const length = stat.size - record.offset;
    const buf = Buffer.allocUnsafe(length);
    await fd.read(buf, 0, length, record.offset);
    record.offset = stat.size;
    record.buffer += buf.toString("utf8");
  } catch (err) {
    _logger?.warn?.(`wechat_work: read error for ${record.name}: ${err.message}`);
    return;
  } finally {
    await fd?.close().catch(() => {});
  }

  // Reset idle timer
  if (record.flushTimer) clearTimeout(record.flushTimer);
  if (!record.pendingPrompt) {
    record.flushTimer = setTimeout(() => _flushBuffer(record), IDLE_FLUSH_MS);
  }
}

async function _flushBuffer(record) {
  if (record.dead || record.pendingPrompt) return;

  const raw = record.buffer;
  record.buffer = "";
  record.flushTimer = null;

  const text = stripAnsi(raw);
  if (!text.trim()) return;

  const promptType = detectPromptType(text);

  if (promptType === "trust") {
    // Auto-confirm trust prompt — send '1' then Enter
    _logger?.info?.(`wechat_work: auto-confirming trust prompt for session=${record.name}`);
    await execFile("tmux", ["send-keys", "-l", "-t", record.tmuxName, "1"]).catch(() => {});
    await execFile("tmux", ["send-keys", "-t", record.tmuxName, "Enter"]).catch(() => {});
    return;
  }

  if (promptType === "choice" || promptType === "confirm") {
    record.pendingPrompt = true;
    try {
      await _handlePrompt(record, text, promptType);
    } finally {
      record.pendingPrompt = false;
      // Flush any buffered output that arrived during prompt
      if (record.buffer.trim()) {
        record.flushTimer = setTimeout(() => _flushBuffer(record), 0);
      }
    }
    return;
  }

  // No prompt detected — forward as regular output
  await _sendOutput(record, text);
}

async function _handlePrompt(record, text, promptType) {
  const prefixed = `[${record.name}] ${text.trim()}`;

  try {
    if (promptType === "choice") {
      const options = extractNumberedOptions(text).slice(0, 4);
      if (options.length === 0) {
        // Fallback: can't extract options, treat as free-text
        const { value } = await requestUserInput({
          cfg: _cfg,
          toUser: record.userId,
          type: "text",
          prompt: prefixed,
          logger: _logger,
        });
        await execFile("tmux", ["send-keys", "-l", "-t", record.tmuxName, String(value)]);
        await execFile("tmux", ["send-keys", "-t", record.tmuxName, "Enter"]);
        return;
      }
      const { value } = await requestUserInput({
        cfg: _cfg,
        toUser: record.userId,
        type: "choice",
        prompt: prefixed,
        options,
        logger: _logger,
      });
      // value is the option text; find its number to send back
      const idx = options.indexOf(value);
      const answer = idx >= 0 ? String(idx + 1) : String(value);
      await execFile("tmux", ["send-keys", "-l", "-t", record.tmuxName, answer]);
      await execFile("tmux", ["send-keys", "-t", record.tmuxName, "Enter"]);

    } else if (promptType === "confirm") {
      const { value } = await requestUserInput({
        cfg: _cfg,
        toUser: record.userId,
        type: "confirm",
        prompt: prefixed,
        logger: _logger,
      });
      await execFile("tmux", ["send-keys", "-l", "-t", record.tmuxName, value ? "y" : "n"]);
      await execFile("tmux", ["send-keys", "-t", record.tmuxName, "Enter"]);
    }
  } catch (err) {
    // Timeout or cancellation — send Ctrl+C
    _logger?.info?.(`wechat_work: prompt timeout/cancelled for session=${record.name}: ${err.message}`);
    await execFile("tmux", ["send-keys", "-t", record.tmuxName, "C-c"]).catch(() => {});
  }
}

async function _sendOutput(record, text) {
  const s3Configured = !!(
    _cfg?.s3Endpoint && _cfg?.s3Bucket && _cfg?.s3AccessKey && _cfg?.s3SecretKey
  );

  if (s3Configured && Buffer.byteLength(text, "utf8") > LARGE_OUTPUT_BYTES) {
    try {
      const timestamp = Date.now();
      const date = new Date().toISOString().slice(0, 10);
      const filename = `${timestamp}-${record.name}.txt`;
      const url = await s3Client.upload(_cfg, {
        content: text,
        key: `wecom-output/${date}/${filename}`,
      });
      await sendText({
        cfg: _cfg,
        toUser: record.userId,
        text: `[${record.name}] 📄 输出较长，已上传：${url}`,
        logger: _logger,
      });
      return;
    } catch (err) {
      _logger?.warn?.(`wechat_work: S3 upload failed for session=${record.name}, falling back to text: ${err.message}`);
      // Fall through to chunked text
    }
  }

  const prefixed = text.trim().split("\n").map(l => l).join("\n");
  const chunks = splitWecomText(`[${record.name}]\n${prefixed}`);
  for (const chunk of chunks) {
    await sendText({ cfg: _cfg, toUser: record.userId, text: chunk, logger: _logger });
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _destroyRecord(record, userStore, name) {
  // Stop file watcher
  record.watcherClose?.();
  if (record.flushTimer) clearTimeout(record.flushTimer);

  // Kill tmux session
  await execFile("tmux", ["kill-session", "-t", record.tmuxName]).catch(() => {});

  // Clean up files
  await fs.unlink(record.logFile).catch(() => {});
  await fs.unlink(record.metaFile).catch(() => {});

  userStore.sessions.delete(name);
  if (userStore.active === name) userStore.active = null;

  _logger?.info?.(`wechat_work: destroyed session name=${name} tmux=${record.tmuxName}`);
}

// ── Restart recovery ──────────────────────────────────────────────────────────

async function _cleanupStaleFiles() {
  let entries;
  try {
    entries = await fs.readdir(SESSION_DIR);
  } catch {
    return;
  }

  // Get live tmux session short IDs
  let liveIds = new Set();
  try {
    const { stdout } = await execFile("tmux", ["ls", "-F", "#{session_name}"]);
    for (const name of stdout.trim().split("\n")) {
      if (name.startsWith("wechat-")) liveIds.add(name.slice("wechat-".length));
    }
  } catch {
    // tmux ls fails when no sessions exist — that's fine
  }

  for (const entry of entries) {
    const m = entry.match(/^([0-9a-f]{8})\.(log|meta\.json)$/);
    if (!m) continue;
    const shortId = m[1];
    if (!liveIds.has(shortId)) {
      await fs.unlink(path.join(SESSION_DIR, entry)).catch(() => {});
    }
  }
}

async function _recoverSessions() {
  let stdout;
  try {
    ({ stdout } = await execFile("tmux", ["ls", "-F", "#{session_name}"]));
  } catch {
    return; // no sessions
  }

  const tmuxNames = stdout.trim().split("\n").filter((n) => n.startsWith("wechat-"));

  for (const tmuxName of tmuxNames) {
    const shortId = tmuxName.slice("wechat-".length);
    const metaFile = path.join(SESSION_DIR, `${shortId}.meta.json`);
    const logFile = path.join(SESSION_DIR, `${shortId}.log`);

    let meta;
    try {
      meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
    } catch {
      continue; // no metadata, skip
    }

    const { userId, name, startedAt, tool } = meta;
    if (!userId || !name) continue;

    // Start watching from current end of file (skip historical content)
    let fileSize = 0;
    try {
      const stat = await fs.stat(logFile);
      fileSize = stat.size;
    } catch {}

    // Stop any existing pipe-pane, then reattach
    await execFile("tmux", ["pipe-pane", "-t", tmuxName]).catch(() => {});
    await execFile("tmux", ["pipe-pane", "-o", "-t", tmuxName, `cat >> ${logFile}`]).catch(() => {});

    const record = {
      shortId,
      name,
      tool: tool || "claude",
      startedAt: startedAt || Date.now(),
      tmuxName,
      logFile,
      metaFile,
      userId,
      offset: fileSize,
      buffer: "",
      flushTimer: null,
      watcherClose: null,
      dead: false,
      pendingPrompt: false,
    };

    _watchLogFile(record);
    getOrCreateUserStore(userId).sessions.set(name, record);

    _logger?.info?.(`wechat_work: recovered session name=${name} user=${userId}`);

    // Notify user
    await sendText({
      cfg: _cfg,
      toUser: userId,
      text: `[${name}] ♻ 会话已在重启后恢复。`,
      logger: _logger,
    }).catch(() => {});
  }
}

// ── Liveness check ────────────────────────────────────────────────────────────

function _startLivenessCheck() {
  setInterval(async () => {
    let liveSet = new Set();
    try {
      const { stdout } = await execFile("tmux", ["ls", "-F", "#{session_name}"]);
      for (const n of stdout.trim().split("\n")) liveSet.add(n);
    } catch {
      // tmux ls fails when no sessions — all sessions are dead
    }

    for (const [userId, userStore] of store) {
      for (const [name, record] of userStore.sessions) {
        if (!record.dead && !liveSet.has(record.tmuxName)) {
          record.dead = true;
          record.watcherClose?.();
          if (record.flushTimer) clearTimeout(record.flushTimer);
          if (userStore.active === name) userStore.active = null;

          _logger?.info?.(`wechat_work: session ended name=${name} user=${userId}`);
          await sendText({
            cfg: _cfg,
            toUser: userId,
            text: `[${name}] ✗ 会话已结束。`,
            logger: _logger,
          }).catch(() => {});
        }
      }
    }
  }, LIVENESS_INTERVAL_MS);
}
