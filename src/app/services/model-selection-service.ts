import { getCurrentModel, setCurrentModel } from "../stores/settings-store.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  listModels,
  resolveEffectiveModelId,
  type AgyModel,
} from "../../antigravity/model-list.js";
import type { ModelInfo } from "../types/model.js";

/**
 * Antigravity-backed model selection service.
 *
 * agy owns the model catalog (`agy models`, tab-separated id/label). The bot
 * stores the selected model id in settings and it is passed to the next agy
 * spawn as `--model=<id>`. There is no provider layer.
 */

let cachedCatalog: AgyModel[] | null = null;

export async function getAgyModelCatalog(): Promise<AgyModel[]> {
  if (cachedCatalog) {
    return cachedCatalog;
  }
  cachedCatalog = await listModels();
  return cachedCatalog;
}

export function getAvailableAgyModels(): Promise<AgyModel[]> {
  return getAgyModelCatalog();
}

export interface AgyModelListResult {
  models: AgyModel[];
  currentId: string;
}

/**
 * List available models annotated with which one is active.
 */
export async function getAgyModelList(): Promise<AgyModelListResult> {
  const models = await getAgyModelCatalog();
  return { models, currentId: getStoredModel().modelID };
}

/**
 * Get current model from settings or fallback to the configured default.
 * ALWAYS returns a model.
 */
export function getStoredModel(): ModelInfo {
  const storedModel = getCurrentModel();

  if (storedModel?.modelID) {
    return {
      providerID: "antigravity",
      modelID: storedModel.modelID,
      variant: "default",
    };
  }

  return {
    providerID: "antigravity",
    modelID: resolveEffectiveModelId(config.antigravity.defaultModel),
    variant: "default",
  };
}

export function fetchCurrentModel(): ModelInfo {
  return getStoredModel();
}

/**
 * Select model and persist to settings.
 */
export function selectModel(modelInfo: ModelInfo): void {
  logger.info(`[ModelManager] Selected model: ${modelInfo.modelID}`);
  setCurrentModel({
    providerID: "antigravity",
    modelID: modelInfo.modelID,
    variant: "default",
  });
}

/**
 * Stored model ids are pushed to agy verbatim; there is no need to reconcile
 * against a server. Keep the call site compatibility (no-op, logged at debug).
 */
export async function reconcileStoredModelSelection(): Promise<void> {
  logger.debug("[ModelManager] Stored model selection reconciliation is a no-op for agy");
}

export function __resetModelCatalogCacheForTests(): void {
  cachedCatalog = null;
}
