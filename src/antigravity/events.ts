import os from "node:os";
import path from "node:path";
import type { Event, ToolPart, ToolState } from "@opencode-ai/sdk/v2";
import { noteStepUsage } from "../app/services/context-usage-tracker.js";
import {
  AntigravityProcess,
  type AgyInitEvent,
  type AgyStepEvent,
  type AgyResultEvent,
  type AntigravityProcessOptions,
} from "./agent-process.js";
import { config } from "../config.js";
import { getCurrentSession, promotePlaceholderSession, syncSessionToRuntimeId } from "../app/services/session-service.js";
import { getConversationTitle } from "./session-store.js";
import { getStoredModel } from "../app/services/model-selection-service.js";
import { logger } from "../utils/logger.js";
import { isRecord } from "../utils/type-guards.js";

/** Maximum transparent retries for transient provider-side failures. */
const CAPACITY_RETRY_MAX = 3;
/** How many capacity-503 retries have been consumed for the current prompt. */
let retryAttempt = 0;
/** Set when a turn is intentionally killed (/restart); swallows the stale
 * ERROR result that surfaces afterward. */
let suppressNextTurnError = false;
/** Last user prompt + directory, kept so transient failures can resend. */
let lastPromptText: string | null = null;
let lastPromptDirectory: string | null = null;

/** Transient provider errors worth a transparent resend (not user faults). */
function isTransientCapacityError(message: string): boolean {
  return /UNAVAILABLE|RESOURCE_EXHAUSTED|No capacity available|Deadline|deadline exceeded|internal error|Internal/i.test(
    message,
  );
}

// Adapter: drives an AntigravityProcess and translates the raw agy stream-json
// protocol into the opencode-shaped Event stream the bot already consumes
// (`src/bot/services/event-subscription-service.ts` switch + summary aggregator).
//
// Mapping (per live NDJSON line -> bot event):
//   init                -> session.created (properties.info.id = agy session id)
//   step agent_response -> message.part.updated (part.type=text, text=delta; properties.delta too)
//   tool ACTIVE         -> message.part.updated (part.type=tool, state.status=running)
//   tool DONE           -> message.part.updated (part.type=tool, state.status=completed)
//   tool ERROR          -> message.part.updated (part.type=tool, state.status=error + error message)
//   result SUCCESS      -> message.updated (completed assistant msg) + session.idle
//   result ERROR        -> session.error (+ session.idle so foreground state clears)
//
// Exposes the same module contract as `src/opencode/events.ts`:
//   subscribeToEvents(directory, callback) / stopEventListening()

type EventCallback = (event: Event) => void;

let activeProcess: AntigravityProcess | null = null;
let activeDirectory: string | null = null;
let eventCallback: EventCallback | null = null;

// Stable per-run ids. agy has one turn per process run, so a single session id
// and a small counter for parts is enough.
let currentSessionId = "";
let nextPartCounter = 0;

function shortId(prefix: string, suffix: number | string): string {
  return `agy-${prefix}-${suffix}`;
}

function nextPartId(): string {
  return shortId("part", nextPartCounter++);
}

function emitBotEvent(type: string, properties: Record<string, unknown>): void {
  const callback = eventCallback;
  if (!callback) {
    return;
  }

  const event = { type, properties } as unknown as Event;
  try {
    callback(event);
  } catch (error) {
    logger.error("[AgyEvents] Callback failed:", error);
  }
}

function handleInit(event: AgyInitEvent): void {
  currentSessionId = shortId("session", event.conversationId || String(Date.now()));
  // Follow the runtime: promote the /new placeholder AND realign a stale
  // stored id whenever the spawned conversation differs, so foreground
  // event matching works and /sessions lists the live thread.
  const realTitle = event.conversationId
    ? getConversationTitle(event.conversationId)
    : undefined;
  promotePlaceholderSession(currentSessionId, realTitle);
  syncSessionToRuntimeId(currentSessionId, realTitle);

  emitBotEvent("session.created", {
    sessionID: currentSessionId,
    info: {
      id: currentSessionId,
      title: event.conversationId,
      directory: activeDirectory ?? "",
      time: { created: Date.now(), updated: Date.now() },
      version: "agy",
      slug: event.conversationId,
      projectID: "antigravity",
    },
  });
}

