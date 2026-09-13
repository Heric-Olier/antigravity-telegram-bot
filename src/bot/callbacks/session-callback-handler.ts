import type { Bot, Context } from "grammy";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { setCurrentSession } from "../../app/services/session-service.js";
import type { SessionInfo } from "../../app/types/session.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { clearAllInteractionState, interactionManager } from "../../app/managers/interaction-manager.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { appendInlineMenuCancelButton, ensureActiveInlineMenu } from "../menus/inline-menu.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { alert, failure } from "./feedback.js";
import { attachToSession } from "../../app/services/attach-service.js";
import {
  buildSessionSelectionMenuView,
  parseBackgroundSessionCallback,
  parseSessionIdCallback,
  parseSessionPageCallback,
  SESSION_CALLBACK_PREFIX,
  loadSessionPage,
} from "../menus/session-selection-menu.js";
import { formatConversationPreview, getConversation } from "../../antigravity/session-store.js";

export interface SessionSelectDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

interface SelectSessionByIdOptions {
  source: "menu" | "background_notification";
  deleteCallbackMessage: boolean;
  removeCallbackReplyMarkup: boolean;
  postSelectAction: "preview" | "latest_assistant_response" | "none";
}

async function removeCallbackReplyMarkup(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup();
  } catch (err) {
    logger.debug("[Sessions] Failed to remove background session button:", err);
  }
}

export async function selectSessionById(
  ctx: Context,
  deps: SessionSelectDeps,
  sessionId: string,
  options: SelectSessionByIdOptions,
): Promise<void> {
  const currentProject = getCurrentProject();

  if (!currentProject) {
    clearAllInteractionState("session_select_project_missing");
    await alert(ctx, "sessions.select_project_first");
    return;
  }

  // Conversation id -> display title known on disk (summary DB); the preview
  // only exists for real agy conversations, otherwise the raw id is used.
  const conversation = getConversation(sessionId);
  const title = conversation?.title ?? sessionId.slice(0, 8);

  logger.info(
    `[Bot] Session selected: id=${sessionId}, title="${title}", project=${currentProject.worktree}, source=${options.source}`,
  );

  const sessionInfo: SessionInfo = {
    id: sessionId,
    title,
    directory: currentProject.worktree,
  };
  setCurrentSession(sessionInfo);
  clearAllInteractionState("session_switched");

  await ctx.answerCallbackQuery();

  let loadingMessageId: number | null = null;
  if (ctx.chat) {
    try {
      const loadingMessage = await ctx.api.sendMessage(ctx.chat.id, t("sessions.loading_context"));
      loadingMessageId = loadingMessage.message_id;
    } catch (err) {
      logger.error("[Sessions] Failed to send loading message:", err);
    }
  }

  try {
    await attachToSession({
      bot: deps.bot,
      chatId: ctx.chat!.id,
      session: sessionInfo,
      ensureEventSubscription: deps.ensureEventSubscription,
    });
  } catch (err) {
    if (loadingMessageId) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, loadingMessageId);
      } catch (deleteError) {
        logger.debug("[Sessions] Failed to delete loading message after follow error:", deleteError);
      }
    }
    logger.error("[Sessions] Error following selected session:", err);
    throw err;
  }

  if (ctx.chat) {
    const chatId = ctx.chat.id;
    keyboardManager.updateModel(getStoredModel());

    const contextInfo = keyboardManager.getContextInfo();
    if (contextInfo) {
      keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);
    }

    if (loadingMessageId) {
      try {
        await ctx.api.deleteMessage(chatId, loadingMessageId);
      } catch (err) {
        logger.debug("[Sessions] Failed to delete loading message:", err);
      }
    }

    const keyboard = keyboardManager.getKeyboard();
    try {
      await ctx.api.sendMessage(
        chatId,
        t("sessions.selected", { title: sessionInfo.title }),
        keyboard ? { reply_markup: keyboard } : {},
      );
    } catch (err) {
      logger.error("[Sessions] Failed to send selection message:", err);
    }

    if (options.postSelectAction === "preview") {
      safeBackgroundTask({
        taskName: "sessions.sendPreview",
        task: () => sendSessionPreview(ctx.api, chatId, null, sessionInfo),
      });
    }
  }

  if (options.removeCallbackReplyMarkup) {
    await removeCallbackReplyMarkup(ctx);
  }

  if (options.deleteCallbackMessage) {
    await ctx.deleteMessage();
  }
}

