import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { listAccounts, switchToAccount, notePendingAdd } from "../../app/services/agy-accounts-service.js";
import { restartAgyProcess } from "../../app/services/agy-restart.js";
import { logger } from "../../utils/logger.js";

const CB = {
  LIST: "acct:list",
  SWITCH: "acct:sw:", // acct:sw:<email>
  ADD: "acct:add",
  REFRESH: "acct:refresh",
  QUOTA: "acct:quota",
};

/** Entry point for the 🔁 bottom keyboard button: show saved-account menu. */
export async function showAccountMenu(ctx: Context): Promise<void> {
  const { active, profiles } = await listAccounts();
  const kb = new InlineKeyboard();

  if (profiles.length === 0) {
    kb.text("➕ Add Google account", CB.ADD).row();
    await ctx.reply(
      "No Google accounts saved yet.\nUse “Add account” — it opens a Google sign-in; paste the final localhost URL back with /code.",
    );
    return;
  }

  for (const email of profiles) {
    const marker = email === active ? "★" : "○";
    const label = email === active ? `${marker} ${email} (active)` : `${marker} ${email}`;
    if (email === active) {
      kb.text(label, CB.LIST).row();
    } else {
      kb.text(label, CB.SWITCH + email).row();
    }
  }
  kb.text("➕ Add account", CB.ADD).row();
  kb.text("📊 Quotas of all accounts", CB.QUOTA).row();
  kb.text("🔄 Refresh", CB.REFRESH).row();

  await ctx.reply(
    `Google accounts (★ = active):\nTap an account to switch — instant, no re-login.`,
    { reply_markup: kb },
  );
}

/** Register the inline-callback handlers for the account menu. */
export function registerAccountMenuHandlers(bot: Bot): void {
  bot.callbackQuery(new RegExp(`^${CB.SWITCH}`), async (ctx) => {
    const email = ctx.callbackQuery.data.slice(CB.SWITCH.length);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(`Switching to ${email}…`);
    const res = await switchToAccount(email);
    if (!res.ok) {
      await ctx.reply(`❌ Switch failed:\n${res.detail.slice(-200)}`);
      return;
    }
    await restartAgyProcess();
    await ctx.reply(`✅ Now active: ${email}`);
  });

  bot.callbackQuery(CB.ADD, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const { startAddAccount } = await import("../../app/services/agy-accounts-service.js");
    await ctx.reply("🔑 Starting Google sign-in…");
    const res = await startAddAccount();
    if (!res.ok || !res.authUrl) {
      await ctx.reply(`❌ Could not start sign-in:\n${(res.detail ?? "").slice(-200)}`);
      return;
    }
    notePendingAdd(res.authUrl);
    await ctx.reply(
      `Open this link and complete the sign-in:\n\n${res.authUrl}\n\n` +
        "⚠️ The final redirect goes to localhost and will fail to load — that is expected. " +
        "Copy the full URL from the address bar (contains ?code=…) and send it with /code <url>.",
      { link_preview_options: { is_disabled: true } },
    );
    logger.info("[Accounts] add-account URL delivered from menu");
  });

  bot.callbackQuery(CB.REFRESH, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showAccountMenu(ctx);
  });

  bot.callbackQuery(CB.QUOTA, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const { quotaAllCommand } = await import("../commands/quota-all-command.js");
    await quotaAllCommand(ctx);
  });
}
