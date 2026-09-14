import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { logger } from "../../utils/logger.js";

/**
 * Account management via the agy-accounts plugin
 * (https://github.com/billythekidz/agy-accounts, MIT).
 *
 * The plugin keeps one profile per Google account under
 * ~/.gemini/antigravity-cli/profiles/<email>/ and swaps the active token by
 * writing the profile's token to ~/.gemini/antigravity-cli/antigravity-oauth-token
 * (plus ~/.gemini/oauth_creds.json). The next agy process picks the token up.
 *
 * Token lifecycle on Linux: agy holds the ACTIVE token in the OS keyring
 * (service=gemini, username=antigravity), not in the token file, so a
 * keyring→file export is needed once so the plugin can auto-save the active
 * profile. After that, switching never needs the TUI or a re-login.
 */

const PLUGIN_DIR = "/home/bazzite/.gemini/config/plugins/agy-accounts";
const PLUGIN_JS = process.env.AGY_ACCOUNTS_PLUGIN ?? path.join(PLUGIN_DIR, "index.js");
const CLI_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli");
const TOKEN_FILE = path.join(CLI_DIR, "antigravity-oauth-token");
const KEYRING_HELPER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/agy-keyring-helper.py",
);
const PY = "/usr/bin/python3";

export function execRun(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) =>
      res({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? String(err ?? "") }),
    );
  });
}

/** One-time bridge: export the keyring token to the token file the plugin reads. */
export async function exportKeyringTokenToFile(): Promise<boolean> {
  const bak = await execRun(PY, [KEYRING_HELPER, "backup", path.join(CLI_DIR, "antigravity-oauth-token.keyring-export.json")]);
  if (!bak.ok || !/"ok": true/.test(bak.stdout)) {
    logger.warn(`[Accounts] keyring backup failed: ${bak.stderr.slice(0, 120)}`);
    return false;
  }
  // Convert backup file { items: [{secret_b64, attrs}...] } to token json
  try {
    const doc = JSON.parse(readFileSync(path.join(CLI_DIR, "antigravity-oauth-token.keyring-export.json"), "utf8"));
    const rec = (doc.items ?? [])[0];
    if (!rec) return false;
    const secret = Buffer.from(rec.secret_b64, "base64").toString("utf8");
    const token = JSON.parse(secret);
    writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
    return true;
  } catch (e) {
    logger.warn(`[Accounts] token conversion failed: ${String(e).slice(0, 120)}`);
    return false;
  }
}

/** List saved profiles (emails) and the active one, via the plugin CLI. */
export async function listAccounts(): Promise<{ active: string | null; profiles: string[] }> {
  const res = await execRun("node", [PLUGIN_JS, "list"]);
  const out = res.stdout;
  const active = out.match(/★ \[ACTIVE\] ([\w.+-]+@[\w.-]+)/)?.[1] ?? null;
  const profiles = [...out.matchAll(/\[(?:ACTIVE|INACTIVE)\] ([\w.+-]+@[\w.-]+)/g)].map((m) => m[1] as string);
  return { active, profiles };
}

/**
 * Start the "add account" OAuth flow. Returns the auth URL for the user to
 * open in a browser. The plugin's daemon catches the redirect on localhost,
 * exchanges the code and activates the profile automatically.
 */
export async function startAddAccount(): Promise<{ ok: boolean; authUrl?: string; detail?: string }> {
  // Must run detached-with-wait: the CLI spawns the daemon then prints the URL.
  const res = await new Promise<{ ok: boolean; stdout: string; stderr: string }>((res) => {
    execFile(
      "node",
      [PLUGIN_JS, "add"],
      { timeout: 30_000 },
      (err, stdout) =>
        res({ ok: !err, stdout: stdout ?? "", stderr: String(err ?? "") }),
    );
  });
  const m = res.stdout.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?\S+/);
  if (!m) {
    logger.warn(`[Accounts] add produced no auth URL; stdout=${res.stdout.slice(0, 120)} err=${res.stderr.slice(0, 120)}`);
    return { ok: false, detail: res.stderr || res.stdout.slice(0, 200) };
  }
  return { ok: true, authUrl: m[0] };
}

/** Switch the active account to a saved profile email. */
export async function switchToAccount(email: string): Promise<{ ok: boolean; detail: string }> {
  const res = await execRun("node", [PLUGIN_JS, "set", email], 60_000);
  if (!res.ok) {
    return { ok: false, detail: res.stderr || res.stdout.slice(0, 300) };
  }
  // The plugin wrote the token file for the new account; mirror it into the
  // keyring so `agy` (which reads service=gemini) picks it up.
  await importKeyringTokenFromFile();
  return { ok: true, detail: res.stdout.slice(0, 300) };
}

/** Write the active token file content into the OS keyring (agy provisioning). */
async function importKeyringTokenFromFile(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "agy-sw-"));
  const secretPath = path.join(dir, "secret.txt");
  try {
    const token = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
    writeFileSync(secretPath, JSON.stringify(token), { mode: 0o600 });
    // Restore from the temp file using the helper (attrs service=gemini)
    await execRun(PY, [KEYRING_HELPER, "delete"], 15_000);
    await execRun(PY, [KEYRING_HELPER, "restore", secretPath], 15_000);
    logger.info("[Accounts] active token mirrored into keyring");
  } catch (e) {
    logger.error(`[Accounts] keyring mirror failed: ${String(e).slice(0, 160)}`);
  }
}
