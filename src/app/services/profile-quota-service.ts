import { exec, execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { logger } from "../../utils/logger.js";

/**
 * Per-profile quota probing without touching the live agy session.
 *
 * Uses the token-file swap trick: `agy -p /usage` reads whatever token file is
 * on disk, so for each saved profile we temporarily install that profile's
 * token, run the usage probe, parse the four buckets, and restore the
 * original token. Probes run sequentially (swaps are not concurrency-safe).
 */

const CLI_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli");
const TOKEN_FILE = path.join(CLI_DIR, "antigravity-oauth-token");
const CREDS_FILE = path.join(os.homedir(), ".gemini", "oauth_creds.json");
const AGY_BIN = process.env.AGY_BIN ?? "/var/home/bazzite/.local/bin/agy";

export interface QuotaBucket {
  label: string; // e.g. "Gemini Models — Weekly"
  pct: number; // 0-100 remaining
  resetIso: string | null; // when it fully refreshes
}

export interface ProfileQuota {
  email: string;
  ok: boolean;
  buckets: QuotaBucket[];
  detail?: string;
}

export function listProfileDirs(): Array<{ email: string; dir: string }> {
  const root = path.join(CLI_DIR, "profiles");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => statSync(path.join(root, n)).isDirectory())
    .map((n) => ({ email: n, dir: path.join(root, n) }));
}

const UNSAFE_EMAIL = /[^A-Za-z0-9._@+-]/;

function probeProfile(dir: string): Promise<ProfileQuota> {
  return new Promise((resolve) => {
    const email = path.basename(dir);
    if (UNSAFE_EMAIL.test(email)) {
      resolve({ email, ok: false, buckets: [], detail: "unsafe profile name" });
      return;
    }
    // Shell script: install profile token, probe, restore, and stamp completion.
    const script = [
      "set -e",
      `PROFILE=${JSON.stringify(dir)}`,
      `mkdir -p /tmp/agy-quota-probe`,
      `cp ${JSON.stringify(TOKEN_FILE)} /tmp/agy-quota-probe/ 2>/dev/null || true`,
      `[ -f ${JSON.stringify(CREDS_FILE)} ] && cp ${JSON.stringify(CREDS_FILE)} /tmp/agy-quota-probe/ || true`,
      `cp "$PROFILE/antigravity-oauth-token" ${JSON.stringify(TOKEN_FILE)}`,
      `if [ -f "$PROFILE/oauth_creds.json" ]; then cp "$PROFILE/oauth_creds.json" ${JSON.stringify(CREDS_FILE)}; fi`,
      `timeout 30 ${JSON.stringify(AGY_BIN)} -p /usage 2>&1 | head -4`,
      `cp /tmp/agy-quota-probe/antigravity-oauth-token ${JSON.stringify(TOKEN_FILE)} 2>/dev/null || true`,
      `[ -f /tmp/agy-quota-probe/oauth_creds.json ] && cp /tmp/agy-quota-probe/oauth_creds.json ${JSON.stringify(CREDS_FILE)} || true`,
      "echo PROBE_DONE",
    ].join("\n");

    execFile("/bin/bash", ["-c", script], { timeout: 60_000 }, (probeError, stdout) => {
      void existsSync(TOKEN_FILE);
      const text = stdout ?? "";
      if (probeError || !text.includes("PROBE_DONE") || !text.includes("%")) {
        resolve({ email: path.basename(dir), ok: false, buckets: [], detail: text.slice(-200) || String(probeError) });
        return;
      }
      const buckets: QuotaBucket[] = [];
      for (const line of text.split("\n")) {
        const m = line.match(/^(.*?)\t(Weekly|Five Hour) Limit Remaining\t(\d+)%\t(.*)$/);
        if (!m || !m[1] || !m[2] || !m[3]) continue;
        buckets.push({
          label: `${m[1].trim()} — ${m[2]}`,
          pct: Number(m[3]),
          resetIso: m[4]?.trim() || null,
        });
      }
      resolve({ email: path.basename(dir), ok: buckets.length > 0, buckets });
    });
  });
}

/** Probe all saved profiles sequentially. */
export async function quotaAllProfiles(): Promise<ProfileQuota[]> {
  const dirs = listProfileDirs();
  mkdirSync("/tmp/agy-quota-probe", { recursive: true });
  const out: ProfileQuota[] = [];
  for (const { email, dir } of dirs) {
    logger.info(`[QuotaAll] probing ${email}`);
    out.push(await probeProfile(dir));
  }
  return out;
}

/** Is an interactive agy turn process alive? (warn-print only, not enforced) */
export function agyBusy(): Promise<boolean> {
  return new Promise((res) => {
    exec("pgrep -fa 'agy --print=' | head -1", (_err, stdout) =>
      res(Boolean(stdout && stdout.trim().length > 0)),
    );
  });
}
