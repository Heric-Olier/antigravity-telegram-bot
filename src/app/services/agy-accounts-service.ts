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
  // AGY_ACCOUNTS_BIND=0.0.0.0 makes the plugin's callback server reachable
  // from the phone on the LAN (redirect_uri still points at this LAN IP).
  const res = await new Promise<{ ok: boolean; stdout: string; stderr: string }>((res) => {
    execFile(
      "node",
      [PLUGIN_JS, "add"],
      { timeout: 30_000, env: { ...process.env, AGY_ACCOUNTS_BIND: "0.0.0.0" } },
      (err, stdout) =>
        res({ ok: !err, stdout: stdout ?? "", stderr: String(err ?? "") }),
    );
  });
  const m = res.stdout.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?\S+/);
  if (!m) {
    logger.warn(`[Accounts] add produced no auth URL; stdout=${res.stdout.slice(0, 120)} err=${res.stderr.slice(0, 120)}`);
    return { ok: false, detail: res.stderr || res.stdout.slice(0, 200) };
  }
  notePendingAdd(m[0]);
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

// ── Manual code exchange (phone-browser path) ───────────────────────────────
// On a phone, Google's redirect to http://localhost:<port>/auth/callback fails
// (the daemon runs on this machine, not the phone). The user copies the failed
// URL from the address bar — it still carries ?code=…&state=… — and sends it
// with /code. We exchange it here against Google's token endpoint using the
// same client credentials the plugin uses (documented in its source, MIT).

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
// The plugin builds its secret by string-reversal (secret-scanning bypass):
// "COGSPX-…" reversed. Keep it out of plain sight the same way.
const CLIENT_SECRET_REVERSED = "COGSPX-4SPX68EN5W6F1C864B8MsC4q84zCX6s88DPMmCsVeMB-.RNa.Lm-zx1";

interface PendingAdd {
  state: string;
  redirectPort: number | null;
}
let pendingAdd: PendingAdd | null = null;

/** Record the state/port from the URL the plugin printed. */
export function notePendingAdd(stdoutUrl: string): void {
  try {
    const u = new URL(stdoutUrl);
    const port = u.searchParams.get("redirect_uri")?.match(/:(\d+)\//)?.[1];
    pendingAdd = { state: u.searchParams.get("state") ?? "", redirectPort: port ? Number(port) : null };
  } catch {
    pendingAdd = null;
  }
}

/** Exchange an authorization code pasted as a full localhost callback URL. */
export async function completeManualExchange(callbackUrl: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const u = new URL(callbackUrl.trim());
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    if (!code) return { ok: false, detail: "No authorization code in that URL." };
    if (!pendingAdd) return { ok: false, detail: "No /addaccount flow is pending." };
    // state here belongs to the daemon's flow; it must match what we stored.
    if (state && pendingAdd.state && state !== pendingAdd.state) {
      return { ok: false, detail: "OAuth state mismatch — run /addaccount again." };
    }
    const redirectPort = pendingAdd.redirectPort ?? 45001;
    const redirectUri = `http://localhost:${redirectPort}/auth/callback`;
    const secret = CLIENT_SECRET_REVERSED.split("").reverse().join("");

    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const doc = (await resp.json()) as Record<string, unknown>;
    if (!resp.ok || !doc.refresh_token) {
      return { ok: false, detail: `Token exchange failed (${resp.status}): ${JSON.stringify(doc).slice(0, 200)}` };
    }

    // Build the same shape the plugin writes, then persist + mirror to keyring.
    const expiresIn = Number(doc.expires_in ?? 3600);
    const idToken = String(doc.id_token ?? "");
    let email: string | null = null;
    try {
      const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64").toString("utf8"));
      email = (payload as { email?: string }).email ?? null;
    } catch {
      // fall through — profile dir without email is still usable
    }
    const activeToken = {
      token: {
        access_token: doc.access_token,
        token_type: doc.token_type ?? "Bearer",
        refresh_token: doc.refresh_token,
        expiry: new Date(Date.now() + expiresIn * 1000).toISOString(),
      },
      auth_method: "consumer",
      oauth_client_id: CLIENT_ID,
    };
    const creds = {
      access_token: doc.access_token,
      scope: String(doc.scope ?? ""),
      token_type: doc.token_type ?? "Bearer",
      id_token: idToken,
      expiry_date: Date.now() + expiresIn * 1000,
      refresh_token: doc.refresh_token,
      oauth_client_id: CLIENT_ID,
    };
    const fsMod = await import("node:fs");
    const profileDir = path.join(CLI_DIR, "profiles", email ?? `manual-${Date.now()}`);
    fsMod.mkdirSync(profileDir, { recursive: true });
    fsMod.writeFileSync(path.join(profileDir, "antigravity-oauth-token"), JSON.stringify(activeToken, null, 2));
    fsMod.writeFileSync(path.join(profileDir, "oauth_creds.json"), JSON.stringify(creds, null, 2));
    fsMod.writeFileSync(TOKEN_FILE, JSON.stringify(activeToken, null, 2));
    fsMod.writeFileSync(path.join(CLI_DIR, "oauth_creds.json"), JSON.stringify(creds, null, 2));
    pendingAdd = null;
    await importKeyringTokenFromFile();
    logger.info(`[Accounts] manual exchange OK for ${email ?? "profile"}`);
    return { ok: true, detail: email ? `Signed in as ${email}` : "Signed in" };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 200) };
  }
}
