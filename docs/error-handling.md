---
summary: "Error handling patterns, retry mechanisms, and troubleshooting for Telegram bot processing"
read_when:
  - Debugging bot errors or failures
  - Implementing error handling in extensions
  - Understanding retry behavior
---
# Error Handling

This document covers how Moltbot handles errors during Telegram bot processing, including retry mechanisms, error classification, and recovery patterns.

## Overview

Moltbot uses a layered error handling approach:

```
Layer 1: API Call Wrapper (withTelegramApiErrorLogging)
    ↓
Layer 2: Handler Try/Catch (bot.on handlers)
    ↓
Layer 3: Global Bot Catch (bot.catch)
    ↓
Layer 4: Process-Level Handlers (unhandledRejection)
```

Each layer catches errors that escape the previous layer, ensuring no error goes unlogged.

## How the Bot Reads Telegram Chats

### Connection Flow

```
Bot Token → grammY Bot Instance → Polling/Webhook → Message Handlers → Agent Dispatch
```

1. **Token Authentication**: Bot connects to Telegram using `Bot(token)` from grammY
2. **Update Delivery**: Either long-polling (`getUpdates`) or webhook receives messages
3. **Middleware Pipeline**: Updates pass through deduplication, sequentialization, and validation
4. **Handler Processing**: `bot.on("message")` handlers process each message type
5. **Agent Dispatch**: Valid messages are routed to AI agents for response generation

### Key Files

| File | Purpose |
|------|---------|
| `src/telegram/bot.ts` | Bot creation, middleware setup, sequentialization |
| `src/telegram/bot-handlers.ts` | Message, callback, reaction handlers |
| `src/telegram/monitor.ts` | Polling vs webhook mode selection |
| `src/telegram/webhook.ts` | Webhook HTTP server setup |
| `src/telegram/bot-message-dispatch.ts` | Agent routing and response delivery |

### Update Delivery Modes

**Polling Mode** (default):
- Uses `@grammyjs/runner` for concurrent update processing
- Automatic retry with exponential backoff (2s initial → 30s max)
- Handles getUpdates conflicts (409 errors)
- Configurable concurrency via `agents.defaults.maxConcurrent`

**Webhook Mode**:
- HTTP server on configurable port (default: 8787)
- POST requests to webhook path
- Optional secret token validation
- Health check endpoint at `/healthz`

### Message Processing Pipeline

1. **Update received** → Deduplication check (5 min TTL, max 2000 entries)
2. **Sender validation** → Allowlist check (`allowFrom`, `groupAllowFrom`)
3. **Media group buffering** → 500ms timeout to collect multi-image messages
4. **Text fragment reassembly** → Joins messages >4000 chars (1500ms timeout)
5. **Context building** → Chat info, history, thread ID, session key
6. **Agent dispatch** → Route to AI agent and return response

## Error Handling Layers

### Layer 1: API Call Wrapper

File: `src/telegram/api-logging.ts`

```typescript
withTelegramApiErrorLogging({
  operation: "sendMessage",
  fn: () => api.sendMessage(chatId, text),
  runtime,
  shouldLog: (err) => !isExpectedError(err),
})
```

**Behavior:**
- Wraps Telegram API calls
- Logs errors with operation context (e.g., "telegram sendMessage failed: ...")
- Supports selective logging via `shouldLog` callback
- Re-throws errors for higher-level handling

**When to use:** Wrap any direct Telegram Bot API call.

### Layer 2: Handler Try/Catch

File: `src/telegram/bot-handlers.ts`

```typescript
bot.on("message", async (ctx) => {
  try {
    // Process message
    await processMessage(ctx, media, allowFrom);
  } catch (err) {
    runtime.error?.(danger(`handler failed: ${String(err)}`));
  }
});
```

**Handlers with try/catch:**
- `bot.on("message")` - Text and media messages
- `bot.on("callback_query")` - Inline button presses
- `bot.on("message:migrate_to_chat_id")` - Group migrations
- `bot.on("message_reaction")` - Emoji reactions

