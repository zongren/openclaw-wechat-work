# CLI Wrap: Direct PTY Sessions via WeChat Work

**Date:** 2026-03-23
**Status:** Brainstormed, ready for planning

---

## What We're Building

A direct CLI-to-WeChat bridge that spawns Claude Code as a real child process using tmux, proxying I/O directly between the CLI and WeChat Work messages — **bypassing OpenClaw's AI dispatcher entirely**.

Users manage multiple named sessions (e.g. `spider-web`) per person, send input as WeChat messages, and receive buffered output prefixed with `[session-name]`. Sessions survive plugin restarts via tmux. Large output goes to S3-compatible storage as a linked file.

---

## Why This Approach

**tmux-based sessions** were chosen over node-pty or a custom daemon because:

- tmux is a proven terminal multiplexer — restart survival is built-in
- Named sessions map naturally to tmux session names (`wechat-{userId}-{name}`)
- `tmux pipe-pane` provides streaming output capture without native addon dependencies
- No new Node.js native dependencies (node-pty requires compiled C++)
- Easy external debugging: `tmux attach -t wechat-{userId}-{name}`

**S3-compatible storage** for large output was chosen because:
- User operates their own S3-compatible service (MinIO, R2, etc.)
- Sending a link avoids WeChat message flood and keeps chat readable
- Plugin config holds S3 endpoint/credentials

---

## Key Decisions

### 1. Session Naming Convention
- tmux session name: `wechat-{sanitizedUserId}-{name}` (e.g. `wechat-user123-spider-web`)
- Session names: alphanumeric + hyphens, auto-generated if omitted (e.g. `blue-fox`)
- Multiple sessions per user; one **active** session receives input by default
- `/switch <name>` to change active session; `/list` to view all

### 2. Starting a Session
- Command: `/claude <name>` (name optional, random if omitted)
- Or via a WeChat Work agent menu button ("Start Claude")
- Working directory: user home (`~`)
- tmux command sequence:
  ```
  tmux new-session -d -s wechat-{userId}-{name} -c ~
  tmux send-keys -t wechat-{userId}-{name} "claude" Enter
  tmux pipe-pane -o -t wechat-{userId}-{name} "cat >> {fifo_path}"
  ```

### 3. Output Routing
- Buffer with 500ms idle flush (timer resets on each new chunk)
- Strip ANSI escape codes before forwarding
- Prefix every WeChat message with `[session-name]`
- Split via existing `splitWecomText()` (2048-byte limit per chunk)
- **Flood threshold**: if flush produces > ~3 message chunks (≈6 KB), upload to S3 instead
  - Write to temp file → upload to S3-compatible storage → send WeChat message with link
  - S3 config: `s3Endpoint`, `s3Bucket`, `s3AccessKey`, `s3SecretKey` in plugin config (optional fields)
  - If S3 not configured, fall back to chunked text messages

### 4. Input Routing
- When user has an active session and sends a non-`/` command message → `tmux send-keys -t <session> "{message}" Enter`
- Active session = last-used or explicitly switched via `/switch`
- Commands still work normally (`/status`, `/list`, `/switch`, `/kill`, `/claude`)

### 5. Interactive Prompts
- Auto-confirm the Claude Code initial trust prompt (`1\n`)
- For other detected prompts (tool permission requests, Y/N confirmations, numbered choices):
  - **Numbered list detected** → send WeChat template card with tappable buttons (up to 4), using existing `interaction.js` `requestUserInput()`
  - **Yes/No prompt** → template card with "Yes" / "No" buttons
  - **Free-text prompt** (e.g. "Enter filename:") → send prompt text to WeChat, accept next text reply
  - 5-minute timeout; if no response, send `\x03` (Ctrl+C) to abort
- Prompt detection heuristics: numbered-list pattern, `?` at end of last line, common confirm phrases

### 6. Restart Survival
- On plugin startup:
  ```
  tmux ls -F "#{session_name}" | grep "^wechat-"
  ```
- Reattach `pipe-pane` for each discovered session
- Restore in-memory session registry
- Notify user: `[spider-web] ♻ Session resumed after restart`

### 7. Bypass Path in Dispatch
- `dispatch.js`: if user has an active direct CLI session and message is not `/` → route to `session-manager.js`, skip `dispatchAI()`
- AI dispatch path remains unchanged for users without active CLI sessions

### 8. Session Management Commands
| Command | Action |
|---|---|
| `/claude [name]` | Spawn new Claude Code session |
| `/list` | List all sessions for this user (name, status, uptime) |
| `/switch <name>` | Set active session for input routing |
| `/kill <name>` | Kill tmux session + clean up FIFO |
| `/exit` | Detach from current session (session stays alive) |

### 9. Menu Integration
- Add "Start Claude" button to WeCom agent menu (`menu.js`)
- `/status` shows running CLI sessions alongside OpenClaw AI status

---

## Scope of Changes

### New files
- `src/session-manager.js` — tmux lifecycle, FIFO reading, output buffering, ANSI stripping, prompt detection, S3 upload
- `src/s3-client.js` — S3-compatible upload client (thin wrapper, only what's needed for file upload + public URL generation)

### Modified files
- `src/dispatch.js`
  - Add active-session routing guard before `dispatchAI()`
  - Add `/claude` command handler
  - Fix `handleNew` (undefined function — causes ReferenceError)
  - Fix `/kill` to call `session-manager.killSession()` instead of just removing from store
  - Fix `FEEDBACK_FILE` (hardcoded Windows path → `os.homedir()`)
  - Fix `runIdToUser` leak (call `clearRunId` when session ends)
- `src/menu.js` — add "Start Claude" button
- `src/inbound-processor.js` — minor routing to session-manager for active sessions
- `openclaw.plugin.json` — add optional S3 config fields to schema

---

## Open Questions (Resolved)

| Question | Decision |
|---|---|
| Working directory | User home (`~`) |
| Claude Code flags | Run interactive (no `--print`), handle prompts via WeChat |
| Large output | S3 upload + link; chunked text fallback if S3 not configured |
| FIFO cleanup | On `/kill` or session exit; also on plugin startup (stale FIFOs) |
| userId safety in tmux names | Sanitize to `[a-zA-Z0-9-]` before use |
| Upload API | S3-compatible; user deploys their own instance |
| Prompt UX | Template card buttons for choices; text reply for free-text; auto-confirm trust |

---

## Success Criteria

- `/claude spider-web` spawns a real Claude Code process in a tmux session
- User messages → Claude Code stdin; responses arrive as `[spider-web] ...` in WeChat
- Plugin restart reconnects to existing sessions automatically
- Interactive prompts (tool permission, etc.) delivered as tappable WeChat cards
- Large output uploaded to S3 and linked, not flooded as messages
- `/list`, `/switch`, `/kill` work as expected
- Known bugs fixed: `handleNew`, `/kill` signal, FEEDBACK_FILE path, `runIdToUser` leak
