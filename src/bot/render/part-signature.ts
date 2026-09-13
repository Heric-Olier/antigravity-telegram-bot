import type { TelegramRenderedPart } from "./types.js";

/**
 * Stable identity of what was actually delivered to Telegram. The streamer
 * compares signatures to skip unchanged edits, so the signature must describe
 * the representation that was sent, not the one that was rendered.
 */
export function getTelegramRenderedPartSignature(
  part: Pick<TelegramRenderedPart, "blocks" | "fallbackText" | "source" | "entities">,
): string {
  if (part.source === "plain" || part.blocks.length === 0) {
    // Reasoning keeps the same text when it collapses, only the entity changes.
    const entities = part.entities?.length ? JSON.stringify(part.entities) : "";
    return `plain\n${entities}\n${part.fallbackText}`;
  }

  return `blocks\n${JSON.stringify(part.blocks)}`;
}
