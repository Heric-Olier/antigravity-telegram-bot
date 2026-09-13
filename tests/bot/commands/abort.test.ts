import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const mocked = vi.hoisted(() => ({
  getCurrentSessionMock: vi.fn(),
  clearAllInteractionStateMock: vi.fn(),
  promptQueueClearMock: vi.fn(),
  promptAttachmentClearMock: vi.fn(),
  markUserAbortRequestedMock: vi.fn(),
  stopEventListeningMock: vi.fn(),
  markIdleMock: vi.fn(),
  clearRunMock: vi.fn(),
  markAttachedSessionIdleMock: vi.fn(),
  clearPromptResponseModeMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: mocked.getCurrentSessionMock,
}));

vi.mock("../../../src/app/managers/interaction-manager.js", () => ({
  clearAllInteractionState: mocked.clearAllInteractionStateMock,
  interactionManager: { getSnapshot: vi.fn(() => null), clear: vi.fn() },
}));

vi.mock("../../../src/app/managers/prompt-queue-manager.js", () => ({
  promptQueue: { clear: mocked.promptQueueClearMock, __resetForTests: vi.fn() },
}));

vi.mock("../../../src/app/managers/prompt-attachment-manager.js", () => ({
  promptAttachment: { clear: mocked.promptAttachmentClearMock, __resetForTests: vi.fn() },
}));

vi.mock("../../../src/app/managers/abort-suppression-manager.js", () => ({
  markUserAbortRequested: mocked.markUserAbortRequestedMock,
}));

vi.mock("../../../src/antigravity/events.js", () => ({
  stopEventListening: mocked.stopEventListeningMock,
}));

vi.mock("../../../src/app/managers/foreground-session-state-manager.js", () => ({
  foregroundSessionState: { markIdle: mocked.markIdleMock },
}));

vi.mock("../../../src/app/managers/assistant-run-state-manager.js", () => ({
  assistantRunState: { clearRun: mocked.clearRunMock },
}));

vi.mock("../../../src/app/services/attach-service.js", () => ({
  markAttachedSessionIdle: mocked.markAttachedSessionIdleMock,
}));

vi.mock("../../../src/bot/handlers/prompt.js", () => ({
  clearPromptResponseMode: mocked.clearPromptResponseModeMock,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: mocked.loggerErrorMock },
}));

vi.mock("../../../src/i18n/index.js", () => ({
  t: (key: string) => key,
  normalizeLocale: vi.fn((l: string) => l),
}));

import { abortCommand, abortCurrentOperation } from "../../../src/bot/commands/abort-command.js";

function createCtx(): Context {
  return {
    chat: { id: 777, type: "private" },
    reply: vi.fn(),
  } as unknown as Context;
}

describe("bot/commands/abort (agy)", () => {
  beforeEach(() => {
    Object.values(mocked).forEach((m) => m.mockReset());
    mocked.getCurrentSessionMock.mockReturnValue({
      id: "session-1",
      title: "Session",
      directory: "/repo",
    });
    mocked.stopEventListeningMock.mockResolvedValue(undefined);
    mocked.markAttachedSessionIdleMock.mockResolvedValue(undefined);
  });

  it("clears interaction state and stops the agy process (SIGINT path)", async () => {
    const ctx = createCtx();

    await abortCommand(ctx as never);

    expect(mocked.clearAllInteractionStateMock).toHaveBeenCalledWith("abort_command");
    expect(mocked.promptQueueClearMock).toHaveBeenCalledWith("abort_command");
    expect(mocked.promptAttachmentClearMock).toHaveBeenCalledWith("abort_command");
    expect(mocked.markUserAbortRequestedMock).toHaveBeenCalledWith("session-1");
    expect(mocked.stopEventListeningMock).toHaveBeenCalled();
    expect(mocked.markIdleMock).toHaveBeenCalledWith("session-1");
    expect(mocked.clearRunMock).toHaveBeenCalledWith("session-1", "abort_confirmed");
    expect(mocked.markAttachedSessionIdleMock).toHaveBeenCalledWith("session-1");
    expect(mocked.clearPromptResponseModeMock).toHaveBeenCalledWith("session-1");
    expect(ctx.reply).toHaveBeenCalledWith("stop.success");
  });

  it("can abort silently without progress messages", async () => {
    const ctx = createCtx();

    await abortCurrentOperation(ctx, { notifyUser: false });

    expect(mocked.stopEventListeningMock).toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("replies with no_active_session when there is none", async () => {
    const ctx = createCtx();
    mocked.getCurrentSessionMock.mockReturnValue(null);

    await abortCommand(ctx as never);

    expect(mocked.stopEventListeningMock).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith("stop.no_active_session");
    expect(mocked.markIdleMock).not.toHaveBeenCalled();
  });

  it("replies with stop.error when SIGINT fails", async () => {
    const ctx = createCtx();
    mocked.stopEventListeningMock.mockRejectedValue(new Error("kill failed"));

    await abortCommand(ctx as never);

    expect(mocked.loggerErrorMock).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith("stop.error");
  });
});
