import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../utils/logger.js";

/**
 * Antigravity conversation store.
 *
 * Conversations live as one sqlite DB per conversation under
 * `~/.gemini/antigravity-cli/conversations/<conversation-uuid>.db`.
 *
 * Verification notes (sep-2026, real .db files):
 * - `gen_metadata` in the per-conversation .db is a protobuf blob with NO title;
 *   `steps.step_payload` is protobuf too, so the planned gen_metadata JSON title
 *   parse and the steps-based message preview proved FRAGILE (could not be
 *   validated against real data).
 * - The CLI maintains a central summary DB at
 *   `~/.gemini/antigravity-cli/conversation_summaries.db` with per-conversation
 *   `title` and `preview` (first user input) columns. That is the only reliable
 *   on-disk title source, so we use it.
 *
 * Every DB is opened with better-sqlite3 in readonly mode. We never write.
 */

export interface AntigravityConversation {
  id: string;
  title: string;
  preview: string;
  lastModified: Date;
}

function conversationsDir(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations");
}

interface SummaryRow {
  conversation_id: string;
  title: string | null;
  preview: string | null;
}

// TODO(v2): gen_metadata in the per-conversation .db is a protobuf blob without a
// human title in real DBs (checked 2026-09 against live conversations). If agy
// starts writing one, prefer it over the central summary DB — verify first.

function conversationTitleFallback(conversationId: string): string {
  return `Conversation ${conversationId.slice(0, 8)}`;
}

function conversationTitleFromSummaries(
  summaries: Map<string, SummaryRow>,
  conversationId: string,
): string {
  const row = summaries.get(conversationId);
  const title = row?.title?.trim();
  if (title) {
    return title;
  }

  const preview = row?.preview?.trim();
  if (preview) {
    // Truncate long first prompts into a readable title.
    return preview.length > 60 ? `${preview.slice(0, 57)}...` : preview;
  }

  return conversationTitleFallback(conversationId);
}

export function listConversationFiles(): { id: string; mtimeMs: number }[] {
  const dir = conversationsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    logger.warn("[SessionStore] Cannot read conversations directory:", error);
    return [];
  }

  const files: { id: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".db")) {
      continue;
    }
    try {
      const filePath = path.join(dir, entry.name);
      if (!fs.statSync(filePath).isFile()) {
        continue;
      }
      const id = entry.name.slice(0, -".db".length);
      files.push({ id, mtimeMs: fs.statSync(filePath).mtimeMs });
    } catch {
      // Skip files that vanish or cannot stat mid-scan.
    }
  }

  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function loadSummaryIndex(): Map<string, SummaryRow> {
  const summaries = new Map<string, SummaryRow>();
  const summaryDbPath = path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "conversation_summaries.db",
  );

  try {
    if (!fs.existsSync(summaryDbPath)) {
      return summaries;
    }
    const db = new Database(summaryDbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          "SELECT conversation_id, title, preview FROM conversation_summaries WHERE title != '' OR preview != ''",
        )
        .all() as SummaryRow[];
      for (const row of rows) {
        if (row && typeof row.conversation_id === "string") {
          summaries.set(row.conversation_id, row);
        }
      }
    } finally {
      db.close();
    }
  } catch (error) {
    logger.warn("[SessionStore] Cannot read conversation summaries DB:", error);
  }

  return summaries;
}

/**
 * List real conversations, newest first.
 */
export async function listConversations(limit?: number | null): Promise<AntigravityConversation[]> {
  const result = buildConversationList();
  if (typeof limit === "number") {
    return result.slice(0, limit);
  }

  return result;
}

function buildConversationList(): AntigravityConversation[] {
  const summaries = loadSummaryIndex();
  return listConversationFiles().map((file) => {
    const lastModified = new Date(file.mtimeMs);
    return {
      id: file.id,
      title: conversationTitleFromSummaries(summaries, file.id),
      preview: summaries.get(file.id)?.preview?.trim() ?? "",
      lastModified,
    };
  });
}

/**
 * Build a preview: title + last-modified date + last messages labelled "You"/"Agent".
 *
 * The per-conversation .db steps table stores protobuf payloads, not JSON — the
 * You/Agent message content could not be reliably extracted from real DBs, so v1
 * shows only the reliable metadata (title/date) as a resumable notice.
 */
export function formatConversationPreview(conversation: AntigravityConversation): string {
  const date = new Date(conversation.lastModified).toLocaleString();
  const lines = [`📂 ${conversation.title}`, `🕒 ${date}`];

  if (conversation.preview) {
    lines.push("");
    lines.push(`You ${conversation.preview}`);
    lines.push("... resumable existing conversation");
  } else {
    lines.push("resumable existing conversation");
  }

  return lines.join("\n");
}

/**
 * Get a single conversation, null if it does not exist on disk.
 */
export function getConversation(id: string): AntigravityConversation | null {
  return buildConversationList().find((conversation) => conversation.id === id) ?? null;
}

export function conversationExists(id: string): boolean {
  return fs.existsSync(path.join(conversationsDir(), `${id}.db`));
}

/**
 * Real conversation title from the agy summaries DB (falls back to the
 * short-id label). Cached index is rebuilt when the summaries file changes.
 */
export function getConversationTitle(conversationId: string): string {
  const summaries = loadSummaryIndex();
  return conversationTitleFromSummaries(summaries, conversationId);
}
