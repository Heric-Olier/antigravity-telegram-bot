import type { Api } from "grammy";
import { createMainKeyboard } from "./main-reply-keyboard.js";
import { fetchQuotaSnapshot, getCachedQuotaBadge } from "../../app/services/quota-service.js";
import { getContextUsed, getContextLimit } from "../../app/services/context-usage-tracker.js";
import { getQueuedPromptButtonLabels } from "./queued-prompt-button.js";
import { getStoredAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import type { ModelInfo } from "../../app/types/model.js";
import { logger } from "../../utils/logger.js";
import type { ContextInfo, KeyboardState } from "./keyboard-types.js";

/**
 * Keyboard Manager - manages Reply Keyboard state and updates
 * Singleton pattern
 */
class KeyboardManager {
  private lastKeyboardText: string | null = null;
  private lastBadge: string = "";
  private state: KeyboardState | null = null;

  private api: Api | null = null;
  private chatId: number | null = null;
  private lastUpdateTime: number = 0;
  private readonly UPDATE_DEBOUNCE_MS = 2000; // Don't update more than once per 2 seconds

  /**
   * Initialize the keyboard manager with Telegram API and chat ID
   * Loads initial state from settings/config
   */
  private quotaRefreshTimer: ReturnType<typeof setInterval> | null = null;

  public initialize(api: Api, chatId: number): void {
    this.api = api;
    this.chatId = chatId;
    if (!this.quotaRefreshTimer) {
      // Refresh the quota badge on the persistent keyboard once per minute.
      this.quotaRefreshTimer = setInterval(() => {
        void fetchQuotaSnapshot().then(() => {
          const before = this.lastBadge;
          this.lastBadge = getCachedQuotaBadge();
          let changed = this.lastBadge !== before;
          if (this.state && this.state.contextInfo) {
            const prevUsed = this.state.contextInfo.tokensUsed;
            this.state.contextInfo.tokensUsed = getContextUsed();
            this.state.contextInfo.tokensLimit = getContextLimit();
            if (this.state.contextInfo.tokensUsed !== prevUsed) changed = true;
          }
          if (changed && this.chatId) {
            void this.sendKeyboardUpdate();
          }
        }).catch(() => {});
      }, 30_000);
      void fetchQuotaSnapshot().catch(() => {});
    }

    // Initialize state from settings/config on first call
    if (!this.state) {
      const currentModel = getStoredModel();
      this.state = {
        currentAgent: getStoredAgent(),
        currentModel: currentModel,
        contextInfo: null,
        variantName: formatVariantForButton(currentModel.variant || "default"),
      };
      logger.debug(
        `[KeyboardManager] Initialized with agent="${this.state.currentAgent}", model="${this.state.currentModel.providerID}/${this.state.currentModel.modelID}", variant="${currentModel.variant || "default"}", chatId=${chatId}`,
      );
    } else {
      logger.debug("[KeyboardManager] Already initialized, updating chatId:", chatId);
    }
  }

  /**
   * Update current agent
   */
  public updateAgent(agent: string): void {
    if (!this.state) {
      logger.warn("[KeyboardManager] Cannot update agent: not initialized");
      return;
    }
    this.state.currentAgent = agent;
    logger.debug(`[KeyboardManager] Agent updated: ${agent}`);
  }

  /**
   * Update current model
   */
  public updateModel(model: ModelInfo): void {
    if (!this.state) {
      logger.warn("[KeyboardManager] Cannot update model: not initialized");
      return;
    }
    this.state.currentModel = model;
    this.state.variantName = formatVariantForButton(model.variant || "default");
    logger.debug(
      `[KeyboardManager] Model updated: ${model.providerID}/${model.modelID}, variant: ${model.variant || "default"}`,
    );
  }

  /**
   * Update current variant
   */
  public updateVariant(variantId: string): void {
    if (!this.state) {
      logger.warn("[KeyboardManager] Cannot update variant: not initialized");
      return;
    }
    this.state.variantName = formatVariantForButton(variantId);
    logger.debug(`[KeyboardManager] Variant updated: ${variantId}`);
  }

  /**
   * Update context information
   */
  public updateContext(tokensUsed: number, tokensLimit: number): void {
    if (!this.state) {
      logger.warn("[KeyboardManager] Cannot update context: not initialized");
      return;
    }
    // agy's step-usage tracker is the context source of truth; legacy callers
    // (sessions/agents handlers) only refresh the limit. Never lower the
    // tracked usage.
    const real = getContextUsed();
    this.state.contextInfo = {
      tokensUsed: Math.max(tokensUsed, real),
      tokensLimit: tokensLimit,
    };
    logger.debug(`[KeyboardManager] Context updated: ${real || tokensUsed}/${tokensLimit}`);
  }

  /**
   * Clear context information
   */
  public clearContext(): void {
    if (!this.state) {
      logger.warn("[KeyboardManager] Cannot clear context: not initialized");
      return;
    }
    this.state.contextInfo = null;
    logger.debug("[KeyboardManager] Context cleared");
  }

  /**
   * Get current context info
   */
  public getContextInfo(): ContextInfo | null {
    return this.state?.contextInfo ?? null;
  }

  /**
   * Build keyboard with current state
   */
  private buildKeyboard() {
    if (!this.state) {
      logger.warn("[KeyboardManager] Cannot build keyboard: not initialized");
      // Return a minimal keyboard as fallback
      return createMainKeyboard("build", { providerID: "", modelID: "" }, undefined);
    }
    void fetchQuotaSnapshot().catch(() => {});
    // If no session-level context exists yet, use the live agy-usage tracker
    // so the button keeps its real number (never a dead "—").
    let ctx = this.state.contextInfo ?? undefined;
    if (!ctx) {
      const tracked = getContextUsed();
      ctx = { tokensUsed: tracked, tokensLimit: getContextLimit() };
    }
    return createMainKeyboard(
      this.state.currentAgent,
      this.state.currentModel,
      ctx,
      this.state.variantName,
      getQueuedPromptButtonLabels(),
      getCachedQuotaBadge(),
    );
  }

  /**
   * Send keyboard update to user
   * Implements debouncing to avoid rate limits
   */
  public async sendKeyboardUpdate(chatId?: number): Promise<void> {
    if (!this.api) {
      logger.warn("[KeyboardManager] API not initialized");
      return;
    }

    const targetChatId = chatId ?? this.chatId;
    if (!targetChatId) {
      logger.warn("[KeyboardManager] No chatId available");
      return;
    }

    // Debounce: don't update more frequently than UPDATE_DEBOUNCE_MS
    const now = Date.now();
    if (now - this.lastUpdateTime < this.UPDATE_DEBOUNCE_MS) {
      logger.debug("[KeyboardManager] Update debounced");
      return;
    }

    this.lastUpdateTime = now;

    try {
      const keyboard = this.buildKeyboard();
      const kbText = JSON.stringify(keyboard.keyboard);
      // Skip re-sends when nothing visibly changed (avoids carrier spam).
      if (kbText === this.lastKeyboardText) {
        logger.debug("[KeyboardManager] Keyboard unchanged, skipping send");
        return;
      }
      this.lastKeyboardText = kbText;

      // Telegram requires a message to attach a reply keyboard. Send it muted,
      // give Telegram time to apply the keyboard, then delete the carrier.
      const probe = await this.api.sendMessage(targetChatId, ".", {
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true } as never,
        disable_notification: true,
      } as never);
      const api = this.api;
      setTimeout(() => {
        void api.deleteMessage(targetChatId, probe.message_id).catch(() => {});
      }, 1500);

      logger.debug("[KeyboardManager] Keyboard update sent");
    } catch (err) {
      logger.error("[KeyboardManager] Failed to send keyboard update:", err);
    }
  }

  /**
   * Update keyboard without sending a message (for use in existing messages)
   * Returns undefined if not initialized (caller should handle this)
   */
  public getKeyboard() {
    if (!this.state) {
      logger.warn("[KeyboardManager] Cannot get keyboard: not initialized");
      return undefined;
    }
    return this.buildKeyboard();
  }

  /**
   * Get current keyboard state
   * Returns undefined if not initialized
   */
  public getState(): KeyboardState | undefined {
    return this.state ?? undefined;
  }

  /**
   * Check if keyboard manager is initialized
   */
  public isInitialized(): boolean {
    return this.state !== null;
  }
}

// Export singleton instance
export const keyboardManager = new KeyboardManager();
