import { execFile } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Antigravity model catalog.
 *
 * Primary source: `agy models` (tab-separated output: `<id>\t<label>`), with a
 * 60s in-memory cache. Fallback if the binary unavailable/awkward:
 * the verified 15-model catalog (sep-2026).
 */

export interface AgyModel {
  id: string;
  label: string;
}

export const MODEL_LIST_CACHE_TTL_MS = 60_000;
export const AGY_MODELS_TIMEOUT_MS = 10_000;

export const DEFAULT_AGY_MODEL_ID = "gemini-3.8-flash-high";

// Verified against `agy models` on sep-2026.
export const FALLBACK_AGY_MODELS: AgyModel[] = [
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
  { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
  { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
  { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
  { id: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
  { id: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
  { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
  { id: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

export function findFallbackModel(id: string): AgyModel | null {
  return FALLBACK_AGY_MODELS.find((model) => model.id === id) ?? null;
}

/**
 * Parse the tab-separated lines of `agy models`. Lines without exactly one tab
 * (the "Fetching available models..." banner, blanks) are discarded.
 */
export function parseAgyModelsOutput(stdout: string): AgyModel[] {
  const models: AgyModel[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab <= 0 || tab === line.length - 1) {
      continue;
    }
    const id = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (!id || !label || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push({ id, label });
  }

  return models;
}

export function runAgyModels(timeoutMs: number = AGY_MODELS_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "agy",
      ["models"],
      { timeout: timeoutMs, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(stderr || error)));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

let cachedModels: AgyModel[] | null = null;
let cacheExpiresAt = 0;
let cacheInFlight: Promise<AgyModel[]> | null = null;

async function fetchModelList(): Promise<AgyModel[]> {
  try {
    const stdout = await runAgyModels();
    const parsed = parseAgyModelsOutput(stdout);
    if (parsed.length > 0) {
      return parsed;
    }
    logger.warn("[ModelList] `agy models` returned no parsable models; using fallback catalog");
  } catch (error) {
    logger.warn("[ModelList] Failed to fetch `agy models`; using fallback catalog:", error);
  }
  return FALLBACK_AGY_MODELS;
}

/**
 * Get the model catalog (cached 60s, refreshes when stale).
 * Fallback to the stale cache or the hardcoded list if `agy models` fails.
 */
export async function listModels(): Promise<AgyModel[]> {
  if (cachedModels && Date.now() < cacheExpiresAt) {
    return cachedModels;
  }

  if (!cacheInFlight) {
    cacheInFlight = fetchModelList()
      .then((models) => {
        cachedModels = models;
        cacheExpiresAt = Date.now() + MODEL_LIST_CACHE_TTL_MS;
        return models;
      })
      .finally(() => {
        cacheInFlight = null;
      });
  }

  return cacheInFlight;
}

/**
 * Resolve the effective model id (falls back to config.antigravity default).
 */
export function resolveEffectiveModelId(modelId?: string | null): string {
  const trimmed = modelId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : config.antigravity.defaultModel;
}

/**
 * Label for display: prefer a live catalog hit, else the fallback, else the id.
 */
export function formatModelLabel(id: string, catalog: AgyModel[]): string {
  return catalog.find((model) => model.id === id)?.label ?? id;
}

export function resetModelListCacheForTests(): void {
  cachedModels = null;
  cacheExpiresAt = 0;
  cacheInFlight = null;
}
