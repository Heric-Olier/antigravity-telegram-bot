/**
 * Variant Manager - manages model variants (reasoning modes).
 *
 * In agy there is no variant layer on top of a model id: e.g. "high"/"medium"/
 * "low" are part of the model id itself (gemini-3.8-flash-high, etc.). Keep the
 * "default" placeholder so the button/rendering call sites continue to work.
 */
import { getCurrentModel, setCurrentModel } from "../stores/settings-store.js";
import { getStoredModel } from "./model-selection-service.js";
import { logger } from "../../utils/logger.js";
import type { VariantInfo } from "../types/variant.js";

/**
 * agy models carry their reasoning level in the id; only "default" exists.
 */
export async function getAvailableVariants(
  _providerID: string,
  _modelID: string,
): Promise<VariantInfo[]> {
  return [{ id: "default" }];
}

/**
 * Get current variant from settings.
 */
export function getCurrentVariant(): string {
  const currentModel = getCurrentModel();
  return currentModel?.variant || "default";
}

/**
 * Set current variant in settings.
 */
export function setCurrentVariant(variantId: string): void {
  const currentModel = getStoredModel();

  if (!currentModel.providerID || !currentModel.modelID) {
    logger.warn("[VariantManager] Cannot set variant: no current model");
    return;
  }

  setCurrentModel({
    ...currentModel,
    variant: variantId,
  });
  logger.info(`[VariantManager] Variant set to: ${variantId}`);
}

/**
 * Format variant for button display.
 */
export function formatVariantForButton(variantId: string): string {
  const capitalized = variantId.charAt(0).toUpperCase() + variantId.slice(1);
  return `💡 ${capitalized}`;
}

/**
 * Format variant for display in messages.
 */
export function formatVariantForDisplay(variantId: string): string {
  return variantId.charAt(0).toUpperCase() + variantId.slice(1);
}

/**
 *Validate if a model supports a specific variant.
 */
export async function validateVariantForModel(
  providerID: string,
  modelID: string,
  variantId: string,
): Promise<boolean> {
  const variants = await getAvailableVariants(providerID, modelID);
  const found = variants.find((v) => v.id === variantId && !v.disabled);
  return found !== undefined;
}
