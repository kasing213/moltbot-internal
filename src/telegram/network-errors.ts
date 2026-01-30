/**
 * Telegram Network Error Classification
 *
 * This module determines whether a network error is recoverable (can be retried)
 * or fatal (should be propagated). It supports deep inspection of error chains
 * including cause, reason, and nested errors.
 *
 * Classification is used by:
 * - Polling restart logic (monitor.ts) - to decide if polling should restart
 * - Retry runners (retry-policy.ts) - to decide if an operation should retry
 * - Webhook handlers (webhook.ts) - to classify failures for logging
 *
 * @see docs/error-handling.md for full documentation
 */

import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";

/**
 * System-level error codes that indicate transient network issues.
 * These are safe to retry as they typically resolve on their own.
 */
const RECOVERABLE_ERROR_CODES = new Set([
  "ECONNRESET",     // Connection reset by peer (server closed connection)
  "ECONNREFUSED",   // Connection refused (server not listening)
  "EPIPE",          // Broken pipe (write to closed connection)
  "ETIMEDOUT",      // Connection timed out
  "ESOCKETTIMEDOUT",
  "ENETUNREACH",    // Network unreachable (routing issue)
  "EHOSTUNREACH",   // Host unreachable
  "ENOTFOUND",      // DNS lookup failed (hostname not found)
  "EAI_AGAIN",      // DNS temporary failure (try again)
  // Undici (Node's fetch) specific errors
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ECONNABORTED",
  "ERR_NETWORK",
]);

/**
 * Error class names that indicate recoverable conditions.
 * These are typically thrown by fetch/HTTP libraries for timeouts.
 */
const RECOVERABLE_ERROR_NAMES = new Set([
  "AbortError",           // Request was aborted (timeout or cancel)
  "TimeoutError",         // Generic timeout
  "ConnectTimeoutError",  // Connection phase timeout
  "HeadersTimeoutError",  // Waiting for headers timeout
  "BodyTimeoutError",     // Waiting for body timeout
]);

/**
 * Message substrings that indicate recoverable network issues.
 * Used as fallback when error code/name isn't available.
 * Note: Message matching is disabled for "send" context to avoid
 * retrying user-facing errors that look like network errors.
 */
const RECOVERABLE_MESSAGE_SNIPPETS = [
  "fetch failed",
  "typeerror: fetch failed",
  "undici",
  "network error",
  "network request",
  "client network socket disconnected",
  "socket hang up",
  "getaddrinfo",
];

function normalizeCode(code?: string): string {
  return code?.trim().toUpperCase() ?? "";
}

function getErrorName(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  return "name" in err ? String(err.name) : "";
}

function getErrorCode(err: unknown): string | undefined {
  const direct = extractErrorCode(err);
  if (direct) return direct;
  if (!err || typeof err !== "object") return undefined;
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === "string") return errno;
  if (typeof errno === "number") return String(errno);
  return undefined;
}

function collectErrorCandidates(err: unknown): unknown[] {
  const queue = [err];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    candidates.push(current);

    if (typeof current === "object") {
      const cause = (current as { cause?: unknown }).cause;
      if (cause && !seen.has(cause)) queue.push(cause);
      const reason = (current as { reason?: unknown }).reason;
      if (reason && !seen.has(reason)) queue.push(reason);
      const errors = (current as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const nested of errors) {
          if (nested && !seen.has(nested)) queue.push(nested);
        }
      }
    }
  }

  return candidates;
}

/**
 * Context in which the error occurred. Affects how errors are classified:
 * - "polling": Long-polling getUpdates - aggressive retry
 * - "send": Sending messages - conservative (no message matching)
 * - "webhook": Webhook handler - moderate retry
 * - "unknown": Default behavior
 */
export type TelegramNetworkErrorContext = "polling" | "send" | "webhook" | "unknown";

/**
 * Determines if a Telegram network error is recoverable (safe to retry).
 *
 * Inspects the full error chain including:
 * - Direct error code/name
 * - error.cause chain
 * - error.reason (Promise rejection reason)
 * - error.errors array (AggregateError)
 *
 * @example
 * ```typescript
 * try {
 *   await api.sendMessage(chatId, text);
 * } catch (err) {
 *   if (isRecoverableTelegramNetworkError(err, { context: "send" })) {
 *     // Safe to retry
 *   } else {
 *     // Fatal error, don't retry
 *   }
 * }
 * ```
 *
 * @param err - The error to classify
 * @param options.context - Where the error occurred (affects matching strategy)
 * @param options.allowMessageMatch - Override message matching behavior
 * @returns true if the error is recoverable and should be retried
 */
export function isRecoverableTelegramNetworkError(
  err: unknown,
  options: { context?: TelegramNetworkErrorContext; allowMessageMatch?: boolean } = {},
): boolean {
  if (!err) return false;

  // For "send" context, disable message matching to avoid retrying
  // user-visible errors that happen to contain network-like text
  const allowMessageMatch =
    typeof options.allowMessageMatch === "boolean"
      ? options.allowMessageMatch
      : options.context !== "send";

  for (const candidate of collectErrorCandidates(err)) {
    const code = normalizeCode(getErrorCode(candidate));
    if (code && RECOVERABLE_ERROR_CODES.has(code)) return true;

    const name = getErrorName(candidate);
    if (name && RECOVERABLE_ERROR_NAMES.has(name)) return true;

    if (allowMessageMatch) {
      const message = formatErrorMessage(candidate).toLowerCase();
      if (message && RECOVERABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
        return true;
      }
    }
  }

  return false;
}
