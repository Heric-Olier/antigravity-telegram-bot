import { foregroundSessionState, type ForegroundBusySession } from "../managers/foreground-session-state-manager.js";
import { attachManager } from "../managers/attach-manager.js";
import { logger } from "../../utils/logger.js";

const RECONCILE_MIN_INTERVAL_MS = 10_000;

const inFlightDirectories = new Set<string>();
const lastReconcileAtByDirectory = new Map<string, number>();
let reconciliationStreamer: { hasActiveStream(sessionId: string): boolean } | null = null;

export function setResponseStreamerForReconciliation(
  streamer: { hasActiveStream(sessionId: string): boolean },
): void {
  // agy has no external busy registry; the reconciler is a no-op, but the
  // streamer reference is kept for diagnostics/parity with the opencode build.
  reconciliationStreamer = streamer;
}

export function setPromptResponseModeClearerForReconciliation(
  _clearer: (sessionId: string) => void,
): void {
  // Kept for test/call-site compatibility; the agy reconciler is a no-op.
}

function getReconciliationTargets(directory: string): {
  foregroundBusySessions: ForegroundBusySession[];
  attachedSessionForDirectory: ReturnType<typeof attachManager.getSnapshot>;
} {
  const foregroundBusySessions = foregroundSessionState
    .getBusySessions()
    .filter((session) => session.directory === directory);
  const attachedSession = attachManager.getSnapshot();
  const attachedSessionForDirectory =
    attachedSession?.directory === directory ? attachedSession : null;

  return { foregroundBusySessions, attachedSessionForDirectory };
}

export async function reconcileBusyStateNow(directory: string): Promise<void> {
  if (!directory) {
    return;
  }

  const { foregroundBusySessions, attachedSessionForDirectory } =
    getReconciliationTargets(directory);

  if (foregroundBusySessions.length === 0 && !attachedSessionForDirectory) {
    return;
  }

  // agy has no external busy registry: the antigravity events adapter emits
  // session.idle / session.error at the end of every turn, which flips the
  // foreground/attached state directly. There is nothing to poll here, so the
  // reconciler is a no-op that only verifies there was something to reconcile.
  if (reconciliationStreamer && foregroundBusySessions.length > 0) {
    const stillStreaming = foregroundBusySessions.filter((s) => reconciliationStreamer!.hasActiveStream(s.sessionId));
    logger.debug(`[BusyReconciliation] Active streams: ${stillStreaming.length}`);
  }
  logger.debug(`[BusyReconciliation] Foreground busy states kept as-is for ${directory}`);
}

/**
 * Rate-limited wrapper kept so the event-subscription-service call sites stay intact.
 */
export async function reconcileBusyState(directory: string, now: number = Date.now()): Promise<void> {
  if (!directory || inFlightDirectories.has(directory)) {
    return;
  }

  const { foregroundBusySessions, attachedSessionForDirectory } =
    getReconciliationTargets(directory);
  if (foregroundBusySessions.length === 0 && !attachedSessionForDirectory) {
    return;
  }

  const lastReconcileAt = lastReconcileAtByDirectory.get(directory);
  if (lastReconcileAt !== undefined && now - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) {
    return;
  }

  lastReconcileAtByDirectory.set(directory, now);
  inFlightDirectories.add(directory);

  try {
    await reconcileBusyStateNow(directory);
  } catch (error) {
    logger.warn("[BusyReconciliation] Failed to reconcile busy state", error);
  } finally {
    inFlightDirectories.delete(directory);
  }
}

export function __resetBusyReconciliationForTests(): void {
  inFlightDirectories.clear();
  lastReconcileAtByDirectory.clear();
}
