---
title: "feat: CLI Direct PTY Sessions via tmux for Claude Code"
type: feat
date: 2026-03-23
brainstorm: docs/brainstorms/2026-03-23-cli-wrap-brainstorm.md
---

# feat: CLI Direct PTY Sessions via tmux for Claude Code

## Overview

Add a **direct CLI-to-WeChat bridge** that spawns Claude Code (and potentially other CLI tools) as real OS processes inside tmux sessions, proxying I/O directly between the process and WeChat Work messages — completely bypassing OpenClaw's AI dispatcher.

Users manage multiple named sessions (e.g. `spider-web`) per person. Output is buffered, ANSI-stripped, and delivered with a `[session-name]` prefix. Large output (>~6 KB) is uploaded to an S3-compatible store and delivered as a link. Sessions survive plugin restarts via tmux. Interactive prompts (tool permission cards, Y/N confirmations) are forwarded to WeChat as tappable button cards.

---

## Problem Statement

The current PTY approach routes everything through OpenClaw's AI runtime: `dispatchAI()` sends a `[SPAWN_SESSION]` directive, the AI executes `exec` + `process` tool calls, and `process-hooks.js` intercepts the results to forward them to WeChat. This chain:

- Adds latency (every keystroke goes through an LLM)
- Conflates Claude Code as both the channel user and the AI backend
- Cannot survive plugin restarts (PTY processes die with the AI session)
- Is fragile when OpenClaw's AI session state resets

The solution is a parallel execution path: when a user has an active tmux session, their WeChat messages are routed directly to `tmux send-keys`, and the session's stdout is watched from a log file and forwarded directly to WeChat. The OpenClaw AI path is untouched for users without active CLI sessions.

---

## Proposed Solution

### Architecture

```
User WeChat message
  │
  ▼
inbound-processor.js
  │
  ├─ (has pending interaction?) ──► interaction.js resolveInteraction()
  │
  ▼
dispatch.js → dispatchToAgent()
  │
  ├─ (active tmux session + not "/" command?) ──► session-manager.js sendInput()
  │                                                   └─► tmux send-keys -l -t {tmuxName} {text}
  │                                                   └─► tmux send-keys -t {tmuxName} Enter
  │
  └─ (no active session OR "/" command) ──► existing local commands or dispatchAI()


tmux session stdout
  └─► log file (/tmp/wechat-sessions/{sessionId}.log)
        └─► fs.watch → session-manager.js output pipeline
              ├─► read new bytes since last offset
              ├─► strip ANSI codes
              ├─► 500ms idle timer (per session)
              │     └─ on flush: detect prompts OR forward output
              ├─► (prompt detected?) ──► interaction.js requestUserInput()
              │                              └─► WeChat template card
              │                              └─► on response: tmux send-keys
              └─► (normal output, ≤6 KB?) ──► api-client.sendText() with [name] prefix
                   (normal output, >6 KB?) ──► s3-client.upload() → api-client.sendText(link)
```

### Key Design Decisions

#### 1. tmux Session Identity (solves the restart-recovery encoding problem)

**Do not encode userId in the tmux session name.** Instead:
- tmux session name: `wechat-{shortId}` where `shortId` is an 8-char hex random string (e.g. `wechat-a3f8c12e`)
- Metadata sidecar: `/tmp/wechat-sessions/{shortId}.meta.json`
  ```json
  { "userId": "ZhangSan", "name": "spider-web", "startedAt": 1711123456789, "tool": "claude" }
  ```
- On restart: `tmux ls -F "#{session_name}"` → filter `wechat-*` → read `.meta.json` for each → reconstruct store

This avoids all userId sanitization/collision problems and makes restart recovery 100% reliable.

#### 2. Shell Injection Prevention for `tmux send-keys`

**Use `child_process.execFile` with array arguments — never `exec` with string interpolation.**

```javascript
// SAFE — no shell involved:
await execFile('tmux', ['send-keys', '-l', '-t', tmuxName, text]);
await execFile('tmux', ['send-keys', '-t', tmuxName, 'Enter']);

// UNSAFE — shell injection possible:
exec(`tmux send-keys -t ${tmuxName} "${text}" Enter`);
```

