import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  config: { telegram: { allowedUserId: 1741860607 } },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: mocked.loggerDebug, warn: mocked.loggerWarn, info: vi.fn(), error: vi.fn() },
}));

import { authMiddleware } from "../../../src/bot/middleware/auth.js";

function makeContext(from: Record<string, unknown> | undefined, chatId?: number) {
  return {
    from,
    chat: chatId ? { id: chatId } : undefined,
    api: { setMyCommands: vi.fn().mockResolvedValue(undefined) },
    callbackQuery: undefined,
    message: { text: "hi" },
  } as never;
}

describe("bot/middleware/auth", () => {
  beforeEach(() => {
    mocked.loggerWarn.mockClear();
  });

  it("ignores bot-originated service updates without auth warnings", async () => {
    const next = vi.fn();
    const ctx = makeContext({ id: 8708798335, is_bot: true }, 8708798335);

    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocked.loggerWarn).not.toHaveBeenCalled();
  });

  it("grants access to the allowed user", async () => {
    const next = vi.fn();
    const ctx = makeContext({ id: 1741860607, is_bot: false }, 1741860607);

    await authMiddleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocked.loggerWarn).not.toHaveBeenCalled();
  });

  it("warns once and throttles repeat attempts from the same unauthorized user", async () => {
    const next = vi.fn();
    const ctx = makeContext({ id: 555000111, is_bot: false }, 555000111);

    await authMiddleware(ctx, next);
    await authMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocked.loggerWarn).toHaveBeenCalledTimes(1);
  });
});
