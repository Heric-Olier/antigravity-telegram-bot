import { EventEmitter, type Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// Fixture: the exact NDJSON lines the agy 1.1.27 spike produced (sep-2026),
// including a non-JSON warning line and a tool step carrying an error.
const FIXTURE_LINES = [
  "Warning: binary update available", // non-JSON — discarded
  JSON.stringify({
    event: "init",
    conversation_id: "6a65b4c5-a817-40ab-9e8d-13b772233dfb",
    init: { cwd: "/home/user/proj", tools: ["write_to_file"], permission_mode: "default" },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      step_index: 0,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "write_to_file",
      tool_info: { name: "write_to_file", parameters: { file_path: "a.txt" } },
    },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: { step_index: 1, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: {} },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: { step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "Escribí a.txt" },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: {
      step_index: 3,
      state: "ERROR",
      step_type: "tool",
      tool_name: "run",
      tool_info: { name: "run", parameters: { cmd: "x" }, error: "exit code 1" },
    },
  }),
  JSON.stringify({
    event: "step_update",
    step_update: { step_index: 4, state: "DONE", step_type: "user_input" }, // echo — must be ignored
  }),
  "{broken json", // discarded
  JSON.stringify({
    event: "result",
    result: {
      status: "SUCCESS",
      response: "Listo. Escribí a.txt, aunque run falló.",
      duration_seconds: 5.1,
      num_turns: 4,
      usage: { inputTokens: 100, outputTokens: 30 },
      denied_actions: [],
    },
  }),
];

const ERROR_RESULT_LINE = JSON.stringify({
  event: "result",
  result: { status: "ERROR", response: "se rompió algo", num_turns: 1 },
});

type SpawnCapture = {
  child: EventEmitter & {
    stdout: Readable;
    stdin: { writes: string[]; end: ReturnType<typeof vi.fn> };
  };
  options: { cwd?: string; stdio?: string[] };
};

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  spawn: spawnMock,
}));

function makeFakeChild(): SpawnCapture {
  const stdout = new EventEmitter() as unknown as Readable;
  (stdout as unknown as { setEncoding: (enc: string) => void }).setEncoding = (): void => {};
  (stdout as unknown as { resume: () => void }).resume = (): void => {};
  (stdout as unknown as {pause: () => void}).pause = (): void => {};
  (stdout as unknown as { readable: boolean }).readable = true;

  const stdin = {
    writes: [] as string[],
    end: vi.fn(),
    write: (chunk: string, cb?: (err?: Error) => void): boolean => {
      stdin.writes.push(chunk);
      cb?.();
      return true;
    },
    writable: true,
  };

  const child = new EventEmitter() as unknown as SpawnCapture["child"];
  (child as unknown as { stdout: Readable }).stdout = stdout as Readable;
  (child as unknown as { stderr: { setEncoding: (enc: string) => void; on: (...a: unknown[]) => void } }).stderr = {
    setEncoding: (): void => {},
    on: (): void => {},
  } as never;
  (child as unknown as { stdin: unknown }).stdin = stdin;
  (child as unknown as { pid: number }).pid = 777;
  (child as unknown as { exitCode: number | null }).exitCode = null;
  (child as unknown as { signalCode: number | string | null }).signalCode = null;

  return { child: Object.assign(child, { stdout }), options: {}, stdoutWrapper: stdout } as unknown as SpawnCapture & {
    stdoutWrapper: unknown;
  };
}

import { subscribeToEvents, stopEventListening, __resetAgyEventsForTests } from "../../src/antigravity/events.js";

type Collected = Array<{ type: string; properties: Record<string, unknown> }>;

function collect(): { events: Collected; callback: (event: Collected[number]) => void } {
  const events: Collected = [];
  const callback = (event: Collected[number]): void => {
    events.push({ type: event.type, properties: event.properties as Record<string, unknown> });
  };
  return { events, callback };
}

