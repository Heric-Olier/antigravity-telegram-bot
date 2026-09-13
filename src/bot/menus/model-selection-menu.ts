import { InlineKeyboard, type Context } from "grammy";
import {
  fetchCurrentModel,
  getAgyModelList,
  getAvailableAgyModels,
} from "../../app/services/model-selection-service.js";
import type { FavoriteModel, ModelInfo } from "../../app/types/model.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { replyWithInlineMenu } from "./inline-menu.js";

export const MODEL_SEARCH_CALLBACK = "model:search";
export const MODEL_LIST_CALLBACK_PREFIX = "model:list:";

export function buildModelListCallback(index: number): string {
  return `${MODEL_LIST_CALLBACK_PREFIX}${index}`;
}

function parseIndex(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  return Number.parseInt(value, 10);
}

export function parseModelListCallback(data: string): number | null {
  if (!data.startsWith(MODEL_LIST_CALLBACK_PREFIX)) {
    return null;
  }

  return parseIndex(data.slice(MODEL_LIST_CALLBACK_PREFIX.length));
}

export function parseModelSearchCallback(data: string): number | null {
  if (!data.startsWith(MODEL_SEARCH_CALLBACK)) {
    return null;
  }

  return parseIndex(data.slice(MODEL_SEARCH_CALLBACK.length));
}

export function buildModelSelectionMenuText(currentModel: ModelInfo | undefined): string {
  if (currentModel && typeof currentModel.modelID === "string" && currentModel.modelID.length > 0) {
    return t("model.menu.current", { name: currentModel.modelID });
  }

  return t("model.menu.select");
}

/**
 * Build the inline keyboard with the full agy model catalog.
 * Each button carries the selection index in its callback data; the handler
 * resolves the model by index against a fresh (60s-cached) catalog read.
 */
export async function buildModelSelectionMenu(
  currentModel?: ModelInfo,
): Promise<InlineKeyboard> {
  const keyboard = new InlineKeyboard();
  const models = await getAvailableAgyModels();

  if (models.length === 0) {
    logger.warn("[ModelHandler] No model choices from agy");
    return keyboard;
  }

  models.forEach((model, index) => {
    const isActive = currentModel && model.id === currentModel.modelID;
    const label = isActive ? `✅ ${model.label}` : model.label;
    keyboard.text(label, buildModelListCallback(index)).row();
  });

  return keyboard;
}

/**
 * Build the model menu view (full catalog flattened into one paginated keyboard).
 */
export async function buildModelRootMenuView(
  currentModel: ModelInfo | undefined,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  return {
    text: buildModelSelectionMenuText(currentModel),
    keyboard: await buildModelSelectionMenu(currentModel),
  };
}

/**
 * Resolve a `model:list:<index>` callback to a concrete model.
 */
export async function resolveModelListCallback(index: number): Promise<ModelInfo | null> {
  const models = await getAvailableAgyModels();
  const model = models[index];
  if (!model) {
    return null;
  }

  return {
    providerID: "antigravity",
    modelID: model.id,
    variant: "default",
  };
}

/**
 * Search callback resolution: agy's catalog is small (15), so "search" simply
 * maps to the full list filtered by query text.
 */
export async function getModelSearchResults(query: string): Promise<FavoriteModel[]> {
  const normalized = query.trim().toLowerCase();
  const models = await getAvailableAgyModels();
  return models
    .filter((model) => model.id.toLowerCase().includes(normalized) || model.label.toLowerCase().includes(normalized))
    .slice(0, 10)
    .map((model) => ({ providerID: "antigravity", modelID: model.id }));
}

/**
 * Show model selection menu.
 */
export async function showModelSelectionMenu(ctx: Context): Promise<void> {
  try {
    const currentModel = fetchCurrentModel();
    const { text, keyboard } = await buildModelRootMenuView(currentModel);
    const modelLists = await getAgyModelList();

    await replyWithInlineMenu(ctx, {
      menuKind: "model",
      text,
      keyboard,
      metadata: {
        modelLists: {
          favorites: modelLists.models.map((model) => ({ providerID: "antigravity", modelID: model.id })),
          recent: [],
        },
      },
    });
  } catch (err) {
    logger.error("[ModelHandler] Error showing model menu:", err);
    await ctx.reply(t("model.menu.error"));
  }
}