The `-l` flag on the first call sends the text literally (no key-name interpretation). The second call sends Enter as a special key. This two-call pattern handles all input safely.

#### 3. Log File (not FIFO)

Use a regular append-only log file, not a named pipe. Named pipes block the writer if no reader is attached — `tmux pipe-pane` would stall if Node.js is not watching. A regular file is written unconditionally.

- Log file: `/tmp/wechat-sessions/{shortId}.log`
- Created by the plugin before starting `pipe-pane`
- Watched by Node.js with `fs.watch` + tracked byte offset
- On restart: reattach `pipe-pane` pointing to the existing file, watch from current end of file (skip historical content)
- Cleanup: deleted on `/kill` and on plugin startup for orphaned sessions (tmux session no longer exists)

#### 4. Output Pipeline (per-session)

```
file change event
  → read new bytes from lastOffset → advance lastOffset
  → append to per-session buffer
  → reset 500ms idle timer
  → on timer fire:
      1. Strip ANSI from buffer
      2. If empty after strip → discard, reset buffer
      3. If prompt pattern detected → prompt flow (pause forwarding)
      4. Else if byteLength > 6144 (3 × 2048) AND S3 configured → upload → send link
      5. Else → splitWecomText → sendText each chunk with [name] prefix
      6. Reset buffer
```

The idle timer is **per-session** (one `setTimeout` handle per `SessionRecord`).

#### 5. Prompt Detection Patterns

Conservative patterns derived from Claude Code's actual output:

```javascript
const PROMPT_PATTERNS = [
  // Numbered list of choices (2+ items, starting at 1)
  {
    type: 'choice',
    regex: /(?:\n|^)\s*1[.)]\s+\S.*(?:\n\s*\d+[.)]\s+\S.*){1,}/,
  },
  // Y/N or y/n inline prompt
  {
    type: 'confirm',
    regex: /\?\s*\(?(y(?:es)?)[/|](n(?:o)?)\)?\s*:?\s*$/im,
  },
  // (Y/n) or (y/N) style
  {
    type: 'confirm',
    regex: /\?\s*\(Y\/n\)\s*$|\?\s*\(y\/N\)\s*$/im,
  },
];
```

When a prompt is detected:
1. The buffer is **held** (not forwarded)
2. `interaction.js requestUserInput()` is called with the cleaned text
3. WeChat template card (for choice/confirm) or text message (for free-text) is sent
4. On user response → `tmux send-keys -l -t {name} {response}` + `Enter`
5. Buffer resumes forwarding

**Auto-confirm**: The trust prompt (containing `Do you trust the files in this folder?` or `1. Yes, trust` patterns) is auto-answered with `1` without asking the user.

---

## Technical Approach

### Implementation Phases

#### Phase 0: Bug Fixes (Prerequisite)

Fix the four known bugs in `dispatch.js` before this feature lands. These are blocking issues.

**File: `src/dispatch.js`**

- **`handleNew` undefined** (line ~322): Implement `handleNew({ fromUser })`. It should call `api.runtime.sessions.new()` or similar to start a fresh AI session, then reply with a confirmation message. Look at what `/new` is supposed to do (start fresh AI conversation) and implement it using the available `api.runtime` interface.
- **`handleStatus` call site** (line ~328): Change `handleStatus({ fromUser })` to `handleStatus({ api, cfg, fromUser, sessionId })` — pass all four params.
- **`FEEDBACK_FILE` Windows path** (line ~91): Replace `"C:\\home\\zongren\\.openclaw\\workspace\\memory"` with `path.join(os.homedir(), '.openclaw', 'workspace', 'memory')`. Add `import os from 'node:os'` if not already imported.
- **`runIdToUser` leak**: Call `clearRunId(runId)` at the end of `dispatchAI()` after the dispatch completes (in the `.finally()` handler or at the end of the try/catch block).

---

#### Phase 1: `src/session-manager.js` — Foundation

Create the new module. It is the heart of the feature.

