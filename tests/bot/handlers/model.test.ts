import { beforeEach, describe, expect, it, vi } from "vitest";
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";

const mocked = vi.hoisted(() => ({
  getAvailableAgyModelsMock: vi.fn(),
  getAgyModelListMock: vi.fn(),
  fetchCurrentModelMock: vi.fn(),
  selectModelMock: vi.fn(),
  interactionManagerGetSnapshotMock: vi.fn(),
  ensureActiveInlineMenuMock: vi.fn(),
  clearActiveInlineMenuMock: vi.fn(),
  keyboardInitializeMock: vi.fn(),
  keyboardUpdateModelMock: vi.fn(),
  keyboardUpdateContextMock: vi.fn(),
  pinnedRefreshContextLimitMock: vi.fn(),
  pinnedGetContextInfoMock: vi.fn(),
  pinnedGetContextLimitMock: vi.fn(),
  createMainKeyboardMock: vi.fn(),
  replyWithInlineMenuMock: vi.fn(),
  switchedMock: vi.fn(),
  failureMock: vi.fn(),
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getAvailableAgyModels: mocked.getAvailableAgyModelsMock,
  getAgyModelList: mocked.getAgyModelListMock,
  fetchCurrentModel: mocked.fetchCurrentModelMock,
  selectModel: mocked.selectModelMock,
}));

vi.mock("../../../src/app/services/model-capabilities-service.js", () => ({
  getModelCapabilities: vi.fn().mockResolvedValue({}),
  supportsInput: vi.fn(() => false),
}));

vi.mock("../../../src/bot/keyboards/keyboard-manager.js", () => ({
  keyboardManager: {
    initialize: mocked.keyboardInitializeMock,
    updateModel: mocked.keyboardUpdateModelMock,
    updateContext: mocked.keyboardUpdateContextMock,
  },
}));

vi.mock("../../../src/bot/keyboards/main-reply-keyboard.js", () => ({
  createMainKeyboard: mocked.createMainKeyboardMock,
}));

vi.mock("../../../src/bot/pinned/pinned-message-manager.js", () => ({
  pinnedMessageManager: {
    refreshContextLimit: mocked.pinnedRefreshContextLimitMock,
    getContextInfo: mocked.pinnedGetContextInfoMock,
    getContextLimit: mocked.pinnedGetContextLimitMock,
  },
}));

vi.mock("../../../src/app/managers/interaction-manager.js", () => ({
  interactionManager: {
    getSnapshot: mocked.interactionManagerGetSnapshotMock,
    clear: vi.fn(),
  },
}));

vi.mock("../../../src/bot/menus/inline-menu.js", () => ({
  ensureActiveInlineMenu: mocked.ensureActiveInlineMenuMock,
  clearActiveInlineMenu: mocked.clearActiveInlineMenuMock,
  replyWithInlineMenu: mocked.replyWithInlineMenuMock,
  appendInlineMenuCancelButton: (keyboard: InlineKeyboard) => keyboard,
}));

vi.mock("../../../src/bot/callbacks/feedback.js", () => ({
  switched: mocked.switchedMock,
  failure: mocked.failureMock,
}));

import {
  buildModelListCallback,
  buildModelRootMenuView,
  buildModelSelectionMenu,
  buildModelSelectionMenuText,
  resolveModelListCallback,
  showModelSelectionMenu,
} from "../../../src/bot/menus/model-selection-menu.js";

import {
  handleModelSelect,
  listAgyModelsForMenu,
} from "../../../src/bot/callbacks/model-selection-callback-handler.js";
import { defined } from "../../helpers/defined.js";

