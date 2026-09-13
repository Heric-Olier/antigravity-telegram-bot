import { logger } from "../../utils/logger.js";
import { getStoredModel } from "./model-selection-service.js";

/**
 * Model capabilities for agy.
 *
 * agy exposes no per-model capability metadata via the CLI in v1. All models
 * with multimodal ids are assumed text-only unless agy lists them. Keep
 * the shape the handlers expect (capabilities object like opencode).
 */

export interface AgyModelCapabilities {
  input: {
    image: boolean;
    pdf: boolean;
    audio: boolean;
    video: boolean;
  };
  attachment: boolean;
}

const capabilitiesCache = new Map<string, AgyModelCapabilities | null>();

const MODEL_INPUT_CAPABILITIES: Record<string, Partial<AgyModelCapabilities["input"]>> = {
  "claude-sonnet-4-6": { image: true, pdf: true },
  "claude-opus-4-6-thinking": { image: true, pdf: true },
  "gemini-3.8-flash-high": { image: true, pdf: true },
  "gemini-3.8-flash-medium": { image: true, pdf: true },
  "gemini-3.8-flash-low": { image: true, pdf: true },
};

/**
 * Get model capabilities — from the local agy capability table.
 */
export async function getModelCapabilities(
  _providerID: string,
  modelID: string,
): Promise<AgyModelCapabilities | null> {
  if (capabilitiesCache.has(modelID)) {
    return capabilitiesCache.get(modelID) ?? null;
  }

  const partial = MODEL_INPUT_CAPABILITIES[modelID];
  const capabilities: AgyModelCapabilities = {
    input: {
      image: partial?.image === true,
      pdf: partial?.pdf === true,
      audio: false,
      video: false,
    },
    attachment: partial?.image === true || partial?.pdf === true,
  };

  logger.debug(`[ModelCapabilities] Static capabilities for ${modelID}: ${JSON.stringify(capabilities)}`);
  capabilitiesCache.set(modelID, capabilities);

  void getStoredModel();
  return capabilities;
}

/**
 * Check if model supports a specific input type.
 */
export function supportsInput(
  capabilities: AgyModelCapabilities | null,
  inputType: "image" | "pdf" | "audio" | "video",
): boolean {
  if (!capabilities) {
    return false;
  }

  return capabilities.input[inputType] === true;
}

/**
 * Check if model supports attachments in general.
 */
export function supportsAttachment(capabilities: AgyModelCapabilities | null): boolean {
  if (!capabilities) {
    return false;
  }

  return capabilities.attachment === true;
}
