import type { CommandContext, Context } from "grammy";
import { logger } from "../../utils/logger.js";
import {
  exportKeyringTokenToFile,
  listAccounts,
  startAddAccount,
  switchToAccount,
} from "../../app/services/agy-accounts-service.js";
import { restartAgyProcess } from "../../app/services/agy-restart.js";

/** /accounts — list saved profiles with the active marker. */
export async function accountsCommand(ctx: CommandContext<Context>): Promise<void> {
  const { active, profiles } = await listAccounts();
  if (profiles.length === 0) {
    await ctx.reply(
      "No saved Google account profiles yet.\nUse /addaccount to log a new account in (opens a Google link).",
    );
    return;
  }
  const lines = profiles.map((p) => (p === active ? `★ ${p} (active)` : `  ${p}`));
  await ctx.reply(
    `Saved Google accounts:\n${lines.join("\n")}\n\nSwitch with /switch <email> — no re-login needed.`,
  );
}

/**
 * /switch <email> — swap the active token to a saved profile and restart agy.
 * Without arguments, behaves like /accounts.
 */
export async function switchProfileCommand(ctx: CommandContext<Context>): Promise<void> {
  const arg = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!arg) {
    await accountsCommand(ctx);
    return;
  }
  await ctx.reply(`Switching to ${arg}…`);
  const res = await switchToAccount(arg);
  if (!res.ok) {
    await ctx.reply(`❌ Switch failed:\n<code>${res.detail.replace(/<[^>]+>/g, "").slice(-300)}</code>`, {
      parse_mode: "HTML",
    });
    return;
  }
  // Restart the live agy process so it picks up the new token.
  await restartAgyProcess();
  await ctx.reply(`✅ Switched to ${arg}. agy restarted with the new account.`);
}

/** /addaccount — generate a Google OAuth URL via the plugin's local daemon. */
export async function addAccountCommand(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply("🔑 Starting Google sign-in…");
  // Make sure the plugin can see the active token (one-time keyring→file bridge).
  await exportKeyringTokenToFile();
  const res = await startAddAccount();
  if (!res.ok || !res.authUrl) {
    await ctx.reply(`❌ Could not start the sign-in flow:\n<code>${(res.detail ?? "").slice(-200)}</code>`, {
      parse_mode: "HTML",
    });
    return;
  }
  await ctx.reply(
    `Open this link in your browser and complete the Google sign-in:\n\n${res.authUrl}\n\n` +
      "⚠️ The final redirect goes to localhost — that page will fail to load. " +
      "That's expected: COPY the full URL from the address bar (it contains ?code=…&state=…) " +
      "and send it back here with /code <that-url>. I'll exchange it and save the account.",
    { link_preview_options: { is_disabled: true } },
  );
  logger.info("[Accounts] add-account URL delivered to user");
}
