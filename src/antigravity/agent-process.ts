import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import * as readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Types mirroring the live agy stream-json NDJSON protocol (agy 1.1.27,
// verified 2026-09 against the agent.py spike).

export interface AgyUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  [key: string]: unknown;
}

export interface AgyInitEvent {
  kind: "init";
  conversationId: string;
  cwd?: string;
  tools?: string[];
  permissionMode?: string;
}

export interface AgyStepEvent {
  kind: "step";
  stepIndex: number;
  state: "ACTIVE" | "DONE" | "ERROR";
  stepType?: "user_input" | "agent_response" | "tool" | undefined;
  textDelta?: string | undefined;
  toolName?: string | undefined;
  subagentInfo?:
    | {
        subagents?: Array<{
          type_name?: string | undefined;
          role?: string | undefined;
          conversation_id?: string | undefined;
          status?: string | undefined;
        }>;
      }
    | undefined;
  toolInfo?:
    | {
        name?: string;
        parameters?: { [key: string]: unknown };
        error?: string;
        [key: string]: unknown;
      }
    | undefined;
  usage?: AgyUsage | undefined;
}

export interface AgyResultEvent {
  kind: "result";
  status: "SUCCESS" | "ERROR";
  response?: string;
  error?: string;
  durationSeconds?: number;
  numTurns?: number;
  usage?: AgyUsage;
  deniedActions?: unknown;
}

export type AgyEvent = AgyInitEvent | AgyStepEvent | AgyResultEvent;

export interface AntigravityProcessOptions {
  conversationId?: string;
  model?: string;
  cwd?: string;
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export interface AgySpawnCommand {
  command: string;
  args: string[];
}

// Exported for tests: the pitfalls here are real — `--print=` MUST stay empty
// (a value swallows the next flag) and the input JSON carries a nested
// message.content object, not a plain string.
export function createAgySpawnCommand(options: AntigravityProcessOptions = {}): AgySpawnCommand {
  const bin = expandHome(config.antigravity.bin);
  const args: string[] = [
    "--print=",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    `--print-timeout=${config.antigravity.printTimeout}`,
  ];

  if (options.conversationId) {
    args.push(`--conversation=${options.conversationId}`);
  }
  if (options.model) {
    args.push(`--model=${options.model}`);
  }
  if (config.antigravity.yolo) {
    args.push("--dangerously-skip-permissions");
  } else if (config.antigravity.mode) {
    // Launch in the configured approval mode (default | accept-edits | plan)
    args.push(`--mode=${config.antigravity.mode}`);
  }

  return { command: bin, args };
}

type ProcessListenerCleanup = () => void;

const KILL_ESCALATION_MS = 3000;

export class AntigravityProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly options: AntigravityProcessOptions;
  private readonly stderrChunks: string[] = [];
  private lineReader: readline.Interface | null = null;
  private listenerCleanups: ProcessListenerCleanup[] = [];
  private exited = false;

  // Emitted: "init" (AgyInitEvent), "step" (AgyStepEvent), "result" (AgyResultEvent),
  // "exit" (code/-signal), "error" (spawn or protocol errors).
  constructor(options: AntigravityProcessOptions = {}) {
    super();
    this.options = options;
  }

  spawn(): void {
    const { command, args } = createAgySpawnCommand(this.options);
    const cwd = this.options.cwd ? expandHome(this.options.cwd) : expandHome(config.antigravity.workspaceDir);

    logger.debug(`[AgyProcess] Spawning ${command} ${args.join(" ")} (cwd=${cwd})`);

    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.on("error", (error) => {
      logger.error("[AgyProcess] Process error", error);
      this.emit("error", error);
    });

    this.trackExit(child);

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderrChunks.push(chunk);
        if (this.stderrChunks.length > 200) {
          this.stderrChunks.splice(0, this.stderrChunks.length - 200);
        }
      });
    }

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      const rl = readline.createInterface({ input: child.stdout });
      this.lineReader = rl;
      rl.on("line", (line: string) => {
        this.handleLine(line);
      });
    }
  }

  private trackExit(child: ChildProcess): void {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      this.exited = true;
      this.cleanupListeners();
      this.lineReader?.close();
      this.lineReader = null;
      this.emit("exit", { code, signal });
    };
    child.once("exit", onExit);
    this.listenerCleanups.push(() => child.removeListener("exit", onExit));
  }

  private handleLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return;
    }

    // stdout may carry non-JSON lines (banners, warnings). Discard them.
    if (!trimmed.startsWith("{")) {
      logger.debug(`[AgyProcess] Discarding non-JSON stdout line: ${trimmed.slice(0, 120)}`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      logger.debug(`[AgyProcess] Discarding unparseable stdout line: ${trimmed.slice(0, 120)}`);
      return;
    }

    const event = mapRawMessage(parsed);
    if (!event) {
      return;
    }

    this.emit(event.kind, event);
  }

  isRunning(): boolean {
    return this.child !== null && !this.exited && this.child.exitCode === null && this.child.signalCode === null;
  }

  getStderrTail(): string {
    return this.stderrChunks.join("").trim();
  }

  async sendPrompt(text: string): Promise<void> {
    const child = this.child;
    if (!child || !child.stdin || !child.stdin.writable) {
      throw new Error("Antigravity process is not running");
    }

    const input = `${JSON.stringify({
      event: "user",
      message: { content: text },
    })}\n`;

    await new Promise<void>((resolve, reject) => {
      child.stdin!.write(input, (error) => {
        if (error) {
          reject(error);
          return;
        }
        // Keep the pipe OPEN: agy runs one turn per stream-json user event,
        // and a follow-up prompt (hot takeover) must be writable into the
        // SAME process. Closing stdin here kills follow-ups.
        resolve();
      });
    });
  }

  async kill(): Promise<void> {
    const child = this.child;
    if (!child || !this.isRunning()) {
      return;
    }

    const pid = child.pid as number;
    if (pid === undefined) {
      return;
    }

    const terminate = new Promise<void>((resolve) => {
      const onGone = (): void => resolve();
      child.once("exit", onGone);
      setTimeout(() => {
        child.removeListener("exit", onGone);
        if (this.isRunning()) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Process already gone.
            }
          }
        }
        resolve();
      }, KILL_ESCALATION_MS);
    });

    try {
      process.kill(-pid, "SIGINT");
    } catch {
      try {
        child.kill("SIGINT");
      } catch {
        // Already dead.
      }
    }

    await terminate;
  }

  private cleanupListeners(): void {
    for (const cleanup of this.listenerCleanups.splice(0)) {
      cleanup();
    }
    this.child = null;
    this.lineReader = null;
  }
}

