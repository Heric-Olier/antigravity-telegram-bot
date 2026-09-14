import type { Api } from "grammy";

/**
 * Shared typing-indicator heartbeats.
 *
 * Used by: (a) the prompt handler right after writing the prompt into agy's
 * pipe — so "typing" lights up from message receipt (Hermes/opencode UX), and
 * (b) the event subscription service when streaming text arrives.
 */
const heartbeats = new Map<string, ReturnType<typeof setInterval>>();

export function startTypingIndicator(api: Api, chatId: number, sessionId: string): void {
  if (heartbeats.has(sessionId)) return;
  heartbeats.set(
    sessionId,
    setInterval(() => {
      void api.sendChatAction(chatId, "typing").catch(() => undefined);
    }, 5_000),
  );
  void api.sendChatAction(chatId, "typing").catch(() => undefined);
}

export function stopTypingIndicator(sessionId: string): void {
  const h = heartbeats.get(sessionId);
  if (h) {
    clearInterval(h);
    heartbeats.delete(sessionId);
  }
}
