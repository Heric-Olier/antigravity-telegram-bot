import type { CommandContext, Context } from "grammy";
import { startAccountSwitch, type SwitchHandle } from "../../app/services/account-switch-service.js";
import { t } from "../../i18n/index.js";

let pending: SwitchHandle | null = null;

/** Called by the /code command text handler. */
export async function handleSwitchCode(ctx: CommandContext<Context>): Promise<void> {
  const code = typeof ctx.match === "string" ? ctx.match.trim() : "";
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

export async function switchCommand(ctx: CommandContext<Context>): Promise<void> {
  if (pending) {
    await ctx.reply(t("switch.already_pending"));
    return;
  }
  await ctx.reply(t("switch.working"));
  const handle = await startAccountSwitch();
  if (!handle.authUrl) {
    pending = handle;
    pending.onFinish(() => {
      pending = null;
    });
    await ctx.reply(t("switch.no_url_yet"));
    return;
  }
  pending = handle;
  handle.onFinish((ok, detail) => {
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
  await ctx.reply(`${t("switch.url_intro")}\n\n${handle.authUrl}\n\n${t("switch.paste_code_hint")}`, {
    link_preview_options: { is_disabled: true },
  });
}

export function hasPendingSwitch(): boolean {
  return pending !== null;
}
