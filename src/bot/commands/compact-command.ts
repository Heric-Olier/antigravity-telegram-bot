import { CommandContext, Context } from "grammy";
import { requestCompaction } from "../../app/services/context-compaction-service.js";
import { logger } from "../../utils/logger.js";

/**
 * /compact — hand the conversation context over to a fresh conversation
 * (Capa 9): asks the agent for a handoff summary, then continues in a new
 * conversation seeded with it. Mirrors the auto-compaction but on demand.
 */
export async function compactCommand(ctx: CommandContext<Context>): Promise<void> {
  try {
    await requestCompaction("manual");
  } catch (error) {
    logger.error("[Bot] /compact failed:", error);
    await ctx.reply("⚠️ /compact failed — check the logs.").catch(() => undefined);
  }
}
