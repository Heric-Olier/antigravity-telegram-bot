import { describe, expect, it, vi } from "vitest";
import type { Context, NextFunction } from "grammy";
import { defined } from "../../helpers/defined.js";

const mocked = vi.hoisted(() => ({
  flushPendingPrompt: vi.fn(),
}));

vi.mock("../../../src/bot/handlers/message-merger.js", () => ({
  flushPendingPrompt: mocked.flushPendingPrompt,
  __resetMessageMergerForTests: vi.fn(),
}));

import {
  ensureCommandsInitialized,
  registerCommandRouter,
} from "../../../src/bot/routers/command-router.js";
import { BOT_COMMANDS } from "../../../src/bot/commands/definitions.js";
import { config } from "../../../src/config.js";

describe("bot/routers/command-router", () => {
  it("registers bot slash command handlers", () => {
    const bot = { command: vi.fn(), use: vi.fn() };

    registerCommandRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      clearRuntimeState: vi.fn(),
    });

    expect(bot.command.mock.calls.map(([command]) => command)).toEqual([
      "start",
      "help",
      "status",
      "usage",
      "settings",
      "projects",
      "worktree",
      "open",
      "ls",
      "sessions",
      "messages",
      "new",
      "abort",
      "detach",
      "task",
      "tasklist",
      "rename",
      "commands",
      "skills",
      "mcps",
    ]);
  });

  it("flushes a pending prompt before routing a command", async () => {
    const bot = { command: vi.fn(), use: vi.fn() };
    const next = vi.fn();
    registerCommandRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      clearRuntimeState: vi.fn(),
    });
    const middleware = defined(bot.use.mock.calls[0]?.[0]);
    const ctx = { chat: { id: 123 }, message: { text: "/new" } } as unknown as Context;

    await middleware(ctx, next);

    expect(mocked.flushPendingPrompt).toHaveBeenCalledWith(123);
    expect(next).toHaveBeenCalledOnce();
  });

  it("registers local commands from the registry after the built-ins", async () => {
    const bot = { command: vi.fn(), use: vi.fn() };
    const localCommandRegistry = {
      definitions: vi.fn(() => [{ command: "ping", description: "Ping", allowWhenBusy: false }]),
      execute: vi.fn(),
    };

    registerCommandRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      clearRuntimeState: vi.fn(),
      localCommandRegistry: localCommandRegistry as never,
    });

    const registeredCommands = bot.command.mock.calls.map(([command]) => command);
    expect(registeredCommands).toContain("ping");
    const pingRegistration = bot.command.mock.calls.find(([command]) => command === "ping");

    const ctx = {
      chat: { id: 123 },
      api: { sendMessage: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Context;
    localCommandRegistry.execute.mockResolvedValue({ kind: "success", text: "pong" });
    await pingRegistration?.[1](ctx);

    expect(localCommandRegistry.execute).toHaveBeenCalledWith("ping");
    expect(ctx.api.sendMessage).toHaveBeenCalled();
  });

  it("initializes commands for the authorized chat", async () => {
    const next: NextFunction = vi.fn();
    const ctx = {
      from: { id: config.telegram.allowedUserId },
      chat: { id: 123 },
      api: { setMyCommands: vi.fn() },
    } as unknown as Context;

    await ensureCommandsInitialized(ctx, next);

    expect(ctx.api.setMyCommands).toHaveBeenCalledWith(BOT_COMMANDS, {
      scope: { type: "chat", chat_id: 123 },
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
