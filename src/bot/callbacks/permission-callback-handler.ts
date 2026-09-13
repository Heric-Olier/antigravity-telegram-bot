import type { Context } from "grammy";
import { permissionManager } from "../../app/managers/permission-manager.js";
import type { PermissionReply } from "../../app/types/permission.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { summaryAggregator } from "../../app/managers/summary-aggregation-manager.js";
import { clearPermissionInteraction, syncPermissionInteractionState } from "../menus/permission-menu.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }

  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

function isPermissionReply(value: string): value is PermissionReply {
  return value === "once" || value === "always" || value === "reject";
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars

export async function handlePermissionCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) return false;

  if (!data.startsWith("permission:")) {
    return false;
  }

  logger.debug(`[PermissionHandler] Received callback: ${data}`);

  if (!permissionManager.isActive()) {
    clearPermissionInteraction("permission_inactive_callback");
    await ctx.answerCallbackQuery({ text: t("permission.inactive_callback"), show_alert: true });
    return true;
  }

  const callbackMessageId = getCallbackMessageId(ctx);
  if (!permissionManager.isActiveMessage(callbackMessageId)) {
    await ctx.answerCallbackQuery({ text: t("permission.inactive_callback"), show_alert: true });
    return true;
  }

  const requestIDs = permissionManager.getRequestIDs(callbackMessageId);
  if (requestIDs.length === 0) {
    await ctx.answerCallbackQuery({ text: t("permission.inactive_callback"), show_alert: true });
    return true;
  }

  const parts = data.split(":");
  const action = parts[1];

  if (!action || !isPermissionReply(action)) {
    await ctx.answerCallbackQuery({
      text: t("permission.processing_error_callback"),
      show_alert: true,
    });
    return true;
  }

  try {
    await handlePermissionReply(ctx, action, requestIDs, callbackMessageId);
  } catch (err) {
    logger.error("[PermissionHandler] Error handling callback:", err);
    await ctx.answerCallbackQuery({
      text: t("permission.processing_error_callback"),
      show_alert: true,
    });
  }

  return true;
}

async function handlePermissionReply(
  ctx: Context,
  reply: PermissionReply,
  requestIDs: string[],
  callbackMessageId: number | null,
): Promise<void> {
  const currentProject = getCurrentProject();
  const currentSession = getCurrentSession();
  const chatId = ctx.chat?.id;
  const directory = currentSession?.directory ?? currentProject?.worktree;

  if (!directory || !chatId) {
    permissionManager.clear();
    clearPermissionInteraction("permission_invalid_runtime_context");

    await ctx.answerCallbackQuery({
      text: t("permission.no_active_request_callback"),
      show_alert: true,
    });
    return;
  }

  const replyLabels: Record<PermissionReply, string> = {
    once: t("permission.reply.once"),
    always: t("permission.reply.always"),
    reject: t("permission.reply.reject"),
  };

  await ctx.answerCallbackQuery({ text: replyLabels[reply] });
  await ctx.deleteMessage().catch(() => {});

  summaryAggregator.stopTypingIndicator();

  logger.info(
    `[PermissionHandler] Sending permission reply: ${reply}, requestIDs=${requestIDs.join(",")}`,
  );

  // agy runs yolo: there are no server-tracked permission requests. The bot
  // state is cleared locally and reported immediately.
  safeBackgroundTask({
    taskName: "permission.reply",
    task: async () => {
      for (const requestID of requestIDs) {
        logger.debug(`[PermissionHandler] Local permission clear: requestID=${requestID}`);
      }
      return { error: null };
    },
    onSuccess: () => {
      logger.info("[PermissionHandler] Permission reply sent successfully");
    },
  });

  permissionManager.removeByMessageId(callbackMessageId);

  if (!permissionManager.isActive()) {
    clearPermissionInteraction("permission_replied");
    return;
  }

  syncPermissionInteractionState({
    lastRepliedRequestIDs: requestIDs,
  });
}