**Behavior:** Logs errors and prevents handler crashes from affecting other updates.

### Layer 3: Global Bot Catch

File: `src/telegram/bot.ts`

```typescript
bot.catch((err) => {
  runtime.error?.(danger(`telegram bot error: ${formatUncaughtError(err)}`));
});
```

**Behavior:** Catches any middleware error that escapes handler try/catch blocks. Two handlers registered for redundancy.

### Layer 4: Process-Level Handlers

File: `src/index.ts`

```typescript
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});
```

**Behavior:** Last resort for truly unexpected errors. Logs and optionally exits.

## Retry Mechanism

### Configuration

File: `src/infra/retry-policy.ts`

```typescript
const TELEGRAM_RETRY_DEFAULTS = {
  attempts: 3,        // Maximum retry attempts
  minDelayMs: 400,    // Initial delay
  maxDelayMs: 30_000, // Maximum delay cap
  jitter: 0.1,        // Random variation (10%)
};
```

Override via config:
```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 5,
        minDelayMs: 500,
        maxDelayMs: 60000
      }
    }
  }
}
```

### Retry Triggers

Retries are attempted when the error message matches:
```
/429|timeout|connect|reset|closed|unavailable|temporarily/i
```

This covers:
- **429** - Rate limits (Too Many Requests)
- **timeout** - Request timeouts
- **connect** - Connection failures
- **reset** - Connection resets
- **closed** - Premature connection close
- **unavailable** - Service unavailable
- **temporarily** - Temporary failures

### Backoff Strategy

```
Attempt 1: 400ms (base delay)
Attempt 2: 800ms (400ms * 2^1)
Attempt 3: 1600ms (400ms * 2^2)
...capped at maxDelayMs (30s)
```

Jitter adds random variation to prevent thundering herd:
```typescript
delay = delay * (1 + (Math.random() - 0.5) * 2 * jitter)
```

### Rate Limit Awareness

When Telegram returns a 429 with `retry_after`, the retry respects it:
```typescript
// Telegram response: { parameters: { retry_after: 30 } }
// Moltbot waits: max(30000ms, minDelayMs)
```

## Network Error Classification

File: `src/telegram/network-errors.ts`

### Recoverable Error Codes

```typescript
ECONNRESET     // Connection reset by peer
ECONNREFUSED   // Connection refused
EPIPE          // Broken pipe
ETIMEDOUT      // Connection timed out
ESOCKETTIMEDOUT
ENETUNREACH    // Network unreachable
EHOSTUNREACH   // Host unreachable
ENOTFOUND      // DNS lookup failed
EAI_AGAIN      // DNS temporary failure
UND_ERR_CONNECT_TIMEOUT
UND_ERR_HEADERS_TIMEOUT
UND_ERR_BODY_TIMEOUT
UND_ERR_SOCKET
UND_ERR_ABORTED
ECONNABORTED
ERR_NETWORK
```

### Recoverable Error Names

```typescript
AbortError
TimeoutError
ConnectTimeoutError
HeadersTimeoutError
BodyTimeoutError
```

### Recoverable Message Snippets

```typescript
"fetch failed"
"typeerror: fetch failed"
"undici"
"network error"
"network request"
"client network socket disconnected"
"socket hang up"
"getaddrinfo"
```

### Usage

```typescript
import { isRecoverableTelegramNetworkError } from "./network-errors.js";

if (isRecoverableTelegramNetworkError(err, { context: "polling" })) {
  // Safe to retry
}
```

Context options: `"polling"`, `"send"`, `"webhook"`, `"unknown"`

## Recovery Patterns

### HTML Parse Fallback

File: `src/telegram/send.ts`

When Telegram rejects HTML formatting, Moltbot falls back to plain text:

```typescript
try {
  await api.sendMessage(chatId, htmlText, { parse_mode: "HTML" });
} catch (err) {
  if (/parse|entity|tag/i.test(err.message)) {
    // Retry without HTML
    await api.sendMessage(chatId, plainText);
  }
  throw err;
}
```

