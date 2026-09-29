import { Context, NextFunction } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

/** Throttle repeated unauthorized-attempt warnings (once per user per 10 min). */
const UNAUTHORIZED_LOG_INTERVAL_MS = 10 * 60_000;
const lastUnauthorizedLogAt = new Map<number, number>();

function logUnauthorizedAttempt(userId: number | undefined): void {
  const key = userId ?? 0;
  const now = Date.now();
  if (now - (lastUnauthorizedLogAt.get(key) ?? 0) < UNAUTHORIZED_LOG_INTERVAL_MS) {
    return;
  }
  lastUnauthorizedLogAt.set(key, now);
  logger.warn(`Unauthorized access attempt from user ID: ${userId}`);
}

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  // Service updates for our OWN actions (e.g. the pinned_message Telegram
  // emits when the bot creates its dashboard pin) arrive with the bot itself
  // as `from` — they are not intruders and must be ignored silently.
  if (ctx.from?.is_bot) {
    logger.debug(`[Auth] Ignoring bot-originated update from ${ctx.from.id}`);
    return;
  }

  const userId = ctx.from?.id;

  logger.debug(
    `[Auth] Checking access: userId=${userId}, allowedUserId=${config.telegram.allowedUserId}, hasCallbackQuery=${!!ctx.callbackQuery}, hasMessage=${!!ctx.message}`,
  );

  if (userId && userId === config.telegram.allowedUserId) {
    logger.debug(`[Auth] Access granted for userId=${userId}`);
    await next();
  } else {
    // Silently ignore unauthorized users
    logUnauthorizedAttempt(userId);

    // Actively hide commands for unauthorized users by setting empty command list
    // Only do this if the chat is NOT the authorized user's chat
    // (to avoid resetting commands when forwarded messages are received)
    if (ctx.chat?.id && ctx.chat.id !== config.telegram.allowedUserId) {
      try {
        // Set empty commands for this specific chat (more reliable than deleteMyCommands)
        await ctx.api.setMyCommands([], {
          scope: { type: "chat", chat_id: ctx.chat.id },
        });
        logger.debug(`[Auth] Set empty commands for unauthorized chat_id=${ctx.chat.id}`);
      } catch (err) {
        // Ignore errors
        logger.debug(`[Auth] Could not set empty commands: ${err}`);
      }
    }
  }
}
