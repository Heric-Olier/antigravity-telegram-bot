import { readFile } from "node:fs/promises";
import { logger } from "../utils/logger.js";

let cachedVersion: string | undefined;

export async function getBotVersion(): Promise<string> {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }

  try {
    const packageJsonPath = new URL("../../package.json", import.meta.url);
    const packageJsonContent = await readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent) as { version?: string };
    cachedVersion = packageJson.version ?? "unknown";
  } catch (error) {
    logger.warn("[Runtime] Failed to read bot version", error);
    cachedVersion = "unknown";
  }

  return cachedVersion;
}
