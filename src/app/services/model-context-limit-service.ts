import { logger } from "../../utils/logger.js";

/**
 * Context limits for agy models.
 *
 * agy exposes no context-window metadata via the CLI, so a single constant is
 * used. The 1M value matches the Gemini 3.x family the CLI exposes by default.
 */

export const DEFAULT_CONTEXT_LIMIT = 1_000_000;

const contextLimitCache = new Map<string, number>();

export async function getModelContextLimit(
  providerID?: string | null,
  modelID?: string | null,
): Promise<number> {
  if (!providerID || !modelID) {
    return DEFAULT_CONTEXT_LIMIT;
  }

  const cacheKey = `${providerID}/${modelID}`;
  const cachedLimit = contextLimitCache.get(cacheKey);
  if (cachedLimit) {
    return cachedLimit;
  }

  logger.debug(`[ModelContextLimit] Using default context limit for ${cacheKey}`);
  contextLimitCache.set(cacheKey, DEFAULT_CONTEXT_LIMIT);
  return DEFAULT_CONTEXT_LIMIT;
}