type RawAgyMessage = {
  event?: unknown;
  conversation_id?: unknown;
  init?: unknown;
  step_update?: unknown;
  result?: unknown;
};

// Pure mapping, exported for tests.
export function mapRawMessage(message: unknown): AgyEvent | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }

  const raw = message as RawAgyMessage;

  if (raw.event === "init" && typeof raw.conversation_id === "string" && isRecord(raw.init)) {
    const init = raw.init as { cwd?: unknown; tools?: unknown; permission_mode?: unknown };
    return {
      kind: "init",
      conversationId: raw.conversation_id,
      ...(typeof init.cwd === "string" ? { cwd: init.cwd } : {}),
      ...(Array.isArray(init.tools) ? { tools: init.tools.filter((t): t is string => typeof t === "string") } : {}),
      ...(typeof init.permission_mode === "string" ? { permissionMode: init.permission_mode } : {}),
    };
  }

  if (raw.event === "step_update" && isRecord(raw.step_update)) {
    const step = raw.step_update as {
      step_index?: unknown;
      state?: unknown;
      step_type?: unknown;
      text_delta?: unknown;
      tool_name?: unknown;
      tool_info?: unknown;
      subagent_info?: unknown;
      usage?: unknown;
    };
    if (step.state !== "ACTIVE" && step.state !== "DONE" && step.state !== "ERROR") {
      return null;
    }
    const validStepType =
      step.step_type === "user_input" || step.step_type === "agent_response" || step.step_type === "tool"
        ? step.step_type
        : undefined;
    const stepEvent: AgyStepEvent = {
      kind: "step",
      stepIndex: typeof step.step_index === "number" ? step.step_index : 0,
      state: step.state,
      ...(validStepType ? { stepType: validStepType } : {}),
      ...(typeof step.text_delta === "string" ? { textDelta: step.text_delta } : {}),
      ...(typeof step.tool_name === "string" ? { toolName: step.tool_name } : {}),
      ...(isRecord(step.tool_info) ? { toolInfo: step.tool_info as AgyStepEvent["toolInfo"] } : {}),
      ...(isRecord(step.subagent_info)
        ? { subagentInfo: step.subagent_info as AgyStepEvent["subagentInfo"] }
        : {}),
      ...(isRecord(step.usage) ? { usage: step.usage as AgyUsage } : {}),
    };
    return stepEvent;
  }

  if (raw.event === "result" && isRecord(raw.result)) {
    const result = raw.result as {
      status?: unknown;
      response?: unknown;
      error?: unknown;
      duration_seconds?: unknown;
      num_turns?: unknown;
      usage?: unknown;
      denied_actions?: unknown;
    };
    if (result.status !== "SUCCESS" && result.status !== "ERROR") {
      return null;
    }
    const resultEvent: AgyResultEvent = {
      kind: "result",
      status: result.status,
      ...(typeof result.response === "string" ? { response: result.response } : {}),
      ...(typeof result.error === "string" && result.error ? { error: result.error } : {}),
      ...(typeof result.duration_seconds === "number" ? { durationSeconds: result.duration_seconds } : {}),
      ...(typeof result.num_turns === "number" ? { numTurns: result.num_turns } : {}),
      ...(isRecord(result.usage) ? { usage: result.usage as AgyUsage } : {}),
      ...(result.denied_actions !== undefined ? { deniedActions: result.denied_actions } : {}),
    };
    return resultEvent;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