function flush(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pumpLines(spawn: SpawnCapture, ...extra: string[]): Promise<void> {
  const stdout = (spawn.child as unknown as { stdout: EventEmitter }).stdout;
  const all = [...FIXTURE_LINES, ...extra];
  await flush(1);
  for (const line of all) {
    stdout.emit("data", `${line}\n`);
  }
  await flush(30);
}

describe("antigravity/events", () => {
  afterEach(() => {
    __resetAgyEventsForTests();
    vi.restoreAllMocks();
  });

  it("emits the full mapped sequence from the live fixture", async () => {
    const spawn = makeFakeChild();
    spawnMock.mockImplementation(() => spawn.child);

    const { events, callback } = collect();
    await subscribeToEvents("/tmp/proj", callback);
    await flush(1);

    expect(spawnMock).toHaveBeenCalledTimes(1);

    await pumpLines(spawn);

    const types = events.map((event) => event.type);
    expect(types).toEqual([
      "session.created",
      "message.part.updated", // tool ACTIVE (running)
      "message.part.updated", // tool DONE (completed)
      "message.part.updated", // agent_response delta
      "message.part.updated", // tool ERROR
      "message.part.updated", // final text
      "message.updated", // completed assistant message
      "session.idle",
    ]);

    // session.created carries the agy conversation title + a stable id.
    const created = events[0]?.properties as { sessionID: string; info: { title: string; directory: string } };
    expect(created.sessionID).toMatch(/^agy-session-/);
    expect(created.info.title).toBe("6a65b4c5-a817-40ab-9e8d-13b772233dfb");
    expect(created.info.directory).toBe("/tmp/proj");

    // tool ACTIVE -> running state part
    const toolActive = events[1]?.properties.part as {
      type: string;
      callID: string;
      tool: string;
      state: { status: string; input: unknown };
    };
    expect(toolActive.type).toBe("tool");
    expect(toolActive.callID).toBe("agy-call-0");
    expect(toolActive.tool).toBe("write_to_file");
    expect(toolActive.state.status).toBe("running");
    expect(toolActive.state.input).toEqual({ file_path: "a.txt" });

    // tool DONE -> completed state part
    const toolDone = events[2]?.properties.part as { state: { status: string } };
    expect(toolDone.state.status).toBe("completed");

    // agent_response -> text part + delta consumed by the aggregator streaming path
    const textDelta = events[3]?.properties;
    const textPart = textDelta?.part as { type: string; text: string; sessionID: string };
    expect(textPart.type).toBe("text");
    expect(textPart.text).toBe("Escribí a.txt");
    expect(textDelta?.delta).toBe("Escribí a.txt");

    // tool ERROR -> error state + error message surfaced
    const toolError = events[4]?.properties.part as { state: { status: string; error: string } };
    expect(toolError.state.status).toBe("error");
    expect(toolError.state.error).toBe("exit code 1");

    // final text
    const finalText = events[5]?.properties.part as { type: string; text: string };
    expect(finalText.text).toBe("Listo. Escribí a.txt, aunque run falló.");

    // message.updated completed assistant message
    const completedInfo = events[6]?.properties.info as { role: string; time: { completed?: number } };
    expect(completedInfo.role).toBe("assistant");
    expect(completedInfo.time.completed).toBeTypeOf("number");

    // session.idle
    expect(events[7]?.properties).toEqual({ sessionID: created.sessionID });
  });

  it("ignores the user_input echo, non-JSON and broken lines", async () => {
    const spawn = makeFakeChild();
    spawnMock.mockImplementation(() => spawn.child);

    const { events, callback } = collect();
    await subscribeToEvents("/tmp/proj", callback);
    await flush(1);
    await pumpLines(spawn);

    expect(events.map((event) => event.type)).not.toContain("session.created".repeat(2).slice(0, 14) + "!!");
    // No event should carry a user_input-derived tool part
    const toolParts = events.filter((event) => event.type === "message.part.updated").map((event) => event.properties.part as { type?: string });
    expect(toolParts.filter((part) => part?.type === "tool").length).toBe(3);
  });

  it("maps result ERROR to session.error + session.idle", async () => {
    const spawn = makeFakeChild();
    spawnMock.mockImplementation(() => spawn.child);

    const { events, callback } = collect();
    await subscribeToEvents("/tmp/proj", callback);
    await flush(1);

    const stdout = (spawn.child as unknown as { stdout: EventEmitter }).stdout;
    await flush(1);
    stdout.emit("data", `${JSON.parse(ERROR_RESULT_LINE) && ERROR_RESULT_LINE}\n`);
    await flush(20);

    const errorEvent = events.find((event) => event.type === "session.error");
    expect(errorEvent?.properties.error).toMatchObject({ name: "AntigravityError", message: "se rompió algo" });

    const idleEvent = events.filter((event) => event.type === "session.idle");
    expect(idleEvent.length).toBe(1);
  });

  it("reuses a single process for a re-subscription to the same directory", async () => {
    const spawn = makeFakeChild();
    spawnMock.mockImplementation(() => spawn.child);

    const first = collect();
    await subscribeToEvents("/tmp/proj", first.callback);
    await flush(1);

    const second = collect();
    await subscribeToEvents("/tmp/proj", second.callback);
    await flush(1);

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("kill path: subscribing to a different directory kills the previous process", async () => {
    const firstSpawn = makeFakeChild();
    const secondSpawn = makeFakeChild();
    spawnMock.mockImplementationOnce(() => firstSpawn.child).mockImplementationOnce(() => secondSpawn.child);

    const killCalls: string[] = [];
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((_pid?: number, _signal?: string) => {
        killCalls.push("SIGINT");
        return true;
      }) as never);

    await subscribeToEvents("/tmp/proj-a", collect().callback);
    await flush(1);
    await subscribeToEvents("/tmp/proj-b", collect().callback);
    await flush(1);

    expect(killCalls).toContain("SIGINT");
    killSpy.mockRestore();
  });

  it("stopEventListening kills the process and clears state", async () => {
    const spawn = makeFakeChild();
    spawnMock.mockImplementation(() => spawn.child);

    const { events, callback } = collect();
    await subscribeToEvents("/tmp/proj", callback);
    await flush(1);

    const killCalls: string[] = [];
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((_pid?: number, _signal?: string) => {
        killCalls.push("SIGINT");
        return true;
      }) as never);

    stopEventListening();
    await flush(5);

    expect(killCalls).toContain("SIGINT");
    // Events after stop must not call the old callback.
    const stdout = (spawn.child as unknown as { stdout: EventEmitter }).stdout;
    const before = events.length;
    stdout.emit("data", `${FIXTURE_LINES[2]}\n`);
    await flush(5);
    expect(events.length).toBe(before);
    killSpy.mockRestore();
  });
});
