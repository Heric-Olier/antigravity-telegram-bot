import { CommandContext, Context } from "grammy";
import { getCurrentSession } from "../../app/services/session-service.js";
import { clearAllInteractionState } from "../../app/managers/interaction-manager.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { markAttachedSessionIdle } from "../../app/services/attach-service.js";
import { clearPromptResponseMode } from "../handlers/prompt.js";
import { markUserAbortRequested } from "../../app/managers/abort-suppression-manager.js";
import { promptQueue } from "../../app/managers/prompt-queue-manager.js";
import { promptAttachment } from "../../app/managers/prompt-attachment-manager.js";
import { interruptActiveTurn } from "../../antigravity/events.js";

interface AbortCurrentOperationOptions {
  notifyUser?: boolean;
}

async function releaseAbortBusyState(sessionId: string, reason: string): Promise<void> {
  foregroundSessionState.markIdle(sessionId);
  assistantRunState.clearRun(sessionId, reason);
  await markAttachedSessionIdle(sessionId);
  clearPromptResponseMode(sessionId);
}

export async function abortCurrentOperation(
  ctx: Context,
  options: AbortCurrentOperationOptions = {},
): Promise<void> {
  const notifyUser = options.notifyUser ?? true;

  try {
    clearAllInteractionState("abort_command");
    promptQueue.clear("abort_command");
    promptAttachment.clear("abort_command");

    const currentSession = getCurrentSession();

    if (!currentSession) {
      if (notifyUser) {
        await ctx.reply(t("stop.no_active_session"));
      }
      return;
    }

    markUserAbortRequested(currentSession.id);

    // Abort for agy = SIGINT the running agy process and keep the pipeline:
    // the events adapter emits session.idle and the subscription stays active
    // so the next prompt can be sent without re-attaching.
    await interruptActiveTurn();

    await releaseAbortBusyState(currentSession.id, "abort_confirmed");

    if (notifyUser) {
      await ctx.reply(t("stop.success"));
    }
  } catch (error) {
    logger.error("[Abort] Unexpected error:", error);
    await ctx.reply(t("stop.error"));
  }
}

export async function abortCommand(ctx: CommandContext<Context>): Promise<void> {
  await abortCurrentOperation(ctx);
}