**Exports:**
```javascript
export async function init(cfg, sendText, requestInput, logger) // called from index.js on startup
export async function spawnSession(userId, name, tool = 'claude') // returns { shortId, name }
export async function sendInput(userId, text)                    // routes to active session
export async function killSession(userId, name)                  // terminates tmux + cleanup
export async function exitSession(userId)                        // detach active (session stays)
export async function switchSession(userId, name)               // set active
export function listSessions(userId)                             // returns array of session info
export function getActiveSession(userId)                         // returns active SessionRecord or null
```

**Internal state:**
```javascript
// Map<userId, UserSessionState>
// UserSessionState = { active: string|null, sessions: Map<name, SessionRecord> }
// SessionRecord = { shortId, name, tool, startedAt, tmuxName, logFile, metaFile,
//                   watcherAbort, offset, buffer, flushTimer, dead: boolean }
const store = new Map();
```

**Key implementation details:**

```
spawnSession(userId, name, tool):
  1. Generate shortId = randomBytes(4).toString('hex')
  2. tmuxName = 'wechat-' + shortId
  3. logFile = '/tmp/wechat-sessions/' + shortId + '.log'
  4. metaFile = '/tmp/wechat-sessions/' + shortId + '.meta.json'
  5. mkdir -p /tmp/wechat-sessions/
  6. Write empty logFile (fs.writeFile with flag 'w')
  7. Write metaFile JSON
  8. execFile('tmux', ['new-session', '-d', '-s', tmuxName, '-c', homedir()])
  9. execFile('tmux', ['pipe-pane', '-o', '-t', tmuxName, 'cat >> ' + logFile])
  10. execFile('tmux', ['send-keys', '-t', tmuxName, tool, 'Enter'])
  11. Start file watcher → _watchLogFile(sessionRecord)
  12. Store record in userStore.sessions, set as active
  13. Return { shortId, name }

sendInput(userId, text):
  1. Get active session record for userId
  2. If none → throw "no active session"
  3. execFile('tmux', ['send-keys', '-l', '-t', record.tmuxName, text])
  4. execFile('tmux', ['send-keys', '-t', record.tmuxName, 'Enter'])

killSession(userId, name):
  1. Get session record from store
  2. Abort file watcher (record.watcherAbort())
  3. clearTimeout(record.flushTimer)
  4. execFile('tmux', ['kill-session', '-t', record.tmuxName]) — ignore ENOENT
  5. unlink(record.logFile), unlink(record.metaFile) — ignore ENOENT
  6. store.sessions.delete(name)
  7. If was active → clearActive

_watchLogFile(record):
  1. Use fs.watch(record.logFile, callback) — returns watcher
  2. Store AbortController; set record.watcherAbort = () => watcher.close()
  3. On 'change' event: read from record.offset to current file size → append to record.buffer
  4. Reset 500ms flush timer
  5. On flush timer fire: _flushBuffer(record)

_flushBuffer(record):
  1. text = stripAnsi(record.buffer); record.buffer = ''
  2. If empty → return
  3. If matches TRUST_PROMPT → auto-answer '1'
  4. If matches PROMPT_PATTERNS → _handlePrompt(record, text)
  5. Else if byteLength(text) > 6144 && s3Configured → _uploadAndLink(record, text)
  6. Else → chunks = splitWecomText('[' + record.name + '] ' + text)
             for each chunk → sendText(record.userId, chunk)
```

**ANSI stripping:** Use a comprehensive regex covering OSC 8 hyperlinks, bracketed paste mode, 256-color sequences:
```javascript
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|\(B)/g;
function stripAnsi(text) { return text.replace(ANSI_REGEX, ''); }
```

---

#### Phase 2: Routing Integration

**File: `src/dispatch.js`**

1. Add import: `import * as sessionManager from './session-manager.js'`

