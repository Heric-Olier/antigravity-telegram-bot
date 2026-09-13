import { logger } from "../../utils/logger.js";
import { getConversation } from "../../antigravity/session-store.js";
import { formatConversationPreview } from "../../antigravity/session-store.js";

/**
 * Message-history service (agy version).
 *
 * agy .db conversation files store messages as protobuf; no reliable on-disk
 * text extraction was verified, so history items are title/date-only for now.
 */

export interface UserMessageItem {
  id: string;
  text: string;
  created: number;
}

// TODO(v2): read real per-message text from agy .db steps once the protobuf
// schema is verifiable; for now previews come from the CLI summary data.
export async function loadUserMessages(
  conversationId: string,
  _directory: string,
): Promise<UserMessageItem[]> {
  const conversation = getConversation(conversationId);
  if (!conversation || !conversation.preview) {
    return [];
  }

  return [
    {
      id: `${conversation.lastModified.getTime()}`,
      text: conversation.preview,
      created: conversation.lastModified.getTime(),
    },
  ];
}

export async function loadLatestAssistantResponse(
  _conversationId: string,
  _directory: string,
): Promise<string | null> {
  logger.debug("[Messages] agy conversation history is title-only; no assistant response to load");
  return null;
}

export { formatConversationPreview };
