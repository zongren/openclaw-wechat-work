# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw WeChat Work (`@anthropic/openclaw-wechat-work`) — a WeCom (企业微信) channel plugin for the OpenClaw AI assistant framework. It enables AI conversations through WeChat Work's self-built application messaging channel.

## Development

- **Runtime:** Node.js with ES modules (no build or transpilation step)
- **Dependencies:** Install with `npm install`
- **No build/test/lint scripts** are configured — this is a plugin loaded by the OpenClaw runtime, not a standalone app
- **Single dependency:** `fast-xml-parser` for XML handling

## Architecture

### Data Flow

```
WeCom Server → POST /wecom/callback (encrypted XML)
  → webhook-handler.js (verify signature, decrypt, dedup)
  → inbound-processor.js (route by msgType: text/event, check for local commands)
  → dispatch.js (build context, call OpenClaw runtime dispatcher, deliver replies)
  → api-client.js (get access token, chunk message at 2048 bytes, POST to WeCom API)
  → WeCom Server → User
```

### Key Modules

- **index.js** — Entry point; registers the channel plugin with OpenClaw and fires off agent menu creation
- **channel-plugin.js** — Implements OpenClaw channel contract (capabilities: direct chat only); exposes `sendText()` and `deliverReply()`
- **webhook-handler.js** — HTTP handler for GET (URL verification) and POST (message ingestion); returns 200 immediately and processes async
- **inbound-processor.js** — Routes text messages to AI and events (menu clicks, subscribe) to handlers; supports local commands (`/status`, `/reasoning`, `/about`, `/feedback`)
- **dispatch.js** — Bridges to `api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher()`; manages per-user state (reasoning mode, feedback mode)
- **api-client.js** — WeCom API client with token caching (7200s TTL); handles message chunking at 2048-byte limit
- **crypto.js** — AES-256-CBC encryption/decryption with PKCS7 padding; SHA1 signature validation
- **xml-parser.js** — XML parsing with `fast-xml-parser`; includes `readRequestBody()` with 1MB limit
- **dedup.js** — Message deduplication with 5-minute TTL cache; keys on MsgId or composite of (fromUser|createTime|msgType|content)
- **text-utils.js** — `splitWecomText()` uses binary search chunking at 2048 bytes, preferring natural breaks (double newline, single newline, Chinese period)
- **menu.js** — Three-level WeCom agent menu definition (Chinese labels); `MENU_KEY_MAP` maps menu keys to commands

### Plugin Configuration

Defined in `openclaw.plugin.json` with JSON Schema. Required config: `corpId`, `corpSecret`, `agentId`, `callbackToken`, `callbackAesKey`. Optional: `webhookPath` (default `/wecom/callback`). Sensitive fields marked with `x-sensitive: true`.

### Key Design Decisions

- All inbound messages are processed fire-and-forget (return 200 immediately)
- Message chunking uses binary search for optimal split points within WeCom's 2048-byte text limit
- Per-user state (reasoning mode, feedback mode) is stored in-memory in `dispatch.js`
- Feedback is persisted to `~/.openclaw/workspace/memory/wechat-feedback.md`

### Official documentation links

#### Wechat work app send message
wechat app send message to openclaw
https://developer.work.weixin.qq.com/document/path/90238
https://developer.work.weixin.qq.com/document/path/90239
https://developer.work.weixin.qq.com/document/path/90240
https://developer.work.weixin.qq.com/document/path/90241
    
#### Wechat work app receive message
openclaw send message to wechat app
https://developer.work.weixin.qq.com/document/path/90236

#### Wechat work app menus
https://developer.work.weixin.qq.com/document/path/90231

#### Openclaw plugin
https://docs.openclaw.ai/tools/plugin