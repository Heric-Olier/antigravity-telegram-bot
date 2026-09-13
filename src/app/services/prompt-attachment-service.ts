import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FilePartInput } from "@opencode-ai/sdk/v2";
import { config } from "../../config.js";
import { promptAttachment } from "../managers/prompt-attachment-manager.js";
import { logger } from "../../utils/logger.js";
import { isFileSizeAllowed } from "./file-download-service.js";
import { isWithinProjectRootSafe } from "./file-browser-service.js";

// OpenCode resolves a file: part by reading the path with its own read tool, but only when
// the MIME type is exactly this - anything else takes the binary branch.
const OPENCODE_TEXT_MIME = "text/plain";

/**
 * Validates the pending attachment and turns it into a file part.
 *
 * The file is re-checked here rather than at selection time: any amount of time may pass
 * between picking it in /ls and sending the prompt. Any failed check drops the attachment.
 *
 * @returns the file part, or null when there is nothing to attach or it is no longer valid.
 */
export async function resolvePendingAttachment(worktree: string): Promise<FilePartInput | null> {
  const pending = promptAttachment.get();
  if (!pending) {
    return null;
  }

  const { absolutePath } = pending;

  if (pending.worktree !== worktree) {
    logger.warn(
      `[PromptAttachment] Dropping attachment: project changed, attached=${pending.worktree}, current=${worktree}`,
    );
    promptAttachment.clear("project_changed");
    return null;
  }

  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (error) {
    logger.warn(`[PromptAttachment] Dropping attachment: cannot stat ${absolutePath}`, error);
    promptAttachment.clear("file_unavailable");
    return null;
  }

  if (!stat.isFile()) {
    logger.warn(`[PromptAttachment] Dropping attachment: not a file anymore: ${absolutePath}`);
    promptAttachment.clear("not_a_file");
    return null;
  }

  if (!isFileSizeAllowed(stat.size, config.files.maxFileSizeKb)) {
    logger.warn(
      `[PromptAttachment] Dropping attachment: too large: ${absolutePath} (${stat.size} bytes > ${config.files.maxFileSizeKb}KB)`,
    );
    promptAttachment.clear("file_too_large");
    return null;
  }

  if (!(await isWithinProjectRootSafe(absolutePath))) {
    logger.warn(`[PromptAttachment] Dropping attachment: outside project root: ${absolutePath}`);
    promptAttachment.clear("outside_project_root");
    return null;
  }

  return {
    type: "file",
    mime: OPENCODE_TEXT_MIME,
    filename: toRelativePath(absolutePath, worktree),
    url: pathToFileURL(absolutePath).href,
  };
}

export function toRelativePath(absolutePath: string, worktree: string): string {
  const relative = path.relative(worktree, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}
