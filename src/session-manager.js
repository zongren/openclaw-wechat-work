/**
 * session-manager.js
 *
 * Direct CLI-to-WeChat bridge via tmux.
 * Spawns Claude Code (or other CLI tools) in tmux sessions,
 * captures output via tmux capture-pane (clean rendered text),
 * and forwards to WeChat users.
 * Bypasses OpenClaw's AI dispatcher entirely.
 *
 * Output pipeline:
 *   pipe-pane → log file → fs.watch (change detection only)
 *   → tmux capture-pane -p -S - (rendered terminal text, no ANSI)
 *   → diff against processedLines → sendText to WeChat
 *
 * This avoids the "spaces stripped" problem caused by raw TUI escape sequences.
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
const IDLE_FLUSH_MS = 600;       // wait for output to settle before forwarding
const LARGE_OUTPUT_BYTES = 6144; // ~3 WeChat chunks → S3 fallback
const LIVENESS_INTERVAL_MS = 30_000;

// ── Prompt detection (runs on clean capture-pane text) ────────────────────────

// Trust prompt — Claude Code's folder-trust dialog.
// capture-pane renders: "  ❯ 1. Yes, I trust this folder"
const TRUST_PROMPT_REGEX = /trust this folder|Yes.*I trust|❯.*trust/i;

// Numbered choice list (at least 2 items).
// Handles both plain "1. Yes" and TUI box "│ ❯ 1. Yes │" formats.
const NUMBERED_LIST_REGEX = /(?:^|\n).*?(?:❯\s*)?\s*1[.)]\s+\S[^\n]*(?:\n.*?\d+[.)]\s+\S[^\n]*){1,}/;

// Y/N style confirm prompts
const CONFIRM_REGEX = /\?\s*\(?(?:y(?:es)?)[/|](?:n(?:o)?)\)?\s*:?\s*$|\?\s*\(Y\/n\)\s*$|\?\s*\(y\/N\)\s*$/im;

// Claude Code is ready for input (past the trust prompt)
const CLAUDE_READY_REGEX = /Type a message|\/help for help|What would you like|Human:|>\s*$/;

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
    // Strip box-drawing characters (│, ╭, ╰, ─, ❯, ▶) before matching
    const cleaned = line.replace(/[│╭╰╮├╯─❯▶]/g, " ").trim();
    const m = cleaned.match(/^\s*(\d+)[.)]\s+(.+)/);
    if (m) {
      const opt = m[2].replace(/\s*│?\s*$/, "").trim();
      if (opt) options.push(opt);
    }
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

let _initialized = false;

export async function init({ cfg, logger }) {
  // Prevent duplicate initialization (OpenClaw may call register() multiple times)
  if (_initialized) {
    logger?.debug?.("wechat_work: session manager already initialized, skipping");
    return;
  }

  _cfg = cfg;
  _logger = logger;

  try {
    await execFile("tmux", ["-V"]);
    _tmuxAvailable = true;
    logger?.info?.("wechat_work: tmux is available");
  } catch {
    _tmuxAvailable = false;
    logger?.warn?.("wechat_work: tmux not found in PATH — /claude sessions will not work");
    return;
  }

  await fs.mkdir(SESSION_DIR, { recursive: true });
  await _cleanupStaleFiles();
  await _recoverSessions();
  _startLivenessCheck();

  _initialized = true;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function spawnSession(userId, name, tool = "claude", args = []) {
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

  await fs.writeFile(logFile, "", { flag: "w" });
  await fs.writeFile(metaFile, JSON.stringify({
    userId, name: finalName, startedAt: Date.now(), tool, args,
  }), "utf8");

  try {
    // Create tmux session with a wide terminal (220 cols) to reduce line wrapping
    await execFile("tmux", ["new-session", "-d", "-s", tmuxName, "-c", os.homedir(),
      "-x", "220", "-y", "50"]);
  } catch (err) {
    await fs.unlink(logFile).catch(() => {});
    await fs.unlink(metaFile).catch(() => {});
    throw new Error(`无法创建 tmux 会话: ${err.message}`);
  }

  // Attach pipe-pane for change detection (log file will be written; we use capture-pane for content)
  try {
    await execFile("tmux", ["pipe-pane", "-o", "-t", tmuxName, `cat >> ${logFile}`]);
  } catch (err) {
    await execFile("tmux", ["kill-session", "-t", tmuxName]).catch(() => {});
    await fs.unlink(logFile).catch(() => {});
    await fs.unlink(metaFile).catch(() => {});
    throw new Error(`无法附加输出捕获: ${err.message}`);
  }

  // Send command with args to the shell (which has sourced .zshrc)
  const fullCommand = args.length > 0 ? `${tool} ${args.join(" ")}` : tool;
  await execFile("tmux", ["send-keys", "-t", tmuxName, "-l", fullCommand]);
  await execFile("tmux", ["send-keys", "-t", tmuxName, "Enter"]);

  const record = {
    shortId,
    name: finalName,
    tool,
    args,
    startedAt: Date.now(),
    tmuxName,
    logFile,
    metaFile,
    userId,
    // Output tracking (capture-pane based)
    processedLines: 0,       // lines already forwarded in full capture-pane history
    // Startup management
    startupPhase: true,      // suppress output until trust prompt handled
    startupConfirmTimer: null,
    // State
    flushTimer: null,
    watcherClose: null,
    dead: false,
    pendingPrompt: false,
  };

  _watchLogFile(record);
  userStore.sessions.set(finalName, record);
  userStore.active = finalName;

  _logger?.info?.(`wechat_work: spawned tmux session name=${finalName} shortId=${shortId} tool=${tool} user=${userId}`);

  // Schedule trust prompt check + auto-confirm
  _scheduleTrustConfirm(record, 0);

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
  // -l sends text literally (no key-name interpretation) — prevents shell injection
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
      starting: record.startupPhase,
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

// ── Startup: trust prompt auto-confirm ───────────────────────────────────────

async function _scheduleTrustConfirm(record, attempt) {
  if (record.dead) return;
  if (attempt > 8) {
    // Timed out — end startup phase anyway so output isn't blocked forever
    _logger?.warn?.(`wechat_work: startup phase timed out for session=${record.name}`);
    await _endStartupPhase(record);
    return;
  }

  const delay = attempt === 0 ? 2500 : 1500;

  record.startupConfirmTimer = setTimeout(async () => {
    if (record.dead) return;
    record.startupConfirmTimer = null;

    try {
      const { stdout } = await execFile("tmux", ["capture-pane", "-p", "-t", record.tmuxName]);

      if (TRUST_PROMPT_REGEX.test(stdout)) {
        // Trust prompt visible — send Enter (option 1 is pre-selected with ❯)
        _logger?.info?.(`wechat_work: auto-confirming trust prompt for session=${record.name} (attempt=${attempt})`);
        await execFile("tmux", ["send-keys", "-t", record.tmuxName, "Enter"]);
        // Small delay for trust to process before ending startup phase
        await new Promise(r => setTimeout(r, 800));
        await _endStartupPhase(record);
        return;
      }

      if (CLAUDE_READY_REGEX.test(stdout) || attempt >= 3) {
        // Claude Code already past trust, or we've waited long enough
        await _endStartupPhase(record);
        return;
      }

      // Not ready yet — retry
      _scheduleTrustConfirm(record, attempt + 1);
    } catch {
      await _endStartupPhase(record);
    }
  }, delay);
}

async function _endStartupPhase(record) {
  if (record.dead) return;

  // Snapshot current line count so _captureAndProcess skips startup content
  try {
    const { stdout } = await execFile("tmux", ["capture-pane", "-p", "-S", "-", "-t", record.tmuxName]);
    const lines = _parseCapture(stdout);
    record.processedLines = lines.length;
  } catch {
    record.processedLines = 0;
  }

  record.startupPhase = false;

  // Notify user that Claude Code is ready
  await sendText({
    cfg: _cfg,
    toUser: record.userId,
    text: `[${record.name}] ✅ Claude Code 已就绪，直接发消息开始对话。\n发送 /exit 可退出转发模式。`,
    logger: _logger,
  }).catch(() => {});
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
  record.watcherClose = () => { try { watcher.close(); } catch {} };
}

async function _onFileChange(record) {
  if (record.dead || record.startupPhase || record.pendingPrompt) return;
  // Debounce: wait for output to settle before capturing
  if (record.flushTimer) clearTimeout(record.flushTimer);
  record.flushTimer = setTimeout(
    () => _captureAndProcess(record).catch((err) => {
      _logger?.warn?.(`wechat_work: capture error for ${record.name}: ${err.message}`);
    }),
    IDLE_FLUSH_MS
  );
}

// Get rendered terminal text via capture-pane (the proper fix for spacing).
// -p: print to stdout (no ANSI codes)
// -S -: capture from beginning of scrollback history
async function _captureAndProcess(record) {
  if (record.dead || record.startupPhase || record.pendingPrompt) return;
  record.flushTimer = null;

  let stdout;
  try {
    ({ stdout } = await execFile("tmux", ["capture-pane", "-p", "-S", "-", "-t", record.tmuxName]));
  } catch {
    return;
  }

  const allLines = _parseCapture(stdout);

  if (allLines.length <= record.processedLines) return; // nothing new

  const newLines = allLines.slice(record.processedLines);
  record.processedLines = allLines.length;

  const newContent = newLines.join("\n").trim();
  if (!newContent) return;

  const promptType = detectPromptType(newContent);

  if (promptType === "trust") {
    // Trust prompt appeared after startup phase (unusual but handle it)
    _logger?.info?.(`wechat_work: late trust prompt for session=${record.name} — auto-confirming`);
    await execFile("tmux", ["send-keys", "-t", record.tmuxName, "Enter"]).catch(() => {});
    return;
  }

  if (promptType === "choice" || promptType === "confirm") {
    record.pendingPrompt = true;
    try {
      await _handlePrompt(record, newContent, promptType);
    } finally {
      record.pendingPrompt = false;
      // Re-capture after prompt resolves (there will likely be new output)
      record.flushTimer = setTimeout(
        () => _captureAndProcess(record).catch(() => {}),
        300
      );
    }
    return;
  }

  await _sendOutput(record, newContent);
}

function _parseCapture(stdout) {
  // Split lines, trim trailing whitespace per line (terminals pad to width)
  const lines = stdout.split("\n").map(l => l.trimEnd());
  // Remove trailing empty lines (terminal padding at bottom of screen)
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Strip TUI chrome (box-drawing, navigation hints, separators, numbered items) from prompt text
function _cleanPromptText(text) {
  return text.split("\n")
    .map(l => l.replace(/[│╭╰╮├╯❯▶]/g, "").trim())  // strip box-drawing chars
    .filter(l => {
      if (!l) return false;  // skip empty lines
      if (/^─+$/.test(l)) return false;  // skip separator lines (────────)
      if (/^(Enter to|↑|↓|Esc|to select|to navigate|to cancel|·)/i.test(l)) return false;  // skip nav hints
      if (/^\d+\.\s/.test(l)) return false;  // skip numbered items (they're in options array)
      return true;
    })
    .join(" ")  // join with space instead of newline for cleaner title
    .replace(/\s+/g, " ")  // collapse multiple spaces
    .trim();
}

// Extract a clean title from the prompt text (first non-empty line after cleaning)
function _cleanPromptTitle(text) {
  const cleaned = _cleanPromptText(text);
  return (cleaned || "请选择").slice(0, 128);
}

async function _handlePrompt(record, text, promptType) {
  try {
    if (promptType === "choice") {
      const allOptions = extractNumberedOptions(text);
      if (allOptions.length === 0) {
        // No parseable options — forward as free-text prompt
        const title = _cleanPromptTitle(text);
        const { value } = await requestUserInput({
          cfg: _cfg, toUser: record.userId, type: "text",
          prompt: `[${record.name}] ${title}`, logger: _logger,
        });
        await execFile("tmux", ["send-keys", "-l", "-t", record.tmuxName, String(value)]);
        await execFile("tmux", ["send-keys", "-t", record.tmuxName, "Enter"]);
        return;
      }

      // WeCom button_interaction supports max 4 buttons.
      // If more than 4 options, send in pages of 3 with a "下一页" button.
      const title = _cleanPromptTitle(text);
      const PAGE_SIZE = 4;

      if (allOptions.length <= PAGE_SIZE) {
        // Simple case — fits in one card
        const { value } = await requestUserInput({
          cfg: _cfg, toUser: record.userId, type: "choice",
          prompt: `[${record.name}] ${title}`,
          options: allOptions,
          logger: _logger,
        });
        const idx = allOptions.indexOf(value);
        const answer = idx >= 0 ? String(idx + 1) : String(value);
        await execFile("tmux", ["send-keys", "-l", "-t", record.tmuxName, answer]);
        await execFile("tmux", ["send-keys", "-t", record.tmuxName, "Enter"]);
      } else {
        // Paginate: 3 options per page + "更多(n-m)" navigation button
        let page = 0;
        while (true) {
          const start = page * 3;
          const pageOptions = allOptions.slice(start, start + 3);
          const hasMore = start + 3 < allOptions.length;
          const displayOptions = hasMore
            ? [...pageOptions, `下一页 (${start + 4}-${Math.min(start + 6, allOptions.length)})`]
            : pageOptions;

          const pageTitle = `[${record.name}] ${title} (${start + 1}-${start + pageOptions.length}/${allOptions.length})`;
          const { value } = await requestUserInput({
            cfg: _cfg, toUser: record.userId, type: "choice",
            prompt: pageTitle,
            options: displayOptions,
            logger: _logger,
          });

          if (value.startsWith("下一页")) {
            page++;
            continue; // show next page
          }

          // Find actual index in full options list
          const realIdx = allOptions.indexOf(value);
          const answer = realIdx >= 0 ? String(realIdx + 1) : String(value);
          await execFile("tmux", ["send-keys", "-l", "-t", record.tmuxName, answer]);
          await execFile("tmux", ["send-keys", "-t", record.tmuxName, "Enter"]);
          break;
        }
      }

    } else if (promptType === "confirm") {
      const title = _cleanPromptTitle(text);
      const { value } = await requestUserInput({
        cfg: _cfg, toUser: record.userId, type: "confirm",
        prompt: `[${record.name}] ${title}`, logger: _logger,
      });
      await execFile("tmux", ["send-keys", "-l", "-t", record.tmuxName, value ? "y" : "n"]);
      await execFile("tmux", ["send-keys", "-t", record.tmuxName, "Enter"]);
    }
  } catch (err) {
    // Timeout or cancellation — send Ctrl+C to unblock the session
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
      const date = new Date().toISOString().slice(0, 10);
      const key = `wecom-output/${date}/${Date.now()}-${record.name}.txt`;
      const url = await s3Client.upload(_cfg, { content: text, key });
      await sendText({
        cfg: _cfg, toUser: record.userId,
        text: `[${record.name}] 📄 输出较长，已上传：${url}`,
        logger: _logger,
      });
      return;
    } catch (err) {
      _logger?.warn?.(`wechat_work: S3 upload failed, falling back to text: ${err.message}`);
    }
  }

  const chunks = splitWecomText(`[${record.name}]\n${text.trim()}`);
  for (const chunk of chunks) {
    await sendText({ cfg: _cfg, toUser: record.userId, text: chunk, logger: _logger });
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _destroyRecord(record, userStore, name) {
  if (record.startupConfirmTimer) clearTimeout(record.startupConfirmTimer);
  record.watcherClose?.();
  if (record.flushTimer) clearTimeout(record.flushTimer);

  await execFile("tmux", ["kill-session", "-t", record.tmuxName]).catch(() => {});
  await fs.unlink(record.logFile).catch(() => {});
  await fs.unlink(record.metaFile).catch(() => {});

  userStore.sessions.delete(name);
  if (userStore.active === name) userStore.active = null;

  _logger?.info?.(`wechat_work: destroyed session name=${name} tmux=${record.tmuxName}`);
}

// ── Restart recovery ──────────────────────────────────────────────────────────

async function _cleanupStaleFiles() {
  let entries;
  try { entries = await fs.readdir(SESSION_DIR); } catch { return; }

  let liveIds = new Set();
  try {
    const { stdout } = await execFile("tmux", ["ls", "-F", "#{session_name}"]);
    for (const n of stdout.trim().split("\n")) {
      if (n.startsWith("wechat-")) liveIds.add(n.slice("wechat-".length));
    }
  } catch {}

  for (const entry of entries) {
    const m = entry.match(/^([0-9a-f]{8})\.(log|meta\.json)$/);
    if (!m) continue;
    if (!liveIds.has(m[1])) {
      await fs.unlink(path.join(SESSION_DIR, entry)).catch(() => {});
    }
  }
}

async function _recoverSessions() {
  let stdout;
  try {
    ({ stdout } = await execFile("tmux", ["ls", "-F", "#{session_name}"]));
  } catch { return; }

  const tmuxNames = stdout.trim().split("\n").filter(n => n.startsWith("wechat-"));

  for (const tmuxName of tmuxNames) {
    const shortId = tmuxName.slice("wechat-".length);
    const metaFile = path.join(SESSION_DIR, `${shortId}.meta.json`);
    const logFile = path.join(SESSION_DIR, `${shortId}.log`);

    let meta;
    try {
      meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
    } catch { continue; }

    const { userId, name, startedAt, tool } = meta;
    if (!userId || !name) continue;

    // Check if session already exists (prevents duplicate recovery on multiple init() calls)
    const userStore = getOrCreateUserStore(userId);
    if (userStore.sessions.has(name)) {
      _logger?.debug?.(`wechat_work: session already recovered, skipping name=${name} user=${userId}`);
      continue;
    }

    // Stop any existing pipe-pane, then reattach
    await execFile("tmux", ["pipe-pane", "-t", tmuxName]).catch(() => {});
    await execFile("tmux", ["pipe-pane", "-o", "-t", tmuxName, `cat >> ${logFile}`]).catch(() => {});

    // Snapshot current line count so we skip content from before restart
    let processedLines = 0;
    try {
      const { stdout: cap } = await execFile("tmux", ["capture-pane", "-p", "-S", "-", "-t", tmuxName]);
      processedLines = _parseCapture(cap).length;
    } catch {}

    const record = {
      shortId,
      name,
      tool: tool || "claude",
      startedAt: startedAt || Date.now(),
      tmuxName,
      logFile,
      metaFile,
      userId,
      processedLines,
      startupPhase: false,   // recovered sessions are already running
      startupConfirmTimer: null,
      flushTimer: null,
      watcherClose: null,
      dead: false,
      pendingPrompt: false,
    };

    _watchLogFile(record);
    userStore.sessions.set(name, record);

    _logger?.info?.(`wechat_work: recovered session name=${name} user=${userId}`);

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
    } catch {}

    for (const [userId, userStore] of store) {
      for (const [name, record] of userStore.sessions) {
        if (!record.dead && !liveSet.has(record.tmuxName)) {
          record.dead = true;
          if (record.startupConfirmTimer) clearTimeout(record.startupConfirmTimer);
          record.watcherClose?.();
          if (record.flushTimer) clearTimeout(record.flushTimer);
          if (userStore.active === name) userStore.active = null;

          _logger?.info?.(`wechat_work: session ended name=${name} user=${userId}`);
          await sendText({
            cfg: _cfg, toUser: userId,
            text: `[${name}] ✗ 会话已结束。`,
            logger: _logger,
          }).catch(() => {});
        }
      }
    }
  }, LIVENESS_INTERVAL_MS);
}