2. Add `/claude` command handler:
```javascript
// Before the existing command routing:
if (text.startsWith('/claude')) {
  const parts = text.trim().split(/\s+/);
  const name = parts[1] || generateSessionName(); // random adjective-noun
  const { shortId } = await sessionManager.spawnSession(fromUser, name, 'claude');
  await sendText({ cfg, toUser: fromUser, text: `Starting [${name}]... I'll let you know when Claude Code is ready.`, logger });
  return;
}
```

3. Add PTY routing guard **before** the AI dispatch call:
```javascript
// In dispatchToAgent(), before the local command checks:
const activeSession = sessionManager.getActiveSession(fromUser);
if (activeSession && !text.startsWith('/')) {
  await sessionManager.sendInput(fromUser, text);
  return; // bypass AI
}
```

4. Fix `/kill` to call `sessionManager.killSession()`:
```javascript
// In handleKill:
await sessionManager.killSession(fromUser, sessionName);
await sendText({ cfg, toUser: fromUser, text: `[${sessionName}] Session killed.`, logger });
```

5. Add `/exit` handler:
```javascript
if (text === '/exit') {
  sessionManager.exitSession(fromUser);
  await sendText({ cfg, toUser: fromUser, text: 'Detached from session. AI mode resumed.', logger });
  return;
}
```

6. Fix `/switch` to use `sessionManager.switchSession()` instead of in-memory manipulation.

7. Fix `/list` to use `sessionManager.listSessions()` which also shows dead/alive status.

8. Update `/status` to include session list from `sessionManager.listSessions(fromUser)`.

**File: `src/inbound-processor.js`**

No changes needed — the routing guard in `dispatch.js` is sufficient. The existing interaction intercept (checking `pendingInteractions` before dispatch) already works correctly for the PTY prompt flow.

---

#### Phase 3: Interactive Prompts

**File: `src/session-manager.js`** — add prompt handling

The `_flushBuffer` function detects prompts after stripping. When detected:

```javascript
async function _handlePrompt(record, text) {
  // 1. Check for trust prompt first — auto-confirm
  if (TRUST_PROMPT_REGEX.test(text)) {
    await execFile('tmux', ['send-keys', '-l', '-t', record.tmuxName, '1']);
    await execFile('tmux', ['send-keys', '-t', record.tmuxName, 'Enter']);
    return;
  }

  // 2. Detect type
  const choiceMatch = text.match(NUMBERED_LIST_REGEX);
  if (choiceMatch) {
    const options = extractNumberedOptions(text);  // ['Yes, allow once', 'Yes, always', 'No']
    const { value } = await requestInput(record.userId, {
      question: '[' + record.name + '] ' + text,
      type: 'choice',
      options: options.slice(0, 4),  // template card max 4 buttons
    });
    await execFile('tmux', ['send-keys', '-l', '-t', record.tmuxName, value]);
    await execFile('tmux', ['send-keys', '-t', record.tmuxName, 'Enter']);
    return;
  }

  const confirmMatch = CONFIRM_REGEX.test(text);
  if (confirmMatch) {
    const { value } = await requestInput(record.userId, {
      question: '[' + record.name + '] ' + text,
      type: 'confirm',
    });
    await execFile('tmux', ['send-keys', '-l', '-t', record.tmuxName, value]);
    await execFile('tmux', ['send-keys', '-t', record.tmuxName, 'Enter']);
    return;
  }

  // 3. Free-text prompt — send text and wait for any reply
  const { value } = await requestInput(record.userId, {
    question: '[' + record.name + '] ' + text,
    type: 'text',
  });
  await execFile('tmux', ['send-keys', '-l', '-t', record.tmuxName, value]);
  await execFile('tmux', ['send-keys', '-t', record.tmuxName, 'Enter']);
}
```

**Buffer behavior during pending prompt:** The file watcher continues reading but accumulates in `record.buffer` without flushing (the flush timer is suppressed while `record.pendingPrompt` is true).

**Timeout (5 minutes):** `requestInput` in `interaction.js` already times out after 5 minutes. On timeout, catch the rejection and send `\x03` (Ctrl+C):
```javascript
try {
  const { value } = await requestInput(...);
  // send value
} catch (err) {
  // timeout — send Ctrl+C
  await execFile('tmux', ['send-keys', '-t', record.tmuxName, 'C-c']);
  record.pendingPrompt = false;
}
```

---

#### Phase 4: `src/s3-client.js` — Large Output Upload

Thin S3 client using only Node.js built-ins (`node:crypto`, native `fetch`). Implements PUT Object with AWS Signature V4.

**Exports:**
```javascript
export async function upload(cfg, { content, filename }) // returns publicUrl
// cfg: { s3Endpoint, s3Bucket, s3AccessKey, s3SecretKey, s3Region = 'us-east-1' }
```

**Implementation sketch:**
```javascript
// Object key: wecom-output/{date}/{timestamp}-{filename}.txt
// URL: https://{bucket}.{endpoint}/{key}  (path-style for MinIO: {endpoint}/{bucket}/{key})
// Auth: AWS Sig V4 HMAC-SHA256 using node:crypto
// PUT the text/plain content with Content-Type header
// Return the public URL (no presigning — bucket assumed to allow public reads, or user configures accordingly)
```

**Error handling:**
- Network error → throw with message "S3 upload failed: network error"
- 4xx → throw with message "S3 upload failed: {status} {body}"
- On any error in `_flushBuffer` → log error, fall back to chunked text send

**In `session-manager.js`:**
```javascript
// s3 configured check:
const s3Configured = !!(cfg.s3Endpoint && cfg.s3Bucket && cfg.s3AccessKey && cfg.s3SecretKey);
```

**Object key format:**
```
wecom-output/YYYY-MM-DD/{timestamp}-{sessionName}.txt
```

---

#### Phase 5: Restart Recovery + Session Liveness

**File: `src/session-manager.js` — `init()` function**

Called from `index.js` once on plugin startup:

```javascript
export async function init(cfg, sendText, requestInput, logger) {
  _cfg = cfg; _sendText = sendText; _requestInput = requestInput; _logger = logger;
  await mkdirp('/tmp/wechat-sessions/');
  await _cleanupStaleFiles();    // delete .log/.meta.json files with no tmux session
  await _recoverSessions();      // reattach file watchers for live sessions
  _startLivenessCheck();         // 30s poll
}

