/**
 * Model types and formatting utilities
 */

export interface ModelInfo {
  providerID: string;
  modelID: string;
  variant?: string | undefined;
}

export interface VariantInfo {
  id: string;
  disabled?: boolean | undefined;
}

export interface FavoriteModel {
  providerID: string;
  modelID: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  modelCount: number;
}

export interface ModelSelectionLists {
  favorites: FavoriteModel[];
  recent: FavoriteModel[];
}

/**
 * Format model for button display (compact format)
 *
 * Antigravity model ids ("gemini-3.8-flash-medium") render as their friendly
 * catalog label ("Gemini 3.8 Flash (Medium)") instead of a truncated raw id,
 * so the persistent keyboard stays readable. Truncation only kicks in beyond
 * the Telegram button budget (~32 chars/line) for unusual providers/ids.
 * @param providerID Provider ID
 * @param modelID Model ID
 * @returns Formatted string: "🧠 modelLabel" (two lines only when needed)
 */
export function formatModelForButton(providerID: string, modelID: string): string {
  const friendly = idToButtonLabel(modelID);
  const label = friendly.length <= 32 ? friendly : `${friendly.substring(0, 29)}...`;

  if (providerID === "antigravity") {
    return `🧠 ${label}`;
  }
  return `🧠 ${label} · ${providerID}`;
}

/**
 * Derive a readable label from an Antigravity-style model id:
 * "gemini-3.8-flash-medium" → "Gemini 3.8 Flash (Medium)"
 */
export function idToButtonLabel(modelID: string): string {
  const tokens = modelID.split("-");
  const [family, ...rest] = tokens;
  if (!family || !/^(gemini|claude|gpt-oss)$/i.test(family)) {
    return modelID;
  }

  const parts: string[] = [family.charAt(0).toUpperCase() + family.slice(1).toLowerCase()];
  const tierTitles = new Set(["high", "medium", "low", "thinking"]);
  const tier = rest.filter((t) => tierTitles.has(t));
  const core = rest.filter((t) => !tierTitles.has(t));
  parts.push(...core.map((t) => /[\d]/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1)));
  if (tier.length > 0) {
    parts.push(`(${tier.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(" ")})`);
  }
  return parts.join(" ");
}

/**
 * Format model for display in messages (full format)
 * @param providerID Provider ID
 * @param modelID Model ID
 * @returns Formatted string "providerID / modelID"
 */
export function formatModelForDisplay(providerID: string, modelID: string): string {
  return `${providerID} / ${modelID}`;
}
