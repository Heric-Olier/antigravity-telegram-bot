import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  configMock,
  listModelsMock,
  resolveEffectiveModelIdMock,
  getCurrentModelMock,
  setCurrentModelMock,
  setCurrentModelState,
  getCurrentModelState,
  resetCurrentModelState,
  loggerInfoMock,
  loggerWarnMock,
  loggerErrorMock,
  loggerDebugMock,
} = vi.hoisted(() => {
  let currentModel: { providerID: string; modelID: string; variant?: string } | undefined;

  const getCurrentModelMock = vi.fn(() => currentModel);
  const setCurrentModelMock = vi.fn(
    (modelInfo: { providerID: string; modelID: string; variant?: string }) => {
      currentModel = modelInfo;
    },
  );

  return {
    configMock: {
      antigravity: {
        defaultModel: "gemini-3.8-flash-high",
      },
    },
    listModelsMock: vi.fn(),
    resolveEffectiveModelIdMock: vi.fn(),
    getCurrentModelMock,
    setCurrentModelMock,
    setCurrentModelState: (modelInfo?: {
      providerID: string;
      modelID: string;
      variant?: string;
    }) => {
      currentModel = modelInfo;
    },
    getCurrentModelState: () => currentModel,
    resetCurrentModelState: () => {
      currentModel = undefined;
      getCurrentModelMock.mockClear();
      setCurrentModelMock.mockClear();
    },
    loggerInfoMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    loggerErrorMock: vi.fn(),
    loggerDebugMock: vi.fn(),
  };
});

vi.mock("../../../src/config.js", () => ({
  config: configMock,
}));

vi.mock("../../../src/antigravity/model-list.js", () => ({
  listModels: listModelsMock,
  resolveEffectiveModelId: resolveEffectiveModelIdMock,
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  __resetSettingsForTests: vi.fn(),
  getCurrentModel: getCurrentModelMock,
  setCurrentModel: setCurrentModelMock,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
    debug: loggerDebugMock,
  },
}));

import {
  __resetModelCatalogCacheForTests,
  fetchCurrentModel,
  getAgyModelCatalog,
  getAgyModelList,
  getAvailableAgyModels,
  getStoredModel,
  reconcileStoredModelSelection,
  selectModel,
} from "../../../src/app/services/model-selection-service.js";

const AGY_MODELS_FIXTURE = [
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

describe("app/services/model-selection-service", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetCurrentModelState();
    __resetModelCatalogCacheForTests();

    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
    loggerDebugMock.mockReset();

    listModelsMock.mockReset();
    listModelsMock.mockResolvedValue([...AGY_MODELS_FIXTURE]);

    resolveEffectiveModelIdMock.mockReset();
    resolveEffectiveModelIdMock.mockImplementation(
      (modelId?: string | null) => modelId?.trim() || configMock.antigravity.defaultModel,
    );
  });

  describe("getAgyModelCatalog", () => {
    it("returns the catalog from `agy models` via listModels", async () => {
      const catalog = await getAgyModelCatalog();

      expect(catalog).toEqual(AGY_MODELS_FIXTURE);
      expect(listModelsMock).toHaveBeenCalledTimes(1);
    });

    it("uses the catalog cache between repeated calls", async () => {
      await getAgyModelCatalog();
      await getAgyModelCatalog();
      await getAgyModelCatalog();

      expect(listModelsMock).toHaveBeenCalledTimes(1);
    });

    it("re-fetches after __resetModelCatalogCacheForTests", async () => {
      await getAgyModelCatalog();
      __resetModelCatalogCacheForTests();
      await getAgyModelCatalog();

      expect(listModelsMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("getAvailableAgyModels", () => {
    it("delegates to the cached catalog", async () => {
      const available = await getAvailableAgyModels();
      const catalog = await getAgyModelCatalog();

      expect(available).toEqual(catalog);
      expect(listModelsMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("getStoredModel", () => {
    it("returns the settings-stored model with the antigravity provider", () => {
      setCurrentModelState({ providerID: "anything", modelID: "claude-sonnet-4-6" });

      expect(getStoredModel()).toEqual({
        providerID: "antigravity",
        modelID: "claude-sonnet-4-6",
        variant: "default",
      });
    });

    it("falls back to config.antigravity.defaultModel when nothing is stored", () => {
      const model = getStoredModel();

      expect(model).toEqual({
        providerID: "antigravity",
        modelID: "gemini-3.8-flash-high",
        variant: "default",
      });
      expect(resolveEffectiveModelIdMock).toHaveBeenCalledWith(configMock.antigravity.defaultModel);
    });

    it("always returns a model even for an empty stored entry", () => {
      setCurrentModelState({ providerID: "antigravity", modelID: "" });

      expect(getStoredModel().modelID).toBe("gemini-3.8-flash-high");
    });
  });

  describe("fetchCurrentModel", () => {
    it("matches getStoredModel", () => {
      setCurrentModelState({ providerID: "antigravity", modelID: "claude-sonnet-4-6" });

      expect(fetchCurrentModel()).toEqual(getStoredModel());
    });
  });

  describe("selectModel", () => {
    it("persists the selected model to settings with the antigravity provider", () => {
      selectModel({ providerID: "antigravity", modelID: "claude-opus-4-6-thinking" });

      expect(setCurrentModelMock).toHaveBeenCalledWith({
        providerID: "antigravity",
        modelID: "claude-opus-4-6-thinking",
        variant: "default",
      });
      expect(getCurrentModelState()).toEqual({
        providerID: "antigravity",
        modelID: "claude-opus-4-6-thinking",
        variant: "default",
      });
      expect(loggerInfoMock).toHaveBeenCalledWith(
        "[ModelManager] Selected model: claude-opus-4-6-thinking",
      );
    });
  });

  describe("getAgyModelList", () => {
    it("returns models annotated with the current model id", async () => {
      setCurrentModelState({ providerID: "antigravity", modelID: "claude-sonnet-4-6" });

      const result = await getAgyModelList();

      expect(result.models).toEqual(AGY_MODELS_FIXTURE);
      expect(result.currentId).toBe("claude-sonnet-4-6");
    });

    it("reports the config default as currentId when nothing is stored", async () => {
      const result = await getAgyModelList();

      expect(result.currentId).toBe("gemini-3.8-flash-high");
    });
  });

  describe("reconciled stored model selection", () => {
    it("is a no-op that never touches settings", async () => {
      setCurrentModelState({ providerID: "antigravity", modelID: "claude-sonnet-4-6" });

      await reconcileStoredModelSelection();

      expect(setCurrentModelMock).not.toHaveBeenCalled();
      expect(getCurrentModelState()).toEqual({
        providerID: "antigravity",
        modelID: "claude-sonnet-4-6",
      });
    });
  });
});
