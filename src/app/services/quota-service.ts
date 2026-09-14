import { execFile } from "node:child_process";
import { config } from "../../config.js";

export interface QuotaBucket {
  bucket: string;
  kind: string;
  pct: number;
  resetIso?: string | undefined;
}

let cache: { buckets: QuotaBucket[]; ts: number } | null = null;
const TTL = 60_000;

/**
 * Read the Google account quota buckets via `agy -p /usage`.
 * The CLI answers this internally (no model turn → zero usage).
 * Cached for 60s so menu renders don't spawn extra processes.
 */
export function fetchQuotaSnapshot(force = false): Promise<QuotaBucket[]> {
  if (!force && cache && Date.now() - cache.ts < TTL) {
    return Promise.resolve(cache.buckets);
  }
  return new Promise((resolve) => {
    execFile(
      config.antigravity.bin,
      ["-p", "/usage"],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const buckets = parseUsage(stdout ?? "");
        cache = { buckets, ts: Date.now() };
        resolve(buckets);
        if (error && buckets.length === 0) console.warn(error);
      },
    );
  });
}

export function parseUsage(stdout: string): QuotaBucket[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("\t"))
    .map((line): QuotaBucket => {
      const parts = line.split("\t");
      const bucket = parts[0] ?? "";
      const kind = parts[1] ?? "";
      const pctRaw = parts[2] ?? "";
      const pct = Number.parseInt(pctRaw.replace("%", ""), 10);
      return { bucket, kind, pct: Number.isFinite(pct) ? pct : -1, resetIso: parts[3] || undefined };
    })
    .filter((b) => Boolean(b.bucket) && Boolean(b.kind));
}

/** Compact one-line badge for menus: "🟢5h 82% · 🟡semana 41%" (worst first). */
export function quotaBadgeLine(buckets: QuotaBucket[]): string {
  if (buckets.length === 0) return "";
  return buckets
    .map((b) => {
      const label = b.kind.includes("Five Hour") ? "5h" : "semana";
      const icon = b.pct >= 80 ? "🟢" : b.pct >= 40 ? "🟡" : "🔴";
      return `${icon}${label} ${b.pct}%`;
    })
    .join(" · ");
}
