import {
  getCurrentSession as getSettingsSession,
  setCurrentSession as setSettingsSession,
  clearSession as clearSettingsSession,
} from "../stores/settings-store.js";
import { promptQueue } from "../managers/prompt-queue-manager.js";
import { promptAttachment } from "../managers/prompt-attachment-manager.js";
import type { SessionInfo } from "../types/session.js";

export type { SessionInfo };

export function setCurrentSession(sessionInfo: SessionInfo): void {
  // Renaming reuses this setter with the same id, so only an actual session
  // switch may drop prompts queued for the previous session.
  if (getSettingsSession()?.id !== sessionInfo.id) {
    promptQueue.clear("session_switched");
    promptAttachment.clear("session_switched");
  }

  setSettingsSession(sessionInfo);
}

export function getCurrentSession(): SessionInfo | null {
  return getSettingsSession() ?? null;
}

export function clearSession(): void {
  promptQueue.clear("session_cleared");
  promptAttachment.clear("session_cleared");
  clearSettingsSession();
}

/**
 * Replace a placeholder session id (`new-<ts>` created by /new) with the real
 * agy conversation id once the runtime reports it, so foreground event
 * matching (summaryAggregator / attach state) works from the first turn.
 */
export function promotePlaceholderSession(realId: string, title?: string): void {
  const current = getSettingsSession();
  if (!current || !current.id.startsWith("new-")) {
    return;
  }
  setSettingsSession({
    ...current,
    id: realId,
    title: title && title.trim().length > 0 ? title : current.title,
  });
}

/**
 * Follow the runtime truth: when the spawned agy conversation id differs from
 * the stored session id (e.g. a fresh spawn created a new conversation, or the
 * user resumed another thread in the TUI), realign the stored session so
 * foreground event matching and /sessions stay consistent.
 */
export function syncSessionToRuntimeId(realId: string, title?: string): void {
  const current = getSettingsSession();
  if (!current || current.id === realId) {
    return;
  }
  setSettingsSession({
    ...current,
    id: realId,
    title: title && title.trim().length > 0 ? title : current.title,
  });
}
