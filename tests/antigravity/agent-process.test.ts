import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// NDJSON fixture: exactly the lines agy 1.1.27 emits (verified against the
// agent.py spike, sep-2026), plus a non-JSON warning line and a tool ERROR.
const FIXTURE_STDOUT = [
  "Warning: something unrelated to the protocol", // non-JSON line — must be discarded
  JSON.stringify({
    event: "init",
    conversation_id: "6a65b4c5-a817-40ab-9e8d-13b772233dfb",
    init: { cwd: "/home/user/proj", tools: ["write_to_file", "run"], permission_mode: "default" },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      step_index: 0,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "write_to_file",
      tool_info: { name: "write_to_file", parameters: { file_path: "a.txt", content: "hi" } },
    },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      step_index: 1,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: "Escribí el archivo",
    },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      step_index: 2,
      state: "ERROR",
      step_type: "tool",
      tool_name: "write_to_file",
      tool_info: { name: "write_to_file", parameters: {}, error: "Permission denied: /etc/passwd" },
    },
  }),
  "{not real json", // unparseable line — must be discarded
  JSON.stringify({
    event: "result",
    result: {
      status: "SUCCESS",
      response: "Listo",
      duration_seconds: 4.2,
      num_turns: 3,
      usage: { inputTokens: 100, outputTokens: 20 },
    },
  }),
];

type SpawnedChild = {
  stdin: EventEmitter & { write: (chunk: string, cb?: (err?: Error) => void) => void; end: () => void; writable: boolean };
  stdout: EventEmitter & { setEncoding: (enc: string) => void };
  stderr: EventEmitter & { setEncoding: (enc: string) => void };
  pid: number;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
  exitCode: number | null;
  signalCode: number | string | null;
};

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal<typeof import("node:child_process")>()) as Record<string, unknown>;
  return {
    ...actual,
    default: { ...(actual as { default?: object }).default, spawn: spawnMock },
    spawn: spawnMock,
  };
});

import {
  AntigravityProcess,
  createAgySpawnCommand,
  mapRawMessage,
  type AgyEvent,
} from "../../src/antigravity/agent-process.js";

function createFakeChild(lines: string[]): SpawnedChild & { pump: (delayMs?: number) => void } {
  const child = new EventEmitter() as unknown as SpawnedChild;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const setEncoding = (enc: string): void => {
    void enc;
  };
  (stdout as unknown as { setEncoding: (enc: string) => void }).setEncoding = vi.fn(setEncoding);
  (stderr as unknown as { setEncoding: (enc: string) => void }).setEncoding = vi.fn(setEncoding);
  // readline requires a full readable stream API on stdout.
  for (const stream of [stdout, stderr]) {
    (stream as unknown as { resume: () => void }).resume = (): void => {};
    (stream as unknown as { pause: () => void }).pause = (): void => {};
    (stream as unknown as { readable: boolean }).readable = true;
    (stream as unknown as { [Symbol.asyncIterator]: () => unknown })[Symbol.asyncIterator] = function* () {};
  }
  (child as unknown as { stdout: unknown; stderr: unknown }).stdout = stdout;
  (child as unknown as { stderr: unknown }).stderr = stderr;

  const stdinWrites: string[] = [];
  const stdin = new EventEmitter() as unknown as SpawnedChild["stdin"];
  (stdin as unknown as { writable: boolean }).writable = true;
  (stdin as unknown as { write: (chunk: string, cb?: (err?: Error) => void) => void }).write = (
    chunk: string,
    cb?: (err?: Error) => void,
  ) => {
    stdinWrites.push(chunk);
    cb?.();
    return true;
  };
  (stdin as unknown as { end: () => void }).end = vi.fn();
  (child as unknown as { stdin: SpawnedChild["stdin"]; stdinWrites: string[] }).stdin = stdin;
  (child as unknown as { stdinWrites: string[] }).stdinWrites = stdinWrites;
  (child as { exitCode: number | null }).exitCode = null;
  (child as { signalCode: number | string | null }).signalCode = null;
  (child as { pid: number }).pid = 4242;

  let pumped = false;
  const pump = (delayMs = 5): void => {
    if (pumped) {
      return;
    }
    pumped = true;
    setTimeout(() => {
      for (const line of lines) {
        stdout.emit("data", `${line}\n`);
      }
    }, delayMs);
  };
  (child as unknown as { pump: () => void }).pump = pump;

  return Object.assign(child, { pump }) as SpawnedChild & { pump: () => void };
}

