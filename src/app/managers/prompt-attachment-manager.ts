import { logger } from "../../utils/logger.js";

export interface PendingAttachment {
  absolutePath: string;
  worktree: string;
  /** Confirmation message carrying the cancel button, so it can be retired once consumed. */
  confirmationMessageId?: number;
}

/**
 * Prompt Attachment - holds the single file picked in /ls until the next prompt consumes it.
 * Kept in memory only: a file chosen before a restart must not resurface in a new context.
 * Singleton pattern
 */
class PromptAttachmentManager {
  private state: PendingAttachment | null = null;

  set(absolutePath: string, worktree: string): void {
    this.state = { absolutePath, worktree };
    logger.info(`[PromptAttachment] Attached file: path=${absolutePath}, worktree=${worktree}`);
  }

  setConfirmationMessageId(messageId: number): void {
    if (!this.state) {
      return;
    }

    this.state.confirmationMessageId = messageId;
  }

  get(): PendingAttachment | null {
    return this.state ? { ...this.state } : null;
  }

  clear(reason: string): void {
    if (!this.state) {
      return;
    }

    logger.info(
      `[PromptAttachment] Cleared attachment: reason=${reason}, path=${this.state.absolutePath}`,
    );
    this.state = null;
  }

  __resetForTests(): void {
    this.state = null;
  }
}

export const promptAttachment = new PromptAttachmentManager();
