import { type Context } from "grammy";
import {
  fetchCurrentModel,
  getAvailableAgyModels,
  selectModel,
} from "../../app/services/model-selection-service.js";
import {
  getModelCapabilities,
  supportsInput,
} from "../../app/services/model-capabilities-service.js";
import {
  resolveModelListCallback,
  parseModelListCallback,
  buildModelRootMenuView,
  MODEL_LIST_CALLBACK_PREFIX,
} from "../menus/model-selection-menu.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { failure, switched } from "./feedback.js";
import { createMainKeyboard } from "../keyboards/main-reply-keyboard.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import {
  appendInlineMenuCancelButton,
  clearActiveInlineMenu,
  ensureActiveInlineMenu,
} from "../menus/inline-menu.js";

/**
 * Handle model selection callbacks.
 *
 * Callback data shapes:
 * - "model:list:<index>" — select the agy model at a catalog index.
 * The inline menu is destroyed on successful selection (reply_markup cleared),
 * matching the fork's auto-destroy pattern.
 * @returns true if handled, false otherwise
 */
export async function handleModelSelect(ctx: Context): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;

  if (!callbackQuery?.data || !callbackQuery.data.startsWith("model:")) {
    return false;
  }

  if (!callbackQuery.data.startsWith(MODEL_LIST_CALLBACK_PREFIX)) {
    return false;
  }

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "model");
  if (!isActiveMenu) {
    return true;
  }

  logger.debug(`[ModelHandler] Received callback: ${callbackQuery.data}`);

  try {
    const index = parseModelListCallback(callbackQuery.data);
    const modelInfo = index !== null ? await resolveModelListCallback(index) : null;

    if (!modelInfo) {
      logger.error(`[ModelHandler] Invalid callback data format: ${callbackQuery.data}`);
      clearActiveInlineMenu("model_select_invalid_callback");
      await ctx.answerCallbackQuery({ text: t("model.change_error_callback") }).catch(() => {});
      return true;
    }

    await applyModelSelectionAndNotify(ctx, modelInfo);
    return true;
  } catch (err) {
    clearActiveInlineMenu("model_select_error");
    logger.error("[ModelHandler] Error handling model select:", err);
    await failure(ctx, "model.change_error_callback");
    return true;
  }
}

async function applyModelSelectionAndNotify(
  ctx: Context,
  modelInfo: Awaited<ReturnType<typeof resolveModelListCallback>> & object,
): Promise<void> {
  if (ctx.chat) {
    keyboardManager.initialize(ctx.api, ctx.chat.id);
  }

  selectModel(modelInfo);
  keyboardManager.updateModel(modelInfo);
  await pinnedMessageManager.refreshContextLimit();

  const contextInfo =
    pinnedMessageManager.getContextInfo() ??
    (pinnedMessageManager.getContextLimit() > 0
      ? { tokensUsed: 0, tokensLimit: pinnedMessageManager.getContextLimit() }
      : null);

  if (contextInfo) {
    keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);
  }

  const keyboard = createMainKeyboard(
    "antigravity",
    modelInfo,
    contextInfo ?? undefined,
    modelInfo.variant || "default",
  );
  const displayName = modelInfo.modelID;

  // The selection is final: destroy the inline menu by editing the menu
  // message without reply_markup (fork's auto-destroy pattern).
  clearActiveInlineMenu("model_selected");
  await ctx.answerCallbackQuery().catch(() => {});

  if (ctx.chat) {
    try {
      await ctx.editMessageText(t("model.changed_message", { name: displayName }));
    } catch (err) {
      logger.debug("[ModelHandler] Could not edit menu message after selection:", err);
    }
  }

  await switched(ctx, t("model.changed_message", { name: displayName }), keyboard);

  const capabilities = await getModelCapabilities(modelInfo.providerID, modelInfo.modelID);
  logger.debug(
    `[ModelHandler] Selected ${modelInfo.modelID}: image=${supportsInput(capabilities, "image")}`,
  );
}

/**
 * Catalog getter kept for tests / menus.
 */
export async function listAgyModelsForMenu(): Promise<Awaited<ReturnType<typeof getAvailableAgyModels>>> {
  return getAvailableAgyModels();
}

/**
 * Show the menu with the current model highlighted.
 */
export async function showModelMenuForContext(ctx: Context): Promise<void> {
  const view = await buildModelRootMenuView(fetchCurrentModel());
  await ctx.reply(view.text, {
    reply_markup: appendInlineMenuCancelButton(view.keyboard, "model"),
  });
  interactionManager.getSnapshot();
}