function collectEvents(proc: AntigravityProcess): { kinds: string[]; events: AgyEvent[] } {
  const kinds: string[] = [];
  const events: AgyEvent[] = [];
  for (const kind of ["init", "step", "result"] as const) {
    proc.on(kind, (event: AgyEvent) => {
      kinds.push(kind);
      events.push(event);
    });
  }
  return { kinds, events };
}

function flushAsync(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapRawMessage", () => {
  it("maps the real init line", () => {
    const event = mapRawMessage(JSON.parse(FIXTURE_STDOUT[1] ?? "{}"));
    expect(event).toMatchObject({
      kind: "init",
      conversationId: "6a65b4c5-a817-40ab-9e8d-13b772233dfb",
      cwd: "/home/user/proj",
      permissionMode: "default",
    });
    expect((event as { tools?: string[] }).tools).toEqual(["write_to_file", "run"]);
  });

  it("maps a tool step with error info", () => {
    const event = mapRawMessage(JSON.parse(FIXTURE_STDOUT[4] ?? "{}"));
    expect(event).toMatchObject({
      kind: "step",
      state: "ERROR",
      stepType: "tool",
      toolName: "write_to_file",
    });
    expect((event as { toolInfo?: { error?: string } }).toolInfo?.error).toBe("Permission denied: /etc/passwd");
  });

  it("maps the result line", () => {
    const event = mapRawMessage(JSON.parse(FIXTURE_STDOUT.at(-1) ?? "{}"));
    expect(event).toMatchObject({
      kind: "result",
      status: "SUCCESS",
      response: "Listo",
      numTurns: 3,
    });
  });

  it("returns null for unknown events and invalid states", () => {
    expect(mapRawMessage({ event: "user", message: { content: "x" } })).toBeNull();
    expect(mapRawMessage({ event: "step_update", step_update: { step_index: 0, state: "WEIRD" } })).toBeNull();
    expect(mapRawMessage(null)).toBeNull();
    expect(mapRawMessage("nope")).toBeNull();
  });
});

describe("createAgySpawnCommand", () => {
  it("keeps --print= empty and appends the wire flags in order", () => {
    const command = createAgySpawnCommand({ conversationId: "c1", model: "gemini-3.8-flash-high" });

    expect(command.command).toContain("agy");
    expect(command.args[0]).toBe("--print=");
    expect(command.args).toContain("--input-format");
    expect(command.args).toContain("stream-json");
    expect(command.args).toContain("--output-format");
    expect(command.args).toContain("stream-json");
    expect(command.args.some((arg) => arg.startsWith("--print-timeout="))).toBe(true);
    expect(command.args).toContain("--conversation=c1");
    expect(command.args).toContain("--model=gemini-3.8-flash-high");
    expect(command.args).toContain("--dangerously-skip-permissions");
  });

  it("skips the skip-permissions flag when yolo is disabled", async () => {
    vi.resetModules();
    await vi.stubEnv("AGY_YOLO", "false");
    const configModule = (await import("../../src/config.js")) as {
      config: { antigravity: { yolo: boolean } };
    };
    expect(configModule.config.antigravity.yolo).toBe(false);
    const { createAgySpawnCommand: freshCommand } = await import(
      "../../src/antigravity/agent-process.js"
    );
    const command = freshCommand({});
    expect(command.args).not.toContain("--dangerously-skip-permissions");
    vi.resetModules();
    await import("../../src/antigravity/agent-process.js");
  });
});