### Store Read Fallback

When allowlist store read fails, processing continues with empty allowlist:

```typescript
const storeAllowFrom = await readTelegramAllowFromStore().catch(() => []);
```

This appears throughout `bot-handlers.ts` to ensure store failures don't block message processing.

### Polling Auto-Restart

File: `src/telegram/monitor.ts`

```typescript
const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

while (!abortSignal?.aborted) {
  try {
    await runner.task();
  } catch (err) {
    if (isRecoverableTelegramNetworkError(err)) {
      const delay = computeBackoff(policy, attempts++);
      await sleep(delay);
      continue; // Restart polling
    }
    throw err; // Non-recoverable
  }
}
```

### Media Group Error Isolation

Each media group processes independently. Errors in one don't affect others:

```typescript
const processMediaGroup = async (entry) => {
  try {
    // Process all media in group
  } catch (err) {
    runtime.error?.(`media group handler failed: ${err}`);
    // Error logged, other groups continue
  }
};
```

## Troubleshooting Guide

### Bot Not Responding

1. **Check logs**: `moltbot logs --follow`
2. **Verify token**: Ensure `TELEGRAM_BOT_TOKEN` or config `botToken` is set
3. **Check network**: `curl https://api.telegram.org/bot<token>/getMe`
4. **Review health**: `GET /health` should return `{"status":"ok"}`

### Rate Limit Errors (429)

**Symptoms:** "Too Many Requests" errors in logs

**Solutions:**
1. Increase retry delays in config
2. Reduce message sending frequency
3. Check for infinite loops in handlers
4. Use API throttler (enabled by default)

### Connection Errors

**Symptoms:** `ECONNRESET`, `ETIMEDOUT`, `fetch failed`

**Solutions:**
1. Check network connectivity
2. Verify DNS resolution: `dig api.telegram.org`
3. Check proxy settings if using `channels.telegram.proxy`
4. For IPv6 issues, see Telegram docs troubleshooting section

### Webhook Failures

**Symptoms:** Webhook not receiving updates

**Solutions:**
1. Verify public URL is accessible
2. Check SSL certificate validity
3. Confirm secret token matches config
4. Review webhook logs: `moltbot logs --follow`

### Message Not Delivered

**Symptoms:** Bot receives message but user doesn't get response

**Solutions:**
1. Check for errors in handler logs
2. Verify chat ID is correct
3. Check if user blocked the bot
4. Review agent processing logs

## Error Logging Reference

### Log Formats

```
telegram sendMessage failed: <error message>
telegram bot error: <stack trace>
handler failed: <error message>
media group handler failed: <error message>
callback handler failed: <error message>
telegram debounce flush failed: <error message>
```

### Subsystem Loggers

Enable verbose logging for specific subsystems:

```json5
{
  diagnostics: {
    "telegram.http": true,      // HTTP request/response logging
    "telegram.raw-update": true // Raw update logging
  }
}
```

### Error Formatting

File: `src/infra/errors.ts`

```typescript
formatErrorMessage(err)     // Short message only
formatUncaughtError(err)    // Full stack trace for uncaught errors
extractErrorCode(err)       // Extract error code (e.g., "ECONNRESET")
```

## Summary Table

| Pattern | Location | Behavior |
|---------|----------|----------|
| API error logging | `api-logging.ts` | Logs with context, re-throws |
| Handler try/catch | `bot-handlers.ts` | Logs, prevents crash |
| Global bot.catch | `bot.ts` | Catches middleware escapes |
| Retry with backoff | `retry-policy.ts` | Exponential + jitter |
| Rate limit respect | `retry-policy.ts` | Honors `retry_after` |
| HTML fallback | `send.ts` | Falls back to plain text |
| Store fallback | `bot-handlers.ts` | Defaults to empty array |
| Poll restart | `monitor.ts` | Auto-restart with backoff |
| Error classification | `network-errors.ts` | Recoverable vs fatal |
