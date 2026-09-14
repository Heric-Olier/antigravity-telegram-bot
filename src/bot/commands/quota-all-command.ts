import type { CommandContext, Context } from "grammy";
import { logger } from "../../utils/logger.js";
import {
  agyBusy,
  quotaAllProfiles,
  type ProfileQuota,
} from "../../app/services/profile-quota-service.js";

function firstLine(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = d.getTime() - Date.now();
  const hours = Math.floor(diff / 3_600_000);
  const mins = Math.round((diff % 3_600_000) / 60_000);
  return diff <= 0 ? "" : ` · refresh ${hours}h ${mins}m`;
}

function gauge(pct: number): string {
  // 10-segment bar, colored by remaining share.
  const filled = Math.round(pct / 10);
  const icon = pct >= 50 ? "🟢" : pct >= 20 ? "🟠" : "🔴";
  return `${icon} ${"▓".repeat(filled)}${"░".repeat(10 - filled)} ${pct}%`;
}

function bar(label: string, pct: number, resetIso: string | null): string {
  return `${gauge(pct)}  ${label}${firstLine(resetIso)}`;
}

/** /quotaall — live quota of every saved account (like Antigravity's panel). */
export async function quotaAllCommand(ctx: CommandContext<Context> | Context): Promise<void> {
  await ctx.reply("📊 Checking all accounts… (~7s per account)");
  const busy = await agyBusy();
  if (busy) {
    await ctx.reply(
      "ℹ️ Note: agy is mid-task — the quota check swaps the stored token for a few seconds per account. Your running turn is not interrupted.",
    );
  }
  const started = Date.now();
  const results = await quotaAllProfiles();
  logger.info(`[QuotaAll] probed ${results.length} profiles in ${Date.now() - started}ms`);
  if (results.length === 0) {
    await ctx.reply("No saved accounts. Use /accounts to add one.");
    return;
  }
  const blocks = results.map((r: ProfileQuota) => {
    const head = r.ok ? `👤 ${r.email}` : `👤 ${r.email} — ⚠️ probe failed`;
    if (!r.ok) return `${head}\n${r.detail ?? ""}`.trim();
    const lines = r.buckets.map((b) => `  ${bar(b.label, b.pct, b.resetIso)}`);
    return [head, ...lines].join("\n");
  });
  await ctx.reply(`📊 Account quotas (remaining):\n\n${blocks.join("\n\n")}`);
}
