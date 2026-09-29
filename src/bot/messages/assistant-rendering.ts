import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

// Streaming payloads are rebuilt on every render tick (Telegram syncs are
// throttled elsewhere; the builds are not), so cap these logs at one per
// second — a busy stream tail used to emit ~15 lines/second to the journal.
let lastStreamingPayloadLogAtMs = 0;
const STREAMING_PAYLOAD_LOG_THROTTLE_MS = 1_000;

function logStreamingPayload(message: string): void {
  const now = Date.now();
  if (now - lastStreamingPayloadLogAtMs < STREAMING_PAYLOAD_LOG_THROTTLE_MS) {
    return;
  }
  lastStreamingPayloadLogAtMs = now;
  logger.debug(message);
}

import { chunkPlainText, chunkTelegramRenderedBlocks } from "../render/chunker.js";
import { renderTelegramBlocks, renderTelegramParts, toRenderedBlocks } from "../render/pipeline.js";
import type { TelegramRenderedBlock, TelegramRenderedPart } from "../render/types.js";
import type { StreamingMessagePayload } from "../streaming/response-streamer.js";

export function createPlainRenderedParts(text: string): TelegramRenderedPart[] {
  return chunkPlainText(text);
}

function useAssistantEntitiesFormat(): boolean {
  return config.bot.messageFormatMode === "markdown";
}

function renderAssistantBlocksSafe(text: string): TelegramRenderedBlock[] {
  if (!text) {
    return [];
  }

  try {
    return renderTelegramBlocks(text);
  } catch (error) {
    logger.warn(
      "[AssistantRender] Block rendering failed, falling back to plain streaming block",
      error,
    );
    return toRenderedBlocks([{ type: "plain", text }]);
  }
}

export function renderAssistantFinalPartsSafe(text: string): TelegramRenderedPart[] {
  if (!text) {
    return [];
  }

  const formatMode = useAssistantEntitiesFormat() ? "blocks" : "raw";

  if (!useAssistantEntitiesFormat()) {
    const parts = createPlainRenderedParts(text);
    logger.debug(
      `[AssistantRender] Built final payload (raw): format=${formatMode}, len=${text.length}, parts=${parts.length}`,
    );
    return parts;
  }

  try {
    const parts = renderTelegramParts(text);
    logger.debug(
      `[AssistantRender] Built final payload (blocks): format=${formatMode}, len=${text.length}, parts=${parts.length}`,
    );
    return parts;
  } catch (error) {
    logger.warn("[AssistantRender] Part rendering failed, falling back to plain text parts", error);
    const parts = createPlainRenderedParts(text);
    logger.debug(
      `[AssistantRender] Built final payload (raw fallback): format=${formatMode}, len=${text.length}, parts=${parts.length}`,
    );
    return parts;
  }
}

function getStableStreamingBoundary(messageText: string): number {
  if (!messageText) {
    return 0;
  }

  if (messageText.endsWith("\n\n")) {
    return messageText.length;
  }

  const lastBlockSeparatorIndex = messageText.lastIndexOf("\n\n");
  return lastBlockSeparatorIndex >= 0 ? lastBlockSeparatorIndex + 2 : 0;
}

/**
 * Blocks for text that is still arriving: everything up to the last blank line
 * is structurally complete and gets parsed, the trailing tail stays literal
 * until its block is finished.
 */
export function buildStreamingBlocks(messageText: string): TelegramRenderedBlock[] {
  const stableBoundary = getStableStreamingBoundary(messageText);
  const blocks: TelegramRenderedBlock[] = [];

  if (stableBoundary > 0) {
    blocks.push(...renderAssistantBlocksSafe(messageText.slice(0, stableBoundary)));
  }

  const unstableTail = stableBoundary > 0 ? messageText.slice(stableBoundary) : messageText;
  if (unstableTail) {
    blocks.push(...toRenderedBlocks([{ type: "plain", text: unstableTail }]));
  }

  return blocks;
}

export function prepareAssistantStreamingPayload(
  messageText: string,
): StreamingMessagePayload | null {
  if (!messageText) {
    return null;
  }

  const formatMode = useAssistantEntitiesFormat() ? "blocks" : "raw";

  if (!useAssistantEntitiesFormat()) {
    const parts = createPlainRenderedParts(messageText);
    logStreamingPayload(
      `[AssistantRender] Built streaming payload (raw): format=${formatMode}, len=${messageText.length}, parts=${parts.length}`,
    );
    return parts.length > 0 ? { parts } : null;
  }

  const blocks = buildStreamingBlocks(messageText);
  const parts = chunkTelegramRenderedBlocks(blocks);
  logStreamingPayload(
    `[AssistantRender] Built streaming payload (blocks): format=${formatMode}, len=${messageText.length}, blocks=${blocks.length}, parts=${parts.length}`,
  );

  return parts.length > 0 ? { parts } : null;
}

export function prepareAssistantFinalStreamingPayload(
  messageText: string,
): StreamingMessagePayload | null {
  const parts = renderAssistantFinalPartsSafe(messageText);
  return parts.length > 0 ? { parts } : null;
}
