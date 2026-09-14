import { execFile } from "node:child_process";
import { CommandContext, Context } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

/**
 * /usage — show the Google account quota from the CLI itself.
 *
 * `agy -p /usage` is answered by the CLI internally (no model turn), so
 * checking the quota from the phone costs zero usage.
 */
export async function usageCommand(ctx: CommandContext<Context>): Promise<void> {
  const thinking = await ctx.reply("⏳ checking quota...");

  execFile(
    config.antigravity.bin,
    ["-p", "/usage"],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
    async (error, stdout) => {
      void (async () => {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, thinking.message_id);
        } catch {
          // ignore cleanup failures
        }

        if (error && !stdout) {
          logger.error("[Usage] agy /usage failed:", error);
          await ctx.reply(t("usage.error"));
          return;
        }

        const lines = stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);

        const formatted = lines
          .map((line) => {
            // "Gemini Models\tWeekly Limit Remaining\t96%\t<ts>" → bar
            const parts = line.split("\t");
            if (parts.length < 3) return null;
            const [bucket, kind, pctRaw = ""] = parts;
            const pct = Number.parseInt(pctRaw.replace("%", ""), 10);
            const bar =
              Number.isFinite(pct)
                ? "▮".repeat(Math.round(pct / 10)) + "▯".repeat(10 - Math.round(pct / 10))
                : pctRaw;
            const icon = pct >= 80 ? "🟢" : pct >= 40 ? "🟡" : "🔴";
            const reset = parts[3] ? `\n   ⏱ reset: ${humanizeReset(parts[3], pct)}` : "";
            const empty = pct === 0 ? " ⛔ DEPLETED" : "";
            return `${icon} ${bucket} — ${kind}: ${pctRaw}${empty}\n   ${bar}${reset}`;
          })
          .filter(Boolean)
          .join("\n\n");

        await ctx.reply(formatted || stderrText(stdout));
      })();
    },
  );
}

function stderrText(localStdout: string): string {
  return localStdout || t("usage.error");
}

/** ISO timestamp → "in 1h 45m"; when the quota bucket is depleted, highlight
 * the local wall-clock time instead. */
function humanizeReset(iso: string, pct: number): string {
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return iso;
  const mins = Math.max(0, Math.round((target - Date.now()) / 60_000));
  const h = Math.floor(mins / 60);
  const rest = mins % 60;
  const rel = h > 0 ? `in ${h}h ${rest}m` : `in ${rest}m`;
  if (pct > 0) return `${rel} (${iso.replace("T", " ").replace("Z", " UTC")})`;
  const local = new Date(target).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${rel} → ready at ${local} (local time)`;
}
