import type { Bot, Context } from "grammy";
import { summaryAggregator } from "../managers/summary-aggregation-manager.js";
import type { SessionInfo } from "../types/session.js";
import { getCurrentSession } from "./session-service.js";
import { getCurrentProject } from "../stores/settings-store.js";
import { attachManager } from "../managers/attach-manager.js";
import { resetStreamThrottle } from "../../bot/streaming/stream-throttle.js";
import { logger } from "../../utils/logger.js";

interface EnsureAttachPinnedSessionParams {
  api: Bot<Context>["api"];
  chatId: number;
  session: SessionInfo;
  forceFullRestore?: boolean | undefined;
}

export interface AttachPresentationDeps {
  ensurePinnedSession(params: EnsureAttachPinnedSessionParams): Promise<void>;
  syncAttachState(attached: boolean, busy: boolean): Promise<void>;
  showCurrentQuestion(api: Bot<Context>["api"], chatId: number): Promise<void>;
  showPermissionRequest(
    api: Bot<Context>["api"],
    chatId: number,
    request: unknown,
  ): Promise<void>;
}

let attachPresentation: AttachPresentationDeps | null = null;

export function configureAttachPresentation(deps: AttachPresentationDeps | null): void {
  attachPresentation = deps;
}

export interface AttachSessionDeps {
  bot: Bot<Context>;
  chatId: number;
  session: SessionInfo;
  ensureEventSubscription: (directory: string) => Promise<void>;
  forceFullRestore?: boolean | undefined;
}

export interface AttachSessionResult {
  busy: boolean;
  alreadyAttached: boolean;
}

export interface RestoreAttachedCurrentSessionDeps {
  bot: Bot<Context>;
  chatId: number;
  ensureEventSubscription: (directory: string) => Promise<void>;
  forceFullRestore?: boolean;
}

async function syncPinnedAttachState(): Promise<void> {
  if (!attachPresentation) {
    return;
  }

  const attached = attachManager.getSnapshot();
  await attachPresentation.syncAttachState(attached !== null, attached?.busy ?? false);
}

export async function attachToSession(deps: AttachSessionDeps): Promise<AttachSessionResult> {
  const { bot, chatId, session, ensureEventSubscription } = deps;
  const alreadyAttached = attachManager.isAttachedSession(session.id, session.directory);

  await attachPresentation?.ensurePinnedSession({
    api: bot.api,
    chatId,
    session,
    forceFullRestore: deps.forceFullRestore,
  });

  if (!alreadyAttached) {
    await ensureEventSubscription(session.directory);
    summaryAggregator.setSession(session.id);
    summaryAggregator.setBotAndChatId(bot, chatId);
    attachManager.attach(session.id, session.directory);
  } else {
    summaryAggregator.setSession(session.id);
    summaryAggregator.setBotAndChatId(bot, chatId);
  }

  // agy runs one process per prompt turn; there is no external busy registry.
  // A just-attached conversation is assumed idle; the event subscription flips
  // the attached state busy/idle as turn events arrive.
  attachManager.markIdle(session.id);

  await syncPinnedAttachState();

  return {
    busy: false,
    alreadyAttached,
  };
}

export async function restoreAttachedCurrentSession(
  deps: RestoreAttachedCurrentSessionDeps,
): Promise<boolean> {
  const currentProject = getCurrentProject();
  const currentSession = getCurrentSession();

  if (!currentProject || !currentSession) {
    return false;
  }

  if (currentSession.directory !== currentProject.worktree) {
    logger.warn(
      `[Attach] Skipping auto-restore because project/session mismatch: sessionDirectory=${currentSession.id}, projectDirectory=${currentProject.worktree}`,
    );
    return false;
  }

  try {
    await attachToSession({
      bot: deps.bot,
      chatId: deps.chatId,
      session: currentSession,
      ensureEventSubscription: deps.ensureEventSubscription,
      forceFullRestore: deps.forceFullRestore,
    });
    logger.info(
      `[Attach] Restored followed session on startup: session=${currentSession.id}, directory=${currentSession.directory}`,
    );
    return true;
  } catch (error) {
    logger.error("[Attach] Failed to restore followed session on startup:", error);
    return false;
  }
}

export function detachAttachedSession(reason: string): void {
  if (!attachManager.isAttached()) {
    return;
  }

  const attachedSessionId = attachManager.getSnapshot()?.sessionId;
  if (attachedSessionId) {
    resetStreamThrottle(attachedSessionId);
  }

  summaryAggregator.clear();
  attachManager.clear(reason);
  void syncPinnedAttachState();
}

export async function markAttachedSessionBusy(sessionId: string): Promise<void> {
  if (!attachManager.markBusy(sessionId)) {
    return;
  }

  await syncPinnedAttachState();
}

export async function markAttachedSessionIdle(sessionId: string): Promise<void> {
  if (!attachManager.markIdle(sessionId)) {
    return;
  }

  await syncPinnedAttachState();
}
