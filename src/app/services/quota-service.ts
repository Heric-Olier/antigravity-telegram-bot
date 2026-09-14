import { execFile } from "node:child_process";
import * as fsMod from "node:fs";
import { config } from "../../config.js";

export interface QuotaBucket {
  bucket: string;
  kind: string;
  pct: number;
  resetIso?: string | undefined;
  /** Minutes until the bucket resets (when resetIso parses). */
  minutesLeft?: number | undefined;
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
      const resetIso = parts[3] || undefined;
      const resetMs = resetIso ? Date.parse(resetIso) : NaN;
      const minutesLeft = Number.isFinite(resetMs)
        ? Math.max(0, Math.round((resetMs - Date.now()) / 60_000))
        : undefined;
      return { bucket, kind, pct: Number.isFinite(pct) ? pct : -1, resetIso, minutesLeft };
    })
    .filter((b) => Boolean(b.bucket) && Boolean(b.kind));
}

/** Compact one-line badge for menus: "🟢5h 82% · 🟡semana 41%" (worst first). */
export function quotaBadgeLine(buckets: QuotaBucket[]): string {
  const gemini = buckets.filter((b) => b.bucket.startsWith("Gemini"));
  if (gemini.length === 0) return "";
  const five = gemini.find((b) => b.kind.includes("Five Hour"));
  const weekly = gemini.find((b) => b.kind.includes("Weekly"));
  const ordered = [five, weekly].filter(Boolean) as typeof gemini;
  return ordered
    .map((b) => {
      const label = b.kind.includes("Five Hour") ? "5h" : "sem";
      const icon = b.pct >= 80 ? "🟢" : b.pct >= 40 ? "🟡" : "🔴";
      // "falta": compact relative time (e.g. "1h05" / "3d04h"), wrapped in
      // parentheses so both pct AND remaining time fit the button.
      const left = shortLeft(b.minutesLeft);
      return `${icon}${label} ${b.pct}%${left ? ` (${left})` : ""}`;
    })
    .join(" ");
}

/** Sync read of the last cached badge ("" if never fetched). The keyboard
 * manager calls this — a 60s-stale badge is fine for a footer button. */
export function getCachedQuotaBadge(): string {
  return cache ? quotaBadgeLine(cache.buckets) : "";
}

/** Compact "time remaining" for a keyboard button: 1h45 / 3d4h. */
function shortLeft(minutes?: number | undefined): string {
  if (minutes === undefined) return "";
  if (minutes >= 48 * 60) {
    const d = Math.floor(minutes / (24 * 60));
    const h = Math.round((minutes % (24 * 60)) / 60);
    return `${d}d${h ? `${h}h` : ""}`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

/** Active Google account email, taken from the freshest agy CLI log. */
export function activeAccountEmail(): string | null {
  try {
    const readdir = (fsMod.readdirSync || fsMod.readdirSync) as (p: string) => string[];
    const read = fsMod.readFileSync as (p: string, enc: string) => string;
    const logDir = `${(process.env.HOME ?? "~")}/.gemini/antigravity-cli/log`;
    const files = readdir(logDir).filter((f: string) => f.startsWith("cli-"));
    files.sort();
    const newest = files[files.length - 1];
    if (!newest) return null;
    const full = read(`${logDir}/${newest}`, "utf8");
    // The auth line lands mid-file — take the LAST email in the log.
    let email: string | null = null;
    for (const m of full.matchAll(/[\w.+-]+@[\w-]+\.[\w.\-]+/g)) {
      email = m[0];
    }
    return email;
  } catch {
    return null;
  }
}
