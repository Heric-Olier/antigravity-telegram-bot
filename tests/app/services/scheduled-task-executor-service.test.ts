import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import type { ScheduledOnceTask, ScheduledTaskExecutionResult } from "../../../src/app/types/scheduled-task.js";

const mocked = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mocked.execFileMock,
}));

vi.mock("../../../src/config.js", () => ({
  config: {
    antigravity: {
      bin: "/usr/bin/agy",
      workspaceDir: "/workspace",
    },
    bot: {
      scheduledTaskExecutionTimeoutMinutes: 120,
    },
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    warn: mocked.loggerWarnMock,
    info: mocked.loggerInfoMock,
    debug: vi.fn(),
    error: mocked.loggerErrorMock,
  },
}));

import {
  executeScheduledTask,
  ScheduledTaskEmptyAssistantResponseError,
  ScheduledTaskInteractiveRequestError,
} from "../../../src/app/services/scheduled-task-executor-service.js";

function createTask(partial: Partial<ScheduledOnceTask> = {}): ScheduledOnceTask {
  return {
    id: "task-1",
    kind: "once",
    projectId: "project-1",
    projectWorktree: "D:\\Projects\\Repo",
    agent: "build",
    model: {
      providerID: "antigravity",
      modelID: "gemini-3.8-flash-high",
      variant: "default",
    },
    scheduleText: "tomorrow at 12:00",
    scheduleSummary: "Tomorrow at 12:00",
    timezone: "UTC",
    runAt: "2026-03-16T10:00:00.000Z",
    prompt: "Send report",
    createdAt: "2026-03-16T09:00:00.000Z",
    nextRunAt: "2026-03-16T10:00:00.000Z",
    lastRunAt: null,
    runCount: 0,
    lastStatus: "idle",
    lastError: null,
    ...partial,
  };
}

describe("app/services/scheduled-task-executor-service (agy)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocked.execFileMock.mockReset();
    mocked.loggerWarnMock.mockReset();
    mocked.loggerInfoMock.mockReset();
    mocked.loggerErrorMock.mockReset();
  });

  it("runs a one-shot agy print in the project directory and returns the assistant response", async () => {
    mocked.execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: Record<string, unknown>,
        cb: (err: null, stdout: string) => void,
      ) => {
        expect(_bin).toBe("/usr/bin/agy");
        expect(_args[0]).toBe("--print");
        expect(_args[1]).toBe("Send report");
        expect(_opts.cwd).toBe("D:\\Projects\\Repo");
        setTimeout(() => cb(null, '{"response":"Finished successfully"}'), 0);
        return { stdin: { end: vi.fn() } };
      },
    );

    const result = await executeScheduledTask(createTask());

    expect(result).toMatchObject({
      taskId: "task-1",
      status: "success",
      resultText: "Finished successfully",
      errorMessage: null,
    });
  });

  it("returns an error result when the agy run fails", async () => {
    mocked.execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: Record<string, unknown>,
        cb: (err: Error, stdout: string) => void,
      ) => {
        setTimeout(() => cb(new Error("agy exited 1"), ""), 0);
        return { stdin: { end: vi.fn() } };
      },
    );

    const result = await executeScheduledTask(createTask());

    expect(result).toMatchObject({
      taskId: "task-1",
      status: "error",
      resultText: null,
    });
    expect(result.errorMessage).toBeTruthy();
  });

  it("returns an error result when the agy run yields an empty response", async () => {
    mocked.execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: Record<string, unknown>,
        cb: (err: null, stdout: string) => void,
      ) => {
        setTimeout(() => cb(null, '{"response":""}'), 0);
        return { stdin: { end: vi.fn() } };
      },
    );

    const result = await executeScheduledTask(createTask());

    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain("without an assistant response");
  });

  it("falls back to the workspace directory when the task has none", async () => {
    const task = createTask({ projectWorktree: "" as unknown as string });
    mocked.execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        opts: Record<string, unknown>,
        cb: (err: null, stdout: string) => void,
      ) => {
        expect(opts.cwd).toBe("/workspace");
        setTimeout(() => cb(null, '{"response":"ok"}'), 0);
        return { stdin: { end: vi.fn() } };
      },
    );

    const result = await executeScheduledTask(task);
    expect(result.status).toBe("success");
  });

  it("exposes interactive/empty error classes for callers", () => {
    expect(new ScheduledTaskInteractiveRequestError("permission").kind ?? undefined).toBeUndefined();
    expect(new ScheduledTaskInteractiveRequestError("permission").message).toContain("interactive permission");
    expect(new ScheduledTaskEmptyAssistantResponseError().message).toContain("assistant response");
  });
});
