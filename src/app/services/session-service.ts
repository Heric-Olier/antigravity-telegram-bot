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