function toolPartFromStep(step: AgyStepEvent): ToolPart {
  const input = (step.toolInfo?.parameters ?? {}) as Record<string, unknown>;
  const now = Date.now();
  const subagents = step.subagentInfo?.subagents ?? [];
  const subagentSuffix =
    subagents.length > 0
      ? ` (${subagents.length} subagente${subagents.length === 1 ? "" : "s"}: ${subagents
          .map((s) => s.role || s.type_name || "?")
          .slice(0, 4)
          .join(", ")}${subagents.length > 4 ? ", …" : ""})`
      : "";
  const toolName = `${step.toolName ?? step.toolInfo?.name ?? "tool"}${subagentSuffix}`;
  const messageId = shortId("msg", 0);

  let state: ToolState;
  if (step.state === "ERROR") {
    state = {
      status: "error",
      input,
      error: step.toolInfo?.error ?? "Unknown tool error",
      time: { start: now, end: now },
    };
  } else if (step.state === "DONE") {
    state = {
      status: "completed",
      input,
      output: step.toolInfo?.error ?? "",
      title: toolName,
      metadata: {},
      time: { start: now, end: now },
    };
  } else {
    state = { status: "running", input, time: { start: now } };
  }

  return {
    id: nextPartId(),
    sessionID: currentSessionId,
    messageID: messageId,
    type: "tool",
    callID: shortId("call", step.stepIndex),
    tool: toolName,
    state,
  };
}

function textPartUpdated(text: string): { part: Record<string, unknown> } {
  return {
    part: {
      id: nextPartId(),
      sessionID: currentSessionId,
      messageID: shortId("msg", 0),
      type: "text",
      text,
    },
  };
}

// ── Step-stall watchdog ──────────────────────────────────────────────────────
// Google's backend sometimes dribbles or parks a model step for many minutes
// (same saturation that produces 503s). The user can't distinguish "working"
// from "hung", so track the last step timestamp and surface an explicit idle
// notice once the pause exceeds a threshold. Cleared on the next step and on
// turn end. Purely informational — it never kills the process.
const STEP_STALL_THRESHOLD_MS = 8 * 60_000;
let lastStepAt = 0;
let stallNotified = false;
let stallTimer: NodeJS.Timeout | null = null;

function noteStepActivity(_event: AgyStepEvent): void {
  lastStepAt = Date.now();
  if (stallNotified) {
    stallNotified = false;
    emitBotEvent("message.updated", {
      info: {
        id: shortId("msg", 0),
        sessionID: currentSessionId,
        role: "assistant",
        stallCleared: true,
        // Marked completed so consumers that treat message.updated as an
        // active-run marker (shouldMarkAttachedBusyFromEvent) ignore it.
        time: { updated: Date.now(), completed: Date.now() },
      },
    });
  }
}

function startStallWatchdog(): void {
  if (stallTimer) {
    return;
  }
  stallTimer = setInterval(() => {
    if (stallNotified || !lastStepAt) {
      return;
    }
    if (Date.now() - lastStepAt >= STEP_STALL_THRESHOLD_MS) {
      stallNotified = true;
      const minutes = Math.round((Date.now() - lastStepAt) / 60_000);
      logger.warn(`[AgyEvents] turn stalled: no step activity for ${minutes}m`);
      // Notice only: marked completed so the busy-latch matcher
      // (assistant && !completed) does NOT treat this as a running turn.
      // Without completed, every stalled turn kept re-latching the attach
      // session busy after the turn ended, and queued messages never drained.
      emitBotEvent("message.updated", {
        info: {
          id: shortId("msg", 0),
          sessionID: currentSessionId,
          role: "assistant",
          stallMinutes: minutes,
          time: { updated: Date.now(), completed: Date.now() },
        },
      });
    }
  }, 60_000);
}

// One step_update maps to one bot event. The user_input echo is ignored.
function handleStep(event: AgyStepEvent): void {
  if (event.stepType === "user_input") {
    return;
  }
  noteStepActivity(event);

  // Track real context size for the keyboard's context button (agy usage).
  noteStepUsage(event.usage as Parameters<typeof noteStepUsage>[0]);

  if (event.stepType === "agent_response" && typeof event.textDelta === "string") {
    const { part } = textPartUpdated(event.textDelta);
    // The aggregator's streaming path reads properties.delta first
    // (message.part.updated with a delta applies it incrementally).
    emitBotEvent("message.part.updated", {
      sessionID: currentSessionId,
      time: Date.now(),
      part,
      delta: event.textDelta,
    });
    return;
  }

  if (event.stepType === "tool") {
    const part = toolPartFromStep(event);
    emitBotEvent("message.part.updated", {
      sessionID: currentSessionId,
      time: Date.now(),
      part,
    });
    return;
  }
  logger.debug(`[AgyEvents] Unhandled step update: ${JSON.stringify(event).slice(0, 200)}`);
}

