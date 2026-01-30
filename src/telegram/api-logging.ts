/**
 * Telegram API Error Logging
 *
 * This module provides a wrapper for Telegram API calls that ensures consistent
 * error logging across all Bot API operations. It's the first layer of error
 * handling in the Telegram integration stack.
 *
 * Error Handling Flow:
 *   1. withTelegramApiErrorLogging (this module) - logs API errors with context
 *   2. Handler try/catch (bot-handlers.ts) - catches handler-level errors
 *   3. bot.catch (bot.ts) - catches escaped middleware errors
 *
 * @see docs/error-handling.md for full documentation
 */

import { danger } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";

export type TelegramApiLogger = (message: string) => void;

type TelegramApiLoggingParams<T> = {
  operation: string;
  fn: () => Promise<T>;
  runtime?: RuntimeEnv;
  logger?: TelegramApiLogger;
  shouldLog?: (err: unknown) => boolean;
};

const fallbackLogger = createSubsystemLogger("telegram/api");

function resolveTelegramApiLogger(runtime?: RuntimeEnv, logger?: TelegramApiLogger) {
  if (logger) return logger;
  if (runtime?.error) return runtime.error;
  return (message: string) => fallbackLogger.error(message);
}

/**
 * Wraps a Telegram API call with consistent error logging.
 *
 * This is the primary error handling wrapper for all Telegram Bot API operations.
 * It logs errors with the operation name for context, then re-throws so callers
 * can implement retry logic or handle specific error types.
 *
 * @example
 * ```typescript
 * await withTelegramApiErrorLogging({
 *   operation: "sendMessage",
 *   fn: () => api.sendMessage(chatId, text),
 *   runtime,
 *   shouldLog: (err) => !isExpectedChatNotFoundError(err),
 * });
 * ```
 *
 * @param operation - Name of the API operation (e.g., "sendMessage", "editMessage")
 * @param fn - Async function that performs the API call
 * @param runtime - Optional runtime environment for logging
 * @param logger - Optional custom logger function
 * @param shouldLog - Optional predicate to filter which errors get logged
 * @returns The result of fn() if successful
 * @throws The original error after logging (for retry handling upstream)
 */
export async function withTelegramApiErrorLogging<T>({
  operation,
  fn,
  runtime,
  logger,
  shouldLog,
}: TelegramApiLoggingParams<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // Log error unless shouldLog returns false (for expected/ignorable errors)
    if (!shouldLog || shouldLog(err)) {
      const errText = formatErrorMessage(err);
      const log = resolveTelegramApiLogger(runtime, logger);
      log(danger(`telegram ${operation} failed: ${errText}`));
    }
    // Always re-throw: callers handle retries via retry-policy.ts
    throw err;
  }
}
