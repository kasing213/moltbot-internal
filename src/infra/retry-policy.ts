/**
 * Retry Policy Configuration
 *
 * This module provides channel-specific retry runners for Discord and Telegram.
 * Retry runners wrap API calls with exponential backoff, jitter, and rate-limit
 * awareness to handle transient failures gracefully.
 *
 * Key Features:
 * - Exponential backoff: delay doubles after each attempt
 * - Jitter: random variation prevents thundering herd
 * - Rate-limit awareness: respects Telegram's retry_after header
 * - Configurable via channel config (e.g., channels.telegram.retry)
 *
 * @see docs/error-handling.md for full documentation
 */

import { RateLimitError } from "@buape/carbon";

import { formatErrorMessage } from "./errors.js";
import { type RetryConfig, resolveRetryConfig, retryAsync } from "./retry.js";

export type RetryRunner = <T>(fn: () => Promise<T>, label?: string) => Promise<T>;

/** Discord retry defaults - used for Discord API rate limits */
export const DISCORD_RETRY_DEFAULTS = {
  attempts: 3,        // Max retry attempts before giving up
  minDelayMs: 500,    // Initial delay (doubles each attempt)
  maxDelayMs: 30_000, // Maximum delay cap
  jitter: 0.1,        // 10% random variation to prevent thundering herd
};

/**
 * Telegram retry defaults - used for Bot API transient errors.
 * Slightly faster initial delay than Discord since Telegram rate limits
 * are typically shorter.
 */
export const TELEGRAM_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 400,
  maxDelayMs: 30_000,
  jitter: 0.1,
};

/**
 * Pattern matching errors that should trigger a retry.
 * Covers: rate limits (429), timeouts, connection issues, service unavailability.
 */
const TELEGRAM_RETRY_RE = /429|timeout|connect|reset|closed|unavailable|temporarily/i;

function getTelegramRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate =
    "parameters" in err && err.parameters && typeof err.parameters === "object"
      ? (err.parameters as { retry_after?: unknown }).retry_after
      : "response" in err &&
          err.response &&
          typeof err.response === "object" &&
          "parameters" in err.response
        ? (
            err.response as {
              parameters?: { retry_after?: unknown };
            }
          ).parameters?.retry_after
        : "error" in err && err.error && typeof err.error === "object" && "parameters" in err.error
          ? (err.error as { parameters?: { retry_after?: unknown } }).parameters?.retry_after
          : undefined;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate * 1000 : undefined;
}

export function createDiscordRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(DISCORD_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });
  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry: (err) => err instanceof RateLimitError,
      retryAfterMs: (err) => (err instanceof RateLimitError ? err.retryAfter * 1000 : undefined),
      onRetry: params.verbose
        ? (info) => {
            const labelText = info.label ?? "request";
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            console.warn(
              `discord ${labelText} rate limited, retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms`,
            );
          }
        : undefined,
    });
}

/**
 * Creates a retry runner for Telegram Bot API calls.
 *
 * The runner wraps async functions with automatic retry on transient errors:
 * - 429 rate limits (respects retry_after from Telegram)
 * - Network timeouts and connection resets
 * - Temporary service unavailability
 *
 * @example
 * ```typescript
 * const retry = createTelegramRetryRunner({ verbose: true });
 * const result = await retry(
 *   () => api.sendMessage(chatId, text),
 *   "sendMessage"
 * );
 * ```
 *
 * @param params.retry - Override retry config for this runner
 * @param params.configRetry - Channel config retry settings (from channels.telegram.retry)
 * @param params.verbose - Log retry attempts to console
 * @param params.shouldRetry - Custom predicate to determine if error is retryable
 * @returns A retry runner function that wraps async operations
 */
export function createTelegramRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
  shouldRetry?: (err: unknown) => boolean;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(TELEGRAM_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });

  // Combine custom shouldRetry with default pattern matching
  const shouldRetry = params.shouldRetry
    ? (err: unknown) => params.shouldRetry?.(err) || TELEGRAM_RETRY_RE.test(formatErrorMessage(err))
    : (err: unknown) => TELEGRAM_RETRY_RE.test(formatErrorMessage(err));

  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry,
      retryAfterMs: getTelegramRetryAfterMs, // Respects Telegram's rate limit headers
      onRetry: params.verbose
        ? (info) => {
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            console.warn(
              `telegram send retry ${info.attempt}/${maxRetries} for ${info.label ?? label ?? "request"} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`,
            );
          }
        : undefined,
    });
}
