import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTaskSchedule } from "../../../src/app/services/scheduled-task-schedule-parser-service.js";

const mocked = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  loggerWarnMock: vi.fn(),
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
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: mocked.loggerWarnMock,
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("app/services/scheduled-task-schedule-parser-service", () => {
  beforeEach(() => {
    mocked.execFileMock.mockReset();
    mocked.loggerWarnMock.mockReset();
  });

  it("parses a cron schedule from the agy JSON output", async () => {
    mocked.execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        opts: Record<string, unknown>,
        cb: (err: null, stdout: string) => void,
      ) => {
        expect(opts.cwd).toBe("D:/Projects/Repo");
        setTimeout(
          () =>
            cb(
              null,
              JSON.stringify({
                kind: "cron",
                cron: "*/5 * * * *",
                timezone: "UTC",
                summary: "Every 5 minutes",
                nextRunAt: "2026-03-15T10:05:00.000Z",
              }),
            ),
          0,
        );
        return { stdin: { end: vi.fn() } };
      },
    );

    const result = await parseTaskSchedule("every 5 minutes", "D:/Projects/Repo");

    expect(result).toEqual({
      kind: "cron",
      cron: "*/5 * * * *",
      timezone: "UTC",
      summary: "Every 5 minutes",
      nextRunAt: "2026-03-15T10:05:00.000Z",
    });
  });

  it("parses a one-time schedule from the agy JSON output (fenced tolerated)", async () => {
    mocked.execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: Record<string, unknown>,
        cb: (err: null, stdout: string) => void,
      ) => {
        const json = JSON.stringify({
          kind: "once",
          runAt: "2026-03-16T12:00:00.000Z",
          timezone: "UTC",
          summary: "Tomorrow at 12:00",
          nextRunAt: "2026-03-16T12:00:00.000Z",
        });
        setTimeout(() => cb(null, "```json\n" + json + "\n```"), 0);
        return { stdin: { end: vi.fn() } };
      },
    );

    const result = await parseTaskSchedule("tomorrow at 12:00", "D:/Projects/Repo");

    expect(result).toEqual({
      kind: "once",
      runAt: "2026-03-16T12:00:00.000Z",
      timezone: "UTC",
      summary: "Tomorrow at 12:00",
      nextRunAt: "2026-03-16T12:00:00.000Z",
    });
  });

  it("throws a clear error when the parser output is not valid JSON", async () => {
    mocked.execFileMock.mockImplementation(
      (
        _bin: string,
        _args: string[],
        _opts: Record<string, unknown>,
        cb: (err: null, stdout: string) => void,
      ) => {
        setTimeout(() => cb(null, "this is not json"), 0);
        return { stdin: { end: vi.fn() } };
      },
    );

    await expect(parseTaskSchedule("tomorrow", "D:/Projects/Repo")).rejects.toThrow(
      "invalid JSON",
    );
  });
});