function handleResult(event: AgyResultEvent): void {
  logger.info(
    `[AgyEvents] result: status=${event.status} turns=${event.numTurns ?? "?"} respLen=${(event.response ?? "").length}`,
  );
  // agy writes the human-readable title into conversation_summaries.db after a
  // turn; refresh the stored session title so the pinned dashboard shows the
  // real name instead of the short-id fallback on the next render.
  if (currentSessionId && event.status === "SUCCESS") {
    const title = getConversationTitle(currentSessionId.slice("agy-session-".length));
    if (title && !title.startsWith("Conversation ")) {
      syncSessionToRuntimeId(currentSessionId, title);
    }
  }
  const finalText = typeof event.response === "string" ? event.response : "";
  const messageId = shortId("msg", 0);
  const now = Date.now();

  // Ready-to-render final text snapshot.
  emitBotEvent("message.part.updated", {
    sessionID: currentSessionId,
    time: now,
    part: {
      id: nextPartId(),
      sessionID: currentSessionId,
      messageID: messageId,
      type: "text",
      text: finalText,
    },
  });

  if (event.status === "ERROR") {
    // Prefer the real error text from the envelope's `error` field; the
    // `response` may still carry the nicety text agy emitted before failing.
    const errorMessage = event.error || finalText || "Unknown agy error";
    const stderrTail = lastProcess?.getStderrTail() ?? "";
    logger.error(
      `[AgyEvents] turn failed: ${errorMessage}` +
        (stderrTail ? `\nstderr tail:\n${stderrTail.slice(-800)}` : ""),
    );
    // Transient provider-side failures (capacity 503, RESOURCE_EXHAUSTED,
    // deadline) are retried transparently with backoff rather than surfacing
    // an error the user can't act on. agy keeps the conversation state, so a
    // fresh process re-attaches via --conversation and can continue.
    const suppressed = suppressNextTurnError;
    suppressNextTurnError = false;
    if (suppressed) {
      // Intentional interrupt (e.g. /restart): the error is an artifact of
      // the kill, not a real turn failure — stay silent.
      logger.warn("[AgyEvents] suppressing turn error after intentional interrupt");
      return;
    }
    if (!suppressNextTurnError && isTransientCapacityError(errorMessage) && lastPromptText) {
      const attempt = (retryAttempt = retryAttempt + 1);
      if (attempt <= CAPACITY_RETRY_MAX) {
        const delayMs = Math.min(50_000, 5_000 * 2 ** (attempt - 1));
        logger.warn(
          `[AgyEvents] transient server error (attempt ${attempt}/${CAPACITY_RETRY_MAX}); resending prompt in ${delayMs}ms`,
        );
        setTimeout(() => {
          activeProcess = null;
          if (lastPromptDirectory) {
            const proc = spawnProcessForDirectory(lastPromptDirectory, {});
            void proc;
          }
          void sendPromptToActiveProcess(lastPromptText as string, lastPromptDirectory as string);
        }, delayMs);
        return;
      }
      retryAttempt = 0;
    } else {
      retryAttempt = 0;
    }
    emitBotEvent("session.error", {
      sessionID: currentSessionId,
      error: { name: "AntigravityError", message: errorMessage },
    });
  } else {
    // Completed assistant message lets consumers that finish on
    // message.updated (time.completed) deliver the reply.
    emitBotEvent("message.updated", {
      info: {
        id: messageId,
        sessionID: currentSessionId,
        role: "assistant",
        time: { created: now, completed: now },
        parentID: shortId("usermsg", 0),
        modelID: "agy",
        providerID: "antigravity",
        mode: "default",
        agent: "antigravity",
        path: { cwd: "", root: "" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
  }

  // Turn is over either way — release the foreground/typing state.
  emitBotEvent("session.idle", { sessionID: currentSessionId });
}

let lastProcess: AntigravityProcess | null = null;

function wireProcess(proc: AntigravityProcess): void {
  lastProcess = proc;
  startStallWatchdog();
  proc.on("init", (event: AgyInitEvent) => {
    handleInit(event);
  });
  proc.on("step", (event: AgyStepEvent) => {
    handleStep(event);
  });
  proc.on("result", (event: AgyResultEvent) => {
    handleResult(event);
  });
  proc.on("exit", ({ code, signal }) => {
    logger.info(`[AgyEvents] agy process exited (code=${code}, signal=${signal})`);
    if (activeProcess === proc) {
      activeProcess = null;
    }
    if (currentSessionId && eventCallback) {
      emitBotEvent("session.idle", { sessionID: currentSessionId });
    }
  });
  proc.on("error", (error) => {
    logger.error("[AgyEvents] Antigravity process error", error);
  });
}

function expandAntigravityWorkspace(): string {
  const value = config.antigravity.workspaceDir;
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function spawnProcessForDirectory(
  directory: string,
  spawnOptions: AntigravityProcessOptions = {},
): AntigravityProcess {
  if (!eventCallback) {
    throw new Error("Cannot spawn agy without an event callback");
  }

  const effectiveDirectory = directory || expandAntigravityWorkspace();
  const proc = new AntigravityProcess({ cwd: effectiveDirectory, ...spawnOptions });
  wireProcess(proc);
  activeProcess = proc;
  activeDirectory = effectiveDirectory;
  proc.spawn();
  return proc;
}

export async function subscribeToEvents(
  directory: string,
  callback: EventCallback,
  spawnOptions: AntigravityProcessOptions = {},
): Promise<void> {
  if (activeProcess && activeDirectory === directory) {
    // Same project directory: just re-bind the callback.
    eventCallback = callback;
    return;
  }

  stopEventListening();
  activeDirectory = directory;
  eventCallback = callback;
  // A boot-time subscribe without an explicit conversation would make agy
  // open a brand-new (empty) conversation — the source of the "phantom new
  // session" pins and the stray conversation DBs. When the bot has a saved
  // agy session, attach to it instead of starting fresh.
  const savedId =
    spawnOptions.conversationId ??
    getCurrentSession()?.id.replace(/^agy-session-/, "") ??
    undefined;
  const merged: AntigravityProcessOptions = savedId
    ? { ...spawnOptions, conversationId: savedId }
    : spawnOptions;
  // Boot-time respawn must also honor the selected model.
  if (!merged.model) {
    const stored = getStoredModel();
    if (stored?.modelID) merged.model = stored.modelID;
  }
  spawnProcessForDirectory(directory, merged);
}

export function stopEventListening(): void {
  if (activeProcess) {
    void activeProcess.kill().catch(() => undefined);
    activeProcess = null;
  }
  activeDirectory = null;
  eventCallback = null;
  currentSessionId = "";
  nextPartCounter = 0;
}

/**
 * Interrupt the current agy turn (SIGINT the running process) while KEEPING
 * the event subscription alive — the next prompt can reuse the same pipeline
 * without re-attaching. This is what /abort uses: it should stop the agent,
 * not tear down the bot's ability to send the next prompt.
 */
export async function interruptActiveTurn(): Promise<void> {
  const proc = activeProcess;
  if (proc) {
    activeProcess = null;
    // The interrupted turn's eventual ERROR result (e.g. a stale 503
    // envelope) is an artifact of the intentional kill — swallow it instead
    // of surfacing it to the user right after a /restart.
    suppressNextTurnError = true;
    await proc.kill().catch(() => undefined);
    if (currentSessionId && eventCallback) {
      // Surface the turn end so foreground/attached busy states flip.
      emitBotEvent("session.idle", { sessionID: currentSessionId });
    }
    nextPartCounter = 0;
  }
}

export function __resetAgyEventsForTests(): void {
  stopEventListening();
}

/**
 * Send a prompt to the currently-running agy process.
 * Falls back to starting a fresh process (with the active conversation/model)
 * when no process is alive yet, which is the normal "first prompt after
 * /new or app start" path.
 */
export async function sendPromptToActiveProcess(text: string, directory: string): Promise<void> {
  lastPromptText = text;
  lastPromptDirectory = directory;
  if (activeProcess && activeProcess.isRunning()) {
    await activeProcess.sendPrompt(text);
    return;
  }

  if (!eventCallback) {
    throw new Error("Cannot send a prompt without an active event subscription");
  }

  // Resume the current conversation when the foreground session is a real
  // agy conversation (`agy-session-<uuid>`); a fresh spawn would otherwise
  // start a new conversation every turn.
  const spawnOptions: AntigravityProcessOptions = {};
  const current = getCurrentSession();
  if (current?.id.startsWith("agy-session-")) {
    spawnOptions.conversationId = current.id.slice("agy-session-".length);
  }
  // Pass the user-selected model so agy runs with it (otherwise agy falls
  // back to its own stored model, which may mismatch the bot’s footer).
  const stored = getStoredModel();
  if (stored?.modelID) {
    spawnOptions.model = stored.modelID;
  }
  const proc = spawnProcessForDirectory(directory, spawnOptions);
  await proc.sendPrompt(text);
}

export { isRecord };
export type { AgyInitEvent, AgyStepEvent, AgyResultEvent };
