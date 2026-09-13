import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileBusyState,
  reconcileBusyStateNow,
} from "../../../src/app/services/busy-reconciliation-service.js";
import { attachManager } from "../../../src/app/managers/attach-manager.js";
import { foregroundSessionState } from "../../../src/app/managers/foreground-session-state-manager.js";

const mocked = vi.hoisted(() => ({
  loggerDebugMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  markIdleMock: vi.fn(),
  attachIdleMock: vi.fn(),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: mocked.loggerDebugMock,
    warn: mocked.loggerWarnMock,
    error: vi.fn(),
  },
}));

/**
 * agy version: the reconciler is a no-op by design — the antigravity events
 * adapter emits session.idle / session.error at the end of every turn, so
 * foreground/attached busy states flip directly from events. The reconciler
 * only verifies there was something to reconcile and logs at debug.
 */

describe("busy reconciliation (agy no-op)", () => {
  beforeEach(() => {
    mocked.loggerDebugMock.mockReset();
    mocked.loggerWarnMock.mockReset();
    foregroundSessionState.__resetForTests();
    attachManager.__resetForTests();
  });

  it("does nothing and does not throw when nothing is busy", async () => {
    await reconcileBusyStateNow("/repo");
    await reconcileBusyState("/repo");
    expect(mocked.loggerWarnMock).not.toHaveBeenCalled();
  });

  it("keeps busy state as-is and logs at debug when there is a busy session", async () => {
    foregroundSessionState.markBusy("session-1", "/repo");
    attachManager.attach("session-1", "/repo");

    await reconcileBusyStateNow("/repo");

    expect(foregroundSessionState.isBusy()).toBe(true);
    expect(mocked.loggerDebugMock).toHaveBeenCalled();
  });

  it("is rate-limited per directory", async () => {
    foregroundSessionState.markBusy("session-1", "/repo");
    await reconcileBusyState("/repo", 1_000);
    const callsAfterFirst = mocked.loggerDebugMock.mock.calls.length;
    await reconcileBusyState("/repo", 2_000);
    expect(mocked.loggerDebugMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