async function _recoverSessions() {
  const { stdout } = await execFile('tmux', ['ls', '-F', '#{session_name}']);
  const tmuxNames = stdout.trim().split('\n').filter(n => n.startsWith('wechat-'));
  for (const tmuxName of tmuxNames) {
    const shortId = tmuxName.replace('wechat-', '');
    const metaFile = '/tmp/wechat-sessions/' + shortId + '.meta.json';
    let meta;
    try { meta = JSON.parse(await readFile(metaFile, 'utf8')); } catch { continue; }
    const { userId, name, startedAt, tool } = meta;
    const logFile = '/tmp/wechat-sessions/' + shortId + '.log';
    // Get current file size = starting offset (skip historical content)
    const { size } = await stat(logFile).catch(() => ({ size: 0 }));
    const record = { shortId, name, tool, startedAt, tmuxName, logFile, metaFile,
                     userId, offset: size, buffer: '', flushTimer: null, dead: false };
    // Reattach pipe-pane (in case it dropped when plugin died)
    await execFile('tmux', ['pipe-pane', '-t', tmuxName]).catch(() => {}); // stop existing
    await execFile('tmux', ['pipe-pane', '-o', '-t', tmuxName, 'cat >> ' + logFile]);
    _watchLogFile(record);
    _getOrCreateUserStore(userId).sessions.set(name, record);
    // Notify user
    await _sendText({ cfg, toUser: userId,
                      text: `[${name}] Session resumed after restart.`, logger });
  }
}

