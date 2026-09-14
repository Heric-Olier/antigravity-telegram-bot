import { exec } from "node:child_process";
import type { CommandContext, Context } from "grammy";
import { interruptActiveTurn } from "../../antigravity/events.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

/**
 * /restart — hot-restart the bot process so pending code/config changes land.
 *
 * Only meaningful for the systemd --user deployment: the unit restarts the
 * service, which respawns this process with the latest dist/ build. Telegram
 * gets an ack first because the socket dies mid-command otherwise.
 */
const SERVICE_NAME = "antigravity-telegram-bot.service";

export async function restartCommand(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply(t("cmd.restart.ack"), {
    link_preview_options: { is_disabled: true },
  });

  // End the current agy turn gracefully before the process dies so agy's
  // conversation isn't left mid-turn.
  try {
    await interruptActiveTurn();
  } catch (err) {
    logger.debug("[Restart] no active turn to interrupt:", err);
  }

  // Give the ack + interrupt a beat, then bounce the unit.
  setTimeout(() => {
    exec(
      `systemctl --user restart ${SERVICE_NAME}`,
      { timeout: 15_000 },
      (err) => {
        if (err) {
          logger.error("[Restart] systemctl restart failed:", err);
        }
      },
    );
  }, 1_200);
}