describe("AntigravityProcess", () => {
  let fakeChild: ReturnType<typeof createFakeChild>;

  beforeEach(() => {
    fakeChild = createFakeChild(FIXTURE_STDOUT);
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild);
  });

  it("pipes one user event per prompt and closes stdin after writing", async () => {
    const proc = new AntigravityProcess({ cwd: "/tmp/proj" });
    proc.spawn();

    const stdin = (fakeChild as unknown as { stdin: { write: (c: string, cb?: (e?: Error) => void) => void; end: () => void } }).stdin;
    const endSpy = stdin.end as ReturnType<typeof vi.fn>;

    await proc.sendPrompt("hola mundo");

    const written = String((fakeChild as unknown as { stdinWrites: string[] }).stdinWrites?.[0] ?? "");
    expect(written.endsWith("\n")).toBe(true);
    expect(JSON.parse(written.trim())).toEqual({
      event: "user",
      message: { content: "hola mundo" },
    });
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it("emits init, steps, and result for the real fixture lines (discarding non-JSON)", async () => {
    const proc = new AntigravityProcess({ cwd: "/tmp/proj" });
    const { kinds, events } = collectEvents(proc);
    proc.spawn();

    fakeChild.pump();
    await flushAsync();

    expect(kinds).toEqual(["init", "step", "step", "step", "result"]);
    expect(events[0]).toMatchObject({ kind: "init", conversationId: "6a65b4c5-a817-40ab-9e8d-13b772233dfb" });
    expect(events[1]).toMatchObject({
      kind: "step",
      state: "ACTIVE",
      stepType: "tool",
      toolName: "write_to_file",
    });
    expect(events[2]).toMatchObject({ kind: "step", stepType: "agent_response", textDelta: "Escribí el archivo" });
    expect(events[3]).toMatchObject({ kind: "step", state: "ERROR", toolName: "write_to_file" });
    expect(events[4]).toMatchObject({ kind: "result", status: "SUCCESS", numTurns: 3 });
  });

  it("buffers stderr diagnostics", async () => {
    const proc = new AntigravityProcess({ cwd: "/tmp/proj" });
    proc.spawn();

    const stderr = (fakeChild as unknown as { stderr: EventEmitter }).stderr;
    stderr.emit("data", "boom 1\n");
    stderr.emit("data", "boom 2\n");
    await flushAsync(0);

    expect(proc.getStderrTail()).toBe("boom 1\nboom 2");
  });

  it("starts the child with cwd from options and stdio pipes", () => {
    const proc = new AntigravityProcess({ cwd: "/tmp/proj" });
    proc.spawn();

    const spawnCallArgs = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; stdio: string[] },
    ];
    expect(spawnCallArgs[2].cwd).toBe("/tmp/proj");
    expect(spawnCallArgs[2].stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("reports exit and clears resources when the process dies", async () => {
    const proc = new AntigravityProcess({ cwd: "/tmp/proj" });
    const exitSpy = vi.fn();
    proc.on("exit", exitSpy);
    proc.spawn();

    fakeChild.pump();
    await flushAsync();

    (fakeChild as { exitCode: number | null }).exitCode = 0;
    (fakeChild as unknown as EventEmitter).emit("exit", 0, null);
    await flushAsync(0);

    expect(exitSpy).toHaveBeenCalledWith({ code: 0, signal: null });
    expect(proc.isRunning()).toBe(false);
    expect(proc.getStderrTail()).toBeDefined();
  });

  it("kills with SIGINT then SIGKILL escalation when the child survives", async () => {
    // Fresh child that never dies on its own until SIGKILL.
    const stubbornChild = createFakeChild([]);
    spawnMock.mockImplementation(() => stubbornChild);

    const proc = new AntigravityProcess({ cwd: "/tmp/proj" });
    proc.spawn();
    await flushAsync(1);

    const killCalls: Array<[number | undefined, string | undefined]> = [];
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid?: number, signal?: string) => {
        killCalls.push([pid, signal]);
        return true;
      }) as never);

    const killPromise = proc.kill();

    await flushAsync(3100);
    await killPromise;

    const signals = killSpy.mock.calls.map((call) => String(call[1]));
    expect(signals.filter((signal) => signal === "SIGINT").length).toBeGreaterThan(0);
    expect(signals).toContain("SIGKILL");
    killSpy.mockRestore();
  });

  it("kill on a dead process is a no-op", async () => {
    const proc = new AntigravityProcess({ cwd: "/tmp/proj" });
    // Never spawned: must not throw.
    await proc.kill();
    expect(proc.isRunning()).toBe(false);
  });

  it("sendPrompt rejects when no process is running", async () => {
    const proc = new AntigravityProcess();
    await expect(proc.sendPrompt("x")).rejects.toThrow(/not running/);
  });

  it("handles abrupt stdout close without emitting further events", async () => {
    const proc = new AntigravityProcess({ cwd: "/tmp/proj" });
    const { kinds, events } = collectEvents(proc);
    proc.spawn();

    const stdout = (fakeChild as unknown as { stdout: EventEmitter }).stdout;
    stdout.emit("data", FIXTURE_STDOUT[1]);
    await flushAsync();

    stdout.emit("close");
    stdout.emit("end");
    (fakeChild as { exitCode: number | null }).exitCode = 1;
    (fakeChild as unknown as EventEmitter).emit("exit", 1, null);
    await flushAsync();

    stdout.emit("data", FIXTURE_STDOUT.at(-1));
    await flushAsync();

    expect(kinds).toEqual(["init"]);
    expect(events[0]).toMatchObject({ kind: "init" });
    expect(proc.isRunning()).toBe(false);
  });
});