const AGY_MODELS_FIXTURE = [
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

function mockContext(overrides: Record<string, unknown> = {}) {
  return {
    callbackQuery: undefined,
    message: undefined,
    chat: { id: 123 },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ message_id: 999 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as import("grammy").Context;
}

function getCallbackData(button: InlineKeyboardButton): string | undefined {
  return "callback_data" in button ? button.callback_data : undefined;
}

function cell(
  keyboard: ReadonlyArray<ReadonlyArray<InlineKeyboardButton>>,
  row: number,
  col: number,
): InlineKeyboardButton {
  return defined(keyboard[row]?.[col], `button[${row}][${col}]`);
}

function selectingModelInfo(modelID: string) {
  return { providerID: "antigravity", modelID, variant: "default" as const };
}

describe("bot model selection (agy flat menu)", () => {
  beforeEach(() => {
    mocked.getAvailableAgyModelsMock
      .mockReset()
      .mockResolvedValue(AGY_MODELS_FIXTURE.map((m) => ({ ...m })));
    mocked.getAgyModelListMock.mockReset().mockResolvedValue({
      models: AGY_MODELS_FIXTURE,
      currentId: "gemini-3.8-flash-high",
    });
    mocked.fetchCurrentModelMock
      .mockReset()
      .mockReturnValue(selectingModelInfo("gemini-3.8-flash-high"));
    mocked.selectModelMock.mockReset();
    mocked.interactionManagerGetSnapshotMock.mockReset();
    mocked.ensureActiveInlineMenuMock.mockReset().mockResolvedValue(true);
    mocked.clearActiveInlineMenuMock.mockReset();
    mocked.keyboardInitializeMock.mockReset();
    mocked.keyboardUpdateModelMock.mockReset();
    mocked.keyboardUpdateContextMock.mockReset();
    mocked.pinnedRefreshContextLimitMock.mockReset().mockResolvedValue(undefined);
    mocked.pinnedGetContextInfoMock.mockReset().mockReturnValue(null);
    mocked.pinnedGetContextLimitMock.mockReset().mockReturnValue(0);
    mocked.createMainKeyboardMock.mockReset().mockReturnValue({ keyboard: [["main"]] });
    mocked.replyWithInlineMenuMock.mockReset().mockResolvedValue(999);
    mocked.switchedMock.mockReset().mockResolvedValue(undefined);
    mocked.failureMock.mockReset().mockResolvedValue(undefined);
  });

  describe("buildModelSelectionMenu", () => {
    it("renders one button per agy model with index-based callback data", async () => {
      const keyboard = await buildModelSelectionMenu();

      expect(keyboard).toBeInstanceOf(InlineKeyboard);
      const rows = keyboard.inline_keyboard.filter((row) => row.length > 0);
      expect(rows).toHaveLength(AGY_MODELS_FIXTURE.length);
      expect(cell(rows, 0, 0).text).toBe("Gemini 3.8 Flash (High)");
      expect(getCallbackData(cell(rows, 0, 0))).toBe("model:list:0");
      expect(getCallbackData(cell(rows, 4, 0))).toBe("model:list:4");
      expect(Buffer.byteLength(getCallbackData(cell(rows, 4, 0)) ?? "", "utf-8")).toBeLessThanOrEqual(
        64,
      );
    });

    it("marks the active model with a checkmark", async () => {
      const keyboard = await buildModelSelectionMenu(selectingModelInfo("claude-sonnet-4-6"));

      const rows = keyboard.inline_keyboard;
      expect(cell(rows, 2, 0).text).toBe("✅ Claude Sonnet 4.6 (Thinking)");
      expect(cell(rows, 0, 0).text).toBe("Gemini 3.8 Flash (High)");
    });

    it("returns an empty keyboard when agy provides no models", async () => {
      mocked.getAvailableAgyModelsMock.mockResolvedValue([]);

      const keyboard = await buildModelSelectionMenu();

      expect(keyboard.inline_keyboard.filter((row) => row.length > 0)).toHaveLength(0);
    });
  });

  describe("buildModelSelectionMenuText / buildModelRootMenuView", () => {
    it("shows the current model name", () => {
      expect(buildModelSelectionMenuText(selectingModelInfo("claude-sonnet-4-6"))).toContain(
        "claude-sonnet-4-6",
      );
    });

    it("falls back to the plain select prompt without a current model", () => {
      expect(buildModelSelectionMenuText(undefined)).not.toContain("undefined");
    });

    it("builds the combined menu view", async () => {
      const view = await buildModelRootMenuView(selectingModelInfo("gemini-3.8-flash-high"));

      expect(view.text).toContain("gemini-3.8-flash-high");
      expect(view.keyboard.inline_keyboard.filter((row) => row.length > 0)).toHaveLength(
        AGY_MODELS_FIXTURE.length,
      );
    });
  });

  describe("resolveModelListCallback", () => {
    it("resolves an index to the antigravity model info", async () => {
      await expect(resolveModelListCallback(2)).resolves.toEqual(
        selectingModelInfo("claude-sonnet-4-6"),
      );
    });

    it("returns null for an out-of-range index", async () => {
      await expect(resolveModelListCallback(99)).resolves.toBeNull();
    });
  });

  describe("showModelSelectionMenu", () => {
    it("stores the rendered flat model list with the active menu", async () => {
      const ctx = mockContext();

      await showModelSelectionMenu(ctx);

      expect(mocked.replyWithInlineMenuMock).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({
          menuKind: "model",
          metadata: {
            modelLists: {
              favorites: AGY_MODELS_FIXTURE.map((m) => ({
                providerID: "antigravity",
                modelID: m.id,
              })),
              recent: [],
            },
          },
        }),
      );
    });

    it("replies with an error message when the catalog read fails", async () => {
      mocked.fetchCurrentModelMock.mockImplementation(() => {
        throw new Error("catalog unavailable");
      });

      const ctx = mockContext();
      await showModelSelectionMenu(ctx);

      expect(ctx.reply).toHaveBeenCalled();
      expect(mocked.replyWithInlineMenuMock).not.toHaveBeenCalled();
    });
  });

  describe("handleModelSelect", () => {
    it("selects the model behind a model:list callback and destroys the inline menu", async () => {
      const ctx = mockContext({
        callbackQuery: {
          data: "model:list:2",
          message: { message_id: 999 },
        },
        api: {},
      });

      const result = await handleModelSelect(ctx);

      expect(result).toBe(true);
      expect(mocked.selectModelMock).toHaveBeenCalledWith(selectingModelInfo("claude-sonnet-4-6"));
      expect(mocked.keyboardUpdateModelMock).toHaveBeenCalledWith(
        selectingModelInfo("claude-sonnet-4-6"),
      );
      expect(mocked.clearActiveInlineMenuMock).toHaveBeenCalledWith("model_selected");
      expect(mocked.switchedMock).toHaveBeenCalled();
      expect(ctx.editMessageText).toHaveBeenCalled();
    });

    it("uses a fresh catalog resolution for long model ids carried by index", async () => {
      const longModelID = "accounts/hubabuba3227-1hvtqlh/deployments/kpwpvuky";
      mocked.getAvailableAgyModelsMock.mockResolvedValue([{ id: longModelID, label: "Vertex" }]);

      const ctx = mockContext({
        callbackQuery: {
          data: "model:list:0",
          message: { message_id: 999 },
        },
        api: {},
      });

      const result = await handleModelSelect(ctx);

      expect(result).toBe(true);
      expect(mocked.selectModelMock).toHaveBeenCalledWith(selectingModelInfo(longModelID));
      expect(Buffer.byteLength("model:list:0", "utf-8")).toBeLessThanOrEqual(64);
    });

    it("refreshes the context limit and the keyboard context after selection", async () => {
      mocked.pinnedGetContextInfoMock.mockReturnValue({ tokensUsed: 10, tokensLimit: 1000 });

      const ctx = mockContext({
        callbackQuery: { data: "model:list:0", message: { message_id: 999 } },
      });

      await handleModelSelect(ctx);

      expect(mocked.pinnedRefreshContextLimitMock).toHaveBeenCalled();
      expect(mocked.keyboardUpdateContextMock).toHaveBeenCalledWith(10, 1000);
      expect(mocked.createMainKeyboardMock).toHaveBeenCalledWith(
        "antigravity",
        selectingModelInfo("gemini-3.8-flash-high"),
        { tokensUsed: 10, tokensLimit: 1000 },
        "default",
      );
    });

    it("rejects callbacks that are not model:list callbacks", async () => {
      const ctx = mockContext({
        callbackQuery: { data: "model:providers:0", message: { message_id: 999 } },
      });

      const result = await handleModelSelect(ctx);

      expect(result).toBe(false);
      expect(mocked.ensureActiveInlineMenuMock).not.toHaveBeenCalled();
      expect(mocked.selectModelMock).not.toHaveBeenCalled();
    });

    it("rejects stale search result callbacks instead of parsing them as legacy models", async () => {
      const ctx = mockContext({
        callbackQuery: { data: "model:result:0", message: { message_id: 999 } },
      });

      const result = await handleModelSelect(ctx);

      expect(result).toBe(false);
      expect(mocked.selectModelMock).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
    });

    it("answers with an error for an unresolvable index", async () => {
      const ctx = mockContext({
        callbackQuery: { data: "model:list:abc", message: { message_id: 999 } },
        api: {},
      });

      const result = await handleModelSelect(ctx);

      expect(result).toBe(true);
      expect(mocked.selectModelMock).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: expect.stringContaining(""),
      });
    });

    it("reports a selection failure and still claims the callback", async () => {
      mocked.selectModelMock.mockImplementation(() => {
        throw new Error("store write failed");
      });

      const ctx = mockContext({
        callbackQuery: { data: "model:list:0", message: { message_id: 999 } },
        api: {},
      });

      const result = await handleModelSelect(ctx);

      // `false` here would make the router answer the callback a second time.
      expect(result).toBe(true);
      expect(mocked.failureMock).toHaveBeenCalled();
    });

    it("ignores the callback when the inline menu is stale", async () => {
      mocked.ensureActiveInlineMenuMock.mockResolvedValue(false);

      const ctx = mockContext({
        callbackQuery: { data: "model:list:0", message: { message_id: 999 } },
        api: {},
      });

      const result = await handleModelSelect(ctx);

      expect(result).toBe(true);
      expect(mocked.selectModelMock).not.toHaveBeenCalled();
    });

    it("returns false when the callback has no data", async () => {
      const ctx = mockContext({ callbackQuery: undefined });

      await expect(handleModelSelect(ctx)).resolves.toBe(false);
    });
  });

  describe("listAgyModelsForMenu", () => {
    it("exposes the agy catalog for menu rendering", async () => {
      await expect(listAgyModelsForMenu()).resolves.toEqual(AGY_MODELS_FIXTURE);
    });
  });

  describe("callback data builder", () => {
    it("builds short index callbacks", () => {
      expect(buildModelListCallback(7)).toBe("model:list:7");
    });
  });
});