function shouldBlockBackgroundSessionOpen(): boolean {
  const activeInteraction = interactionManager.getSnapshot();
  return activeInteraction !== null && activeInteraction.kind !== "inline";
}

export async function handleBackgroundSessionOpen(
  ctx: Context,
  deps: SessionSelectDeps,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    return false;
  }

  const payload = parseBackgroundSessionCallback(data);
  if (!payload) {
    return false;
  }

  if (isForegroundBusy()) {
    await replyBusyBlocked(ctx);
    return true;
  }

  if (shouldBlockBackgroundSessionOpen()) {
    await ctx.answerCallbackQuery({ text: t("interaction.blocked.finish_current") }).catch(() => {});
    return true;
  }

  try {
    await selectSessionById(ctx, deps, payload.sessionId, {
      source: "background_notification",
      deleteCallbackMessage: false,
      removeCallbackReplyMarkup: true,
      postSelectAction: payload.kind === "assistant_response" ? "latest_assistant_response" : "none",
    });
  } catch (error) {
    logger.error("[Sessions] Error selecting background session:", error);
    await ctx.answerCallbackQuery({ text: t("sessions.select_error"), show_alert: true }).catch(
      () => {},
    );
  }

  return true;
}

export async function handleSessionSelect(ctx: Context, deps: SessionSelectDeps): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data || !callbackQuery.data.startsWith(SESSION_CALLBACK_PREFIX)) {
    return false;
  }

  if (isForegroundBusy()) {
    await replyBusyBlocked(ctx);
    return true;
  }

  const page = parseSessionPageCallback(callbackQuery.data);
  const sessionId = parseSessionIdCallback(callbackQuery.data);

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "session");
  if (!isActiveMenu) {
    return true;
  }

  try {
    const currentProject = getCurrentProject();

    if (!currentProject) {
      clearAllInteractionState("session_select_project_missing");
      await alert(ctx, "sessions.select_project_first");
      return true;
    }

    if (page !== null) {
      try {
        const pageSize = config.bot.sessionsListLimit;
        const pageData = await loadSessionPage(currentProject.worktree, page, pageSize);
        if (pageData.sessions.length === 0) {
          await ctx.answerCallbackQuery({ text: t("sessions.page_empty_callback") });
          return true;
        }

        const { text, keyboard } = buildSessionSelectionMenuView(pageData, pageSize);
        appendInlineMenuCancelButton(keyboard, "session");
        await ctx.answerCallbackQuery();
        await ctx.editMessageText(text, {
          reply_markup: keyboard,
        });
      } catch (error) {
        logger.error("[Sessions] Error loading sessions page:", error);
        await ctx.answerCallbackQuery({ text: t("sessions.page_load_error_callback") });
      }

      return true;
    }

    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
      return true;
    }

    await selectSessionById(ctx, deps, sessionId, {
      source: "menu",
      deleteCallbackMessage: true,
      removeCallbackReplyMarkup: false,
      postSelectAction: "preview",
    });
  } catch (error) {
    clearAllInteractionState("session_select_error");
    logger.error("[Sessions] Error selecting session:", error);
    await failure(ctx, "sessions.select_error");
  }

  return true;
}

async function sendSessionPreview(
  api: Context["api"],
  chatId: number,
  messageId: number | null,
  session: SessionInfo,
): Promise<void> {
  // TODO(v2): agy .db conversation files store messages as protobuf; once the
  // schema is verifiable, render full "Tú/Agente" transcripts here. For now the
  // preview comes from the CLI's own summary DB (title + first user prompt).
  const conversation = getConversation(session.id);
  const finalText = conversation
    ? formatConversationPreview(conversation)
    : t("sessions.preview.empty");

  if (messageId) {
    try {
      await api.editMessageText(chatId, messageId, finalText);
      return;
    } catch (err) {
      logger.warn("[Sessions] Failed to edit preview message, sending new one:", err);
    }
  }

  try {
    await api.sendMessage(chatId, finalText);
  } catch (err) {
    logger.error("[Sessions] Failed to send session preview message:", err);
  }
}