function _startLivenessCheck() {
  setInterval(async () => {
    const { stdout } = await execFile('tmux', ['ls', '-F', '#{session_name}']).catch(() => ({ stdout: '' }));
    const liveTmuxNames = new Set(stdout.trim().split('\n'));
    for (const [userId, userStore] of store) {
      for (const [name, record] of userStore.sessions) {
        if (!liveTmuxNames.has(record.tmuxName) && !record.dead) {
          record.dead = true;
          record.watcherAbort?.();
          if (userStore.active === name) userStore.active = null;
          await _sendText({ cfg, toUser: userId,
                            text: `[${name}] Session ended.`, logger }).catch(() => {});
        }
      }
    }
  }, 30_000);
}
```

---

#### Phase 6: Menu + Status Polish

**File: `src/menu.js`**

Add a top-level "Claude" menu button that sends `/claude` to spawn a new session:
```javascript
{ type: 'click', name: '启动 Claude', key: 'CMD_CLAUDE_NEW' }
```

Add to `MENU_KEY_MAP`:
```javascript
CMD_CLAUDE_NEW: '/claude',
```

**File: `src/dispatch.js` — `/status` handler update**

`handleStatus` should include a session list section:
```
Active sessions:
  [spider-web] claude  uptime: 2h 15m  ✓ alive
  [blue-fox]   claude  uptime: 0h 03m  ✓ alive  ← active
