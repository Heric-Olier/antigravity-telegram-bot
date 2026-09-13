import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import { newCommand } from "../../../src/bot/commands/new-command.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  replyBusyBlockedMock: vi.fn(),
  getCurrentProjectMock: vi.fn(),
  attachToSessionMock: vi.fn(),
  ensureEventSubscriptionMock: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  __resetSettingsForTests: vi.fn(),
  getCurrentProject: mocked.getCurrentProjectMock,
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  setCurrentSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("../../../src/antigravity/events.js", () => ({
  stopEventListening: vi.fn(),
}));

const fg = vi.hoisted(() => ({ busy: false }));

vi.mock("../../../src/app/services/run-control-service.js", () => ({
  isForegroundBusy: vi.fn(() => fg.busy),
}));

vi.mock("../../../src/bot/messages/busy-blocked-renderer.js", () => ({
  replyBusyBlocked: mocked.replyBusyBlockedMock,
}));

vi.mock("../../../src/app/managers/interaction-manager.js", () => ({
  interactionManager: { clear: vi.fn(), getSnapshot: vi.fn(() => null) },
  clearAllInteractionState: vi.fn(),
}));

vi.mock("../../../src/bot/keyboards/keyboard-manager.js", () => ({
  keyboardManager: {
    initialize: vi.fn(),
    updateAgent: vi.fn(),
    getContextInfo: vi.fn(() => null),
  },
}));

vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  getStoredAgent: vi.fn(() => "build"),
  resolveProjectAgent: vi.fn(async (agentName?: string) => agentName ?? "build"),
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: vi.fn(() => ({
    providerID: "antigravity",
    modelID: "gemini-3.8-flash-high",
    variant: "default",
  })),
}));

vi.mock("../../../src/app/services/variant-selection-service.js", () => ({
  formatVariantForButton: vi.fn(() => "Default"),
}));

vi.mock("../../../src/bot/keyboards/main-reply-keyboard.js", () => ({
  createMainKeyboard: vi.fn(() => ({ keyboard: true })),
}));

vi.mock("../../../src/app/services/attach-service.js", () => ({
  attachToSession: mocked.attachToSessionMock,
}));

function createContext(): Context {
  return {
    chat: { id: 123 },
    api: {},
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as unknown as Context;
}

function createDeps() {
  return {
    bot: { api: {} } as Bot<Context>,
    ensureEventSubscription: mocked.ensureEventSubscriptionMock,
  };
}

describe("bot/commands/new", () => {
  beforeEach(() => {
    fg.busy = false;
    mocked.getCurrentProjectMock.mockReset();
    mocked.attachToSessionMock.mockReset();
    mocked.attachToSessionMock.mockResolvedValue({
      busy: false,
      alreadyAttached: false,
      restoredQuestion: false,
      restoredPermissions: 0,
    });
    mocked.ensureEventSubscriptionMock.mockReset();
    mocked.getCurrentProjectMock.mockReturnValue({ id: "project-1", worktree: "/repo" });
  });

  it("blocks new session creation while foreground session is busy", async () => {
    fg.busy = true;

    const ctx = createContext();
    await newCommand(ctx as never, createDeps());

    expect(mocked.attachToSessionMock).not.toHaveBeenCalled();
    expect(mocked.replyBusyBlockedMock).toHaveBeenCalledOnce();
  });

  it("requires a selected project before creating a session", async () => {
    mocked.getCurrentProjectMock.mockReturnValue(null);

    const ctx = createContext();
    await newCommand(ctx as never, createDeps());

    expect(mocked.attachToSessionMock).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("new.project_not_selected"));
  });

  it("creates a new agy conversation attached to the current project worktree", async () => {
    const ctx = createContext();
    await newCommand(ctx as never, createDeps());

    expect(mocked.attachToSessionMock).toHaveBeenCalledWith({
      bot: expect.any(Object),
      chatId: 123,
      session: expect.objectContaining({
        title: "New conversation",
        directory: "/repo",
      }),
      ensureEventSubscription: mocked.ensureEventSubscriptionMock,
    });
    expect(ctx.reply).toHaveBeenCalledWith(
      t("new.created", { title: "New conversation" }),
      expect.objectContaining({
        reply_markup: { keyboard: true },
      }),
    );
  });
});
