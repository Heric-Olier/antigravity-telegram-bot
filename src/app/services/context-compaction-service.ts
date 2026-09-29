/**
 * Context compaction (Capa 9): hand the conversation context over to a fresh
 * conversation once it grows past the configured threshold — the local
 * equivalent of Antigravity Desktop's server-side auto-compaction, which the
 * CLI does not trigger in headless stream-json mode.
 *
 * Flow: ask the agent for a handoff summary in the OLD conversation, capture
 * that completion, then start a fresh conversation (mirrors /new) and seed it
 * with the summary so work continues seamlessly.
 */
import { getAutoCompactEnabled, getAutoCompactThresholdTokens } from "../stores/settings-store.js";

export type CompactionStartReason = "auto" | "manual" | "error";

let awaitingSummary = false;
let awaitingSummarySessionId: string | null = null;
let pendingHandoff: { summary: string; sourceSessionId: string } | null = null;
const autoCompactedSessions = new Set<string>();

let requester: ((reason: CompactionStartReason) => Promise<void>) | null = null;

/** The bot layer registers the real implementation (EventSubscriptionService). */
export function setCompactionRequester(
  fn: ((reason: CompactionStartReason) => Promise<void>) | null,
): void {
  requester = fn;
}

export async function requestCompaction(reason: CompactionStartReason): Promise<void> {
  await requester?.(reason);
}

export function markAwaitingSummary(sessionId: string): void {
  awaitingSummary = true;
  awaitingSummarySessionId = sessionId;
}

export function isAwaitingSummary(): boolean {
  return awaitingSummary;
}

export function clearAwaitingSummary(): void {
  awaitingSummary = false;
  awaitingSummarySessionId = null;
}

/**
 * Captures the handoff summary from the completion that follows the summary
 * request. Returns true exactly once per request.
 */
export function captureCompactionSummary(sessionId: string, text: string): boolean {
  if (!awaitingSummary || sessionId !== awaitingSummarySessionId) {
    return false;
  }

  awaitingSummary = false;
  awaitingSummarySessionId = null;
  const summary = text.trim();
  if (summary.length === 0) {
    return false;
  }

  pendingHandoff = { summary, sourceSessionId: sessionId };
  return true;
}

export function getPendingHandoff(): { summary: string; sourceSessionId: string } | null {
  return pendingHandoff;
}

export function clearPendingHandoff(): void {
  pendingHandoff = null;
}

/** One auto-compaction per conversation: never loop on the same session. */
export function shouldAutoCompactNow(sessionId: string, usedTokens: number): boolean {
  if (!getAutoCompactEnabled()) {
    return false;
  }
  if (autoCompactedSessions.has(sessionId)) {
    return false;
  }
  if (usedTokens < getAutoCompactThresholdTokens()) {
    return false;
  }
  autoCompactedSessions.add(sessionId);
  return true;
}

export function buildCompactionSummaryPrompt(): string {
  return (
    "\ud83e\uddf9 Compactaci\u00f3n de contexto: escribe un resumen de traspaso CONCISO " +
    "(m\u00e1ximo ~300 palabras) para continuar esta tarea en una conversaci\u00f3n nueva. " +
    "Incluye: (1) objetivo/tarea actual, (2) estado y archivos tocados (rutas completas), " +
    "(3) decisiones clave tomadas, (4) pendientes / pr\u00f3ximos pasos. " +
    "Responde SOLO con el resumen, sin pre\u00e1mbulos."
  );
}

export function buildCompactionSeedPrompt(summary: string): string {
  return (
    "\ud83e\udde0 CONTEXTO DE CONTINUIDAD \u2014 la conversaci\u00f3n anterior fue compactada " +
    "autom\u00e1ticamente. Resumen de traspaso:\n\n\u00ab" +
    summary +
    "\u00bb\n\nRevisa los archivos que necesites y confirma en UNA l\u00ednea que tienes el " +
    "contexto listo para continuar."
  );
}

export function __resetContextCompactionForTests(): void {
  awaitingSummary = false;
  awaitingSummarySessionId = null;
  pendingHandoff = null;
  autoCompactedSessions.clear();
  requester = null;
}
