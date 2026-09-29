import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

const helperPy = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/agy-keyring-helper.py",
);
const PY = "/usr/bin/python3";

export interface SwitchHandle {
  authUrl: string | null;
  submitCode(code: string): void;
  abort(): void;
  onFinish(cb: (ok: boolean, detail: string) => void): void;
}

/**
 * Account switching via agy's own SSH-style OAuth flow (official Google
 * material end to end):
 *  1. kill live agy processes (they hold the token in memory)
 *  2. backup + delete the keyring item (helper script, libsecret)
 *  3. spawn `script -qec agy /dev/null` — real pty; agy prints "Select login
 *     method:" then the authorization URL
 *  4. URL goes to Telegram; the user opens it with the destination account
 *  5. user pastes the code into the chat; we write it into the pty
 *  6. agy stores the new token in the keyring
 *
 * The bot UI no longer routes users here (the account menu / agy-accounts
 * plugin flow replaced the pty flow), but this module stays hardened: every
 * child failure is reported through the handle instead of escaping as an
 * uncaught exception. Historical bug (2026-09-28): a bare `spawn("script")`
 * without an 'error' listener crashed the whole bot on ENOENT.
 */
export function startAccountSwitch(): Promise<SwitchHandle> {
  return new Promise((resolve) => {
    killLiveAgy(() => {
      void (async () => {
        // Safety snapshot FIRST and verified — the delete must never run
        // without a backup (it used to race: `void` backup + `void` delete,
        // so the delete won and the snapshot was lost/empty).
        const backupDir = path.join(
          os.homedir(),
          ".config",
          "antigravity-telegram-bot",
          "account-backups",
        );
        const backupFile = path.join(backupDir, `agy-backup-${Date.now()}.json`);
        const backup = await execHelper("backup", backupFile);
        if (!/"ok"\s*:\s*true/.test(backup)) {
          logger.warn(
            `[Switch] keyring backup did not succeed — aborting before delete: ${backup.slice(0, 200)}`,
          );
          resolve(SwitchHandleImpl.failed(`keyring backup failed: ${backup.slice(0, 300)}`));
          return;
        }
        const deleted = await execHelper("delete");
        logger.info(`[Switch] keyring delete result: ${deleted.slice(0, 140)}`);

        const ptyBin = resolvePtyBin();
        let child: ReturnType<typeof spawn> | null = null;
        try {
          child = spawn(ptyBin, ["-qec", config.antigravity.bin, "/dev/null"], {
            cwd: config.antigravity.workspaceDir,
          });
        } catch (error) {
          logger.error("[Switch] pty spawn threw synchronously", error);
          resolve(SwitchHandleImpl.failed(`pty spawn failed: ${String(error)}`));
          return;
        }

        const handle = new SwitchHandleImpl(child);
        // A spawn failure ("script" missing / EACCES / ...) arrives ASYNC as
        // an 'error' event: without this listener it becomes an
        // uncaughtException and takes the whole bot process down.
        child.on("error", (error) => {
          logger.error("[Switch] pty spawn error", error);
          handle.fail(`pty spawn failed: ${error.message}`);
        });
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => handle.feed(chunk));
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => handle.feedErr(chunk));
        child.on("exit", (exitCode) => handle.closed(exitCode ?? 0));

        // agy needs a beat to boot and print the selection menu/URL.
        setTimeout(() => resolve(handle), 8_000);
        logger.info(
          `[Switch] started (backup verified, keyring deleted, pty spawned via ${ptyBin})`,
        );
      })();
    });
  });
}

/**
 * `script` is resolved by absolute path when possible: bare-name resolution
 * depends on the service PATH, and the systemd user manager can boot without
 * Linuxbrew (its only source on this machine — `/usr/bin/script` does not
 * exist in Bazzite) before the graphical session import lands. Last resort is
 * the plain PATH lookup, guarded by the child 'error' handler above.
 */
function resolvePtyBin(): string {
  const candidates = [
    process.env.AGY_PTY_BIN,
    "/usr/bin/script",
    "/home/linuxbrew/.linuxbrew/bin/script",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // try the next candidate
    }
  }
  return "script";
}

function killLiveAgy(done: () => void): void {
  execFile("pgrep", ["-f", "agy --print="], (err, stdout) => {
    const pids = (stdout ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (pids.length === 0 || (err && !stdout)) {
      done();
      return;
    }
    let pending = pids.length;
    for (const pid of pids) {
      execFile("kill", ["-TERM", pid], () => {
        if (--pending === 0) {
          setTimeout(done, 800);
        }
      });
    }
  });
}

function execHelper(cmd: string, arg?: string): Promise<string> {
  return new Promise((res) => {
    const args = [helperPy, cmd];
    if (arg) args.push(arg);
    execFile(PY, args, { timeout: 20_000 }, (err, stdout) => {
      const output = stdout || (err ? String(err) : "");
      logger.info(`[Switch] helper ${cmd}: ${output.slice(0, 140)}`);
      res(output);
    });
  });
}

// Exported for tests: the failure paths here are the crash-prevention
// contract — a failed switch must always surface through onFinish(cb).
export class SwitchHandleImpl implements SwitchHandle {
  authUrl: string | null = null;
  private buffer = "";
  private submitted = false;
  private cbs: Array<(ok: boolean, detail: string) => void> = [];
  private finishResult: { ok: boolean; detail: string } | null = null;
  private failureDetail: string | null = null;

  /** A handle for a switch that failed before it could start. */
  static failed(reason: string): SwitchHandleImpl {
    const handle = new SwitchHandleImpl(null);
    handle.fail(reason);
    return handle;
  }

  constructor(private readonly child: ReturnType<typeof spawn> | null) {}

  fail(reason: string): void {
    this.failureDetail = reason;
    this.finish(false);
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    if (this.authUrl) return;
    const m = this.buffer.match(/https:\S+/);
    if (m) {
      this.authUrl = m[0].replace(/[\p{Cc}]/gu, "");
      logger.info(`[Switch] auth URL captured: ${this.authUrl.slice(0, 80)}`);
      this.buffer = "";
    }
  }

  feedErr(chunk: string): void {
    logger.debug(`[Switch] agy stderr: ${chunk.slice(0, 200)}`);
  }

  submitCode(code: string): void {
    if (this.submitted) return;
    this.submitted = true;
    logger.info("[Switch] submitting auth code to agy pty");
    this.child?.stdin?.write(`${code.trim()}\n`);
  }

  onFinish(cb: (ok: boolean, detail: string) => void): void {
    if (this.finishResult) {
      cb(this.finishResult.ok, this.finishResult.detail);
      return;
    }
    this.cbs.push(cb);
  }

  closed(exitCode: number): void {
    const ok = exitCode === 0 && /sign\s*in|logged|gemini/i.test(this.buffer);
    this.finish(ok);
  }

  abort(): void {
    try {
      this.child?.kill("SIGKILL");
    } catch {
      // ignore
    }
  }

  private finish(ok: boolean): void {
    if (this.finishResult) return;
    this.finishResult = { ok, detail: this.failureDetail ?? this.buffer.slice(-500) };
    for (const cb of this.cbs) {
      cb(this.finishResult.ok, this.finishResult.detail);
    }
    this.cbs = [];
  }
}
