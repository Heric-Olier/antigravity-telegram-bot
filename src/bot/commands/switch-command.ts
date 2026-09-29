import type { CommandContext, Context } from "grammy";
import type { SwitchHandle } from "../../app/services/account-switch-service.js";
import { completeManualExchange } from "../../app/services/agy-accounts-service.js";
import { restartAgyProcess } from "../../app/services/agy-restart.js";
import { showAccountMenu } from "../menus/account-menu.js";
import { t } from "../../i18n/index.js";

let pending: SwitchHandle | null = null;

/** Called by the /code command text handler. */
export async function handleSwitchCode(ctx: CommandContext<Context>): Promise<void> {
  const code = typeof ctx.match === "string" ? ctx.match.trim() : "";
  // New path: a pasted localhost callback URL from /addaccount (phone flow).
  if (code.startsWith("http")) {
    await ctx.reply("Exchanging authorization code…");
    const res = await completeManualExchange(code);
    if (!res.ok) {
      await ctx.reply(`❌ ${res.detail}`);
      return;
    }
    await ctx.reply(`✅ ${res.detail} — restarting agy to activate it.`);
    await restartAgyProcess();
    return;
  }
  if (!pending) {
    await ctx.reply(t("switch.no_pending"));
    return;
  }
  if (!code) {
    await ctx.reply(t("switch.code_needed"));
    return;
  }
  pending.submitCode(code);
  pending.onFinish((ok, detail) => {
    void ctx
      .reply(
        ok
          ? t("switch.done")
          : `${t("switch.failed")}\n<code>${detail.replace(/<[^>]+>/g, "").slice(-300)}</code>`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    pending = null;
  });
  await ctx.reply(t("switch.submitting"));
}

/**
 * `/switch` now opens the saved-accounts menu: the legacy pty OAuth flow it
 * used to launch is superseded by the agy-accounts plugin flow (account menu,
 * /switchprofile, /addaccount). The legacy flow never worked with the
 * fullscreen TUI and any child failure used to crash the whole bot process.
 */
export async function switchCommand(ctx: CommandContext<Context>): Promise<void> {
  await showAccountMenu(ctx);
}