```

---

#### Phase 7: `openclaw.plugin.json` — S3 Config Schema

Add optional S3 fields to `configSchema.properties`:

```json
"s3Endpoint": {
  "type": "string",
  "description": "S3-compatible endpoint URL (e.g. https://minio.example.com)",
  "x-sensitive": false
},
"s3Bucket": {
  "type": "string",
  "description": "S3 bucket name for large output upload"
},
"s3AccessKey": {
  "type": "string",
  "description": "S3 access key ID",
  "x-sensitive": true
},
"s3SecretKey": {
  "type": "string",
  "description": "S3 secret access key",
  "x-sensitive": true
},
"s3Region": {
  "type": "string",
  "description": "S3 region (default: us-east-1)",
  "default": "us-east-1"
}
```

---

## Acceptance Criteria

### Functional Requirements

- [ ] `/claude spider-web` spawns a tmux session named `wechat-{shortId}`, starts `claude` inside it, and responds to the user immediately
- [ ] User text messages are forwarded to the active session stdin via `tmux send-keys -l`
- [ ] Session output is buffered with 500ms idle flush, ANSI-stripped, and sent with `[spider-web]` prefix
- [ ] Output >6 KB is uploaded to S3 and sent as a link (when S3 is configured)
- [ ] Output >6 KB falls back to chunked text when S3 is not configured
- [ ] The initial Claude Code trust prompt is auto-confirmed without user involvement
- [ ] Tool permission prompts are forwarded as WeChat template card buttons; user response is sent back
- [ ] Plugin restart recovers all live tmux sessions and notifies users
- [ ] `/list` shows all sessions with name, tool, uptime, alive/dead status
- [ ] `/switch <name>` changes the active session
- [ ] `/kill <name>` terminates the tmux session, cleans up log/meta files, updates store
- [ ] `/exit` detaches from active session; subsequent messages go to AI path
- [ ] `/claude` while another session is active creates the new session and makes it active
- [ ] Dead sessions (claude exited) are detected within 30 seconds and user is notified

### Non-Functional Requirements

- [ ] No shell command strings are constructed with user-controlled input — all `execFile` calls use array arguments
- [ ] `tmux send-keys` input uses `-l` flag to prevent key-name interpretation
- [ ] Session name validation: reject names that are only whitespace or >64 characters
- [ ] Maximum 10 sessions per user (return error message if exceeded)

### Bug Fixes Included

- [ ] `handleNew` is defined and `/new` + `/clear` commands work without ReferenceError
- [ ] `handleStatus` receives `api`, `cfg`, and `sessionId` at call site
- [ ] `FEEDBACK_FILE` uses `os.homedir()` instead of hardcoded Windows path
- [ ] `clearRunId` is called at end of `dispatchAI()` to prevent Map leak
- [ ] `/kill` actually terminates the tmux session (not just removes from in-memory store)

### Quality Gates

- [ ] No new npm dependencies added (uses only Node.js built-ins + existing `fast-xml-parser`)
- [ ] `process-hooks.js` behavior unchanged — hooks still fire for AI-dispatched sessions; tmux sessions never go through `dispatchAI` so hooks are never triggered for them (natural separation)

---

## Dependencies & Prerequisites

- **tmux** must be installed on the host machine and available in PATH
- **claude** (Claude Code CLI) must be installed and available in PATH
- S3 storage is optional; all S3 config fields are optional in the schema
- Node.js built-ins used: `node:child_process`, `node:fs/promises`, `node:os`, `node:crypto`, `node:path`, `node:timers`

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `tmux` not installed | Medium | Hard fail on `/claude` | Check on `init()`, log clear error, send user message if attempted |
| `claude` binary not in PATH | Low | Session spawns but immediately dies | Liveness check detects within 30s; show error in WeChat |
| `tmux send-keys -l` swallows newlines | Low | Input not reaching CLI | Test explicitly; fallback to sending `"\n"` literal if needed |
| File watcher misses events on Linux | Low | Output not forwarded | Add a 2s polling fallback using `fs.stat` + read when `fs.watch` is unreliable |
| `pipe-pane` command fails | Low | No output forwarded | Catch and report error to user; fallback message |
| S3 credentials invalid | Medium | Upload fails; fall back to text | Caught and logged; chunked text fallback is automatic |
| Large output exceeds WeCom rate limit (20 msg/20s) | Medium | Throttled | Existing 300ms delay between `sendText` calls already helps; accepted tradeoff |
| Two `pipe-pane` attach on restart (duplicate output) | Low | User sees doubled output | Always run `tmux pipe-pane -t {name}` (stop) before reattaching `-o` on restart |

---

## Alternative Approaches Considered

| Approach | Why Rejected |
|---|---|
| node-pty (native PTY) | Requires compiled C++ native addon; no restart survival; adds npm dependency |
| Custom daemon process | More moving parts; hardest to debug; overkill for this use case |
| AI-mediated (current approach) | Every keystroke adds LLM latency; AI session loss kills PTY; cannot survive restarts |
| Encode userId in tmux name | Encoding collisions; non-reversible sanitization; rejected in favor of sidecar metadata |

---

## Files Summary

### New Files
| File | Purpose |
|---|---|
| `src/session-manager.js` | tmux lifecycle, log file watching, output buffering, ANSI stripping, prompt detection, S3 dispatch |
| `src/s3-client.js` | S3-compatible PUT object with AWS Sig V4, using only `node:crypto` + `fetch` |

### Modified Files
| File | Changes |
|---|---|
| `src/dispatch.js` | Add `/claude`, `/exit`, fix `/kill`, PTY routing guard, fix 4 bugs (handleNew, handleStatus, FEEDBACK_FILE, runIdToUser) |
| `src/menu.js` | Add "启动 Claude" button, add `CMD_CLAUDE_NEW` to `MENU_KEY_MAP` |
| `src/index.js` | Call `sessionManager.init(cfg, sendText, requestInput, logger)` after plugin registration |
| `openclaw.plugin.json` | Add 5 optional S3 config fields to schema |

### Unchanged Files
| File | Reason |
|---|---|
| `src/process-hooks.js` | tmux sessions never call `dispatchAI`, so hooks never fire for them |
| `src/interaction.js` | Used as-is — `requestUserInput` and `resolveInteraction` are exactly what we need |
| `src/api-client.js` | Used as-is — `sendText` and `sendTemplateCard` are sufficient |
| `src/webhook-handler.js` | Untouched |
| `src/crypto.js` | Untouched |
| `src/dedup.js` | Untouched |
| `src/text-utils.js` | Used as-is |
| `src/xml-parser.js` | Untouched |

---

## References

### Internal References
- Brainstorm: `docs/brainstorms/2026-03-23-cli-wrap-brainstorm.md`
- Existing session store: `src/dispatch.js:8-76`
- Interaction system: `src/interaction.js:21-177`
- Existing ANSI stripping: `src/process-hooks.js:52-119`
- API client (sendText, sendTemplateCard): `src/api-client.js`
- Output chunking: `src/text-utils.js`
- Plugin config schema: `openclaw.plugin.json`

### External References
- tmux pipe-pane docs: `man tmux` (`pipe-pane` section)
- WeCom send text API: https://developer.work.weixin.qq.com/document/path/90238
- WeCom template card API: https://developer.work.weixin.qq.com/document/path/90241
- AWS Sig V4 signing: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
