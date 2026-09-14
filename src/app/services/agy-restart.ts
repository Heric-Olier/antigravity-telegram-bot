import { interruptActiveTurn, spawnProcessForDirectory } from "../../antigravity/events.js";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

/**
 * Restart the live agy process so it re-reads the OS keyring token.
 * Used after an account switch: the plugin swaps the keyring/token file and
 * agy only loads credentials at boot.
 */
export async function restartAgyProcess(): Promise<void> {
  try {
    await interruptActiveTurn();
  } catch {
    // no active turn — fine
  }
  // Small beat so the dead process releases before the new spawn binds.
  await new Promise((r) => setTimeout(r, 1_500));
  try {
    spawnProcessForDirectory(config.antigravity.workspaceDir, {});
    logger.info("[Accounts] agy restarted after account switch");
  } catch (e) {
    logger.error(`[Accounts] agy restart failed: ${String(e).slice(0, 160)}`);
  }
}
