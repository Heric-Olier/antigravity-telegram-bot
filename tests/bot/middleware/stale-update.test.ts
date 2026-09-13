import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, NextFunction } from "grammy";

const mocked = vi.hoisted(() => ({
  loggerDebugMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: mocked.loggerDebugMock,
    info: mocked.loggerInfoMock,
    warn: mocked.loggerWarnMock,
    error: mocked.loggerErrorMock,
  },
}));

import { staleUpdateMiddleware } from "../../../src/bot/middleware/stale-update.js";

const NOW_MS = Date.UTC(2026, 6, 27, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function createMessageContext(ageSeconds: number): Context {
  return {
    update: { update_id: 1000 },
    chat: { id: 1 },
    message: {
      message_id: 42,
      date: NOW_SECONDS - ageSeconds,
      text: "hello",
    } as Context["message"],
  } as unknown as Context;
}

function createCallbackContext(messageAgeSeconds: number): Context {
  return {
    update: { update_id: 1001 },
    callbackQuery: {
      data: "project:123",
      message: {
        message_id: 43,
        date: NOW_SECONDS - messageAgeSeconds,
      },
    } as unknown as Context["callbackQuery"],
  } as unknown as Context;
}

function createUpdateWithoutMessage(): Context {
  return {
    update: { update_id: 1002 },
    myChatMember: { date: NOW_SECONDS },
  } as unknown as Context;
}

describe("staleUpdateMiddleware", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    mocked.loggerWarnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through a fresh message", async () => {
    const ctx = createMessageContext(0);
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await staleUpdateMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocked.loggerWarnMock).not.toHaveBeenCalled();
  });

  it("passes through a message exactly at the age threshold", async () => {
    const ctx = createMessageContext(60);
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await staleUpdateMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocked.loggerWarnMock).not.toHaveBeenCalled();
  });

  it("drops a message just past the age threshold and logs a warning", async () => {
    const ctx = createMessageContext(61);
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await staleUpdateMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledTimes(1);
  });

  it("drops a message queued for an hour", async () => {
    const ctx = createMessageContext(3600);
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await staleUpdateMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledTimes(1);
  });

  it("always passes through a callback query, even under an old bot message", async () => {
    const ctx = createCallbackContext(6 * 3600);
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await staleUpdateMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocked.loggerWarnMock).not.toHaveBeenCalled();
  });

  it("passes through an update without a message", async () => {
    const ctx = createUpdateWithoutMessage();
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await staleUpdateMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocked.loggerWarnMock).not.toHaveBeenCalled();
  });

  it("passes through a message dated in the future when clocks drift", async () => {
    const ctx = createMessageContext(-30);
    const next: NextFunction = vi.fn().mockResolvedValue(undefined);

    await staleUpdateMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocked.loggerWarnMock).not.toHaveBeenCalled();
  });
});
