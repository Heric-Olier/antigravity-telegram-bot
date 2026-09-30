import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

/** Retention for materialized attachments (days). */
const MEDIA_RETENTION_DAYS = 7;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
};

function sanitizeFileName(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return base.length > 0 ? base : "attachment";
}

/**
 * agy's stream-json input accepts ONLY text content blocks (verified against
 * the CLI: `stream input content block type "image" is not supported (only
 * "text")`), so file parts cannot travel inline. Materialize each part on
 * disk instead and let the prompt reference the resulting paths — agy opens
 * images fine through its view_file tool.
 */
export async function materializeFileParts(
  parts: Array<Record<string, unknown>>,
): Promise<string[]> {
  const files: string[] = [];
  const dir = path.join(getRuntimePaths().appHome, "media");

  for (const part of parts) {
    if (part.type !== "file") {
      continue;
    }
    const url = typeof part.url === "string" ? part.url : "";
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
    if (!match) {
      continue;
    }
    const mime = match[1] ?? "";
    const data = match[2] ?? "";
    const rawName = typeof part.filename === "string" ? part.filename : "attachment";
    const ext = MIME_EXTENSIONS[mime] ?? (path.extname(rawName) || "");

    try {
      await fs.mkdir(dir, { recursive: true });
      const baseName = sanitizeFileName(rawName);
      const finalName =
        ext && baseName.toLowerCase().endsWith(ext.toLowerCase())
          ? baseName
          : `${baseName}${ext}`;
      const target = path.join(dir, `${Date.now()}-${finalName}`);
      await fs.writeFile(target, Buffer.from(data, "base64"));
      files.push(target);
    } catch (error) {
      logger.warn(`[AgyMedia] Failed to materialize attachment for agy: ${String(error)}`);
    }
  }

  if (files.length > 0) {
    void pruneOldMedia(dir);
  }
  return files;
}

/** Best-effort retention so the media dir never grows unbounded. */
async function pruneOldMedia(dir: string): Promise<void> {
  try {
    const names = await fs.readdir(dir);
    const cutoff = Date.now() - MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const stat = await fs.stat(file);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          await fs.unlink(file);
        }
      } catch {
        // best-effort cleanup
      }
    }
  } catch {
    // directory may not exist yet
  }
}
