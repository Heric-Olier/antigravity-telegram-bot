import type { Api } from "grammy";

/**
 * Shared typing-indicator heartbeats.
 *
 * Used by: (a) the prompt handler right after writing the prompt into agy's
 * pipe — so "typing" lights up from message receipt (Hermes/opencode UX), and
 * (b) the event subscription service when streaming text arrives.
 *
 * PRUNING: every entry carries a lastSeen stamp; a sweep prunes intervals that
 * were never re-armed by a live run (retry-orphans previously leaked a 5s
 * heartbeat forever, keeping "typing…" visible with nothing working).
 */
const heartbeats = new Map<string, ReturnType<typeof setInterval>>();
const lastSeen = new Map<string, number>();
/** Hard TTL: a heartbeat older than this is reaped even if nothing said stop. */
const STALE_AFTER_MS = 10 * 60_000;

export function startTypingIndicator(api: Api, chatId: number, sessionId: string): void {
  if (typeof api.sendChatAction !== "function") return;
  const existing = heartbeats.get(sessionId);
  if (existing) {
    lastSeen.set(sessionId, Date.now());
    return;
  }
  lastSeen.set(sessionId, Date.now());
  heartbeats.set(
    sessionId,
    setInterval(() => {
      const stamp = lastSeen.get(sessionId) ?? Date.now();
      if (Date.now() - stamp > STALE_AFTER_MS) {
        // Orphaned heartbeat: nothing refreshed it for 10 minutes — stop it.
        stopTypingIndicator(sessionId);
        return;
      }
      void api.sendChatAction(chatId, "typing").catch(() => undefined);
    }, 5_000),
  );
  void api.sendChatAction(chatId, "typing").catch(() => undefined);
}

/** Refreshes the staleness stamp of a live heartbeat (call from stream hooks). */
export function touchTypingIndicator(sessionId: string): void {
  if (heartbeats.has(sessionId)) {
    lastSeen.set(sessionId, Date.now());
  }
}

export function stopTypingIndicator(sessionId: string): void {
  const h = heartbeats.get(sessionId);
  if (h) {
    clearInterval(h);
    heartbeats.delete(sessionId);
    lastSeen.delete(sessionId);
  }
}
