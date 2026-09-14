import { spawn, execFile } from "node:child_process";
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
 */
export function startAccountSwitch(): Promise<SwitchHandle> {
  return new Promise((resolve) => {
    killLiveAgy(() => {
      // backup is async by design: it needs the outfile path and must run
      // BEFORE delete wipes the items (the switch flow never restores the
      // old token anyway — it just snapshots it for safety).
      const backupDir = path.join(os.homedir(), ".config", "antigravity-telegram-bot", "account-backups");
      const backupFile = path.join(backupDir, `agy-backup-${Date.now()}.json`);
      void execHelper("backup", backupFile);
      void execHelper("delete");

      const child = spawn("script", ["-qec", config.antigravity.bin, "/dev/null"], {
        cwd: config.antigravity.workspaceDir,
      });

      const handle = new SwitchHandleImpl(child);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => handle.feed(chunk));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => handle.feedErr(chunk));
      child.on("exit", (code_) => handle.closed(code_ ?? 0));

      // agy needs a beat to boot and print the selection menu/URL.
      setTimeout(() => resolve(handle), 8_000);
      logger.info("[Switch] started (backup+delete done, pty spawned)");
    });
  });
}

function killLiveAgy(done: () => void): void {
  execFile("pgrep", ["-f", "agy --print="], (err, stdout) => {
    const pids = (stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
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
      logger.info(`[Switch] helper ${cmd}: ${(stdout || String(err)).slice(0, 140)}`);
      res(stdout ?? "");
    });
  });
}

class SwitchHandleImpl implements SwitchHandle {
  authUrl: string | null = null;
  private buffer = "";
  private submitted = false;
  private cbs: Array<(ok: boolean, detail: string) => void> = [];
  private exitedOnce = false;

  constructor(private readonly child: ReturnType<typeof spawn>) {}

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
    this.child.stdin?.write(`${code.trim()}\n`);
  }

  onFinish(cb: (ok: boolean, detail: string) => void): void {
    this.cbs.push(cb);
  }

  closed(exitCode: number): void {
    if (this.exitedOnce) return;
    this.exitedOnce = true;
    const ok = exitCode === 0 && /sign\s*in|logged|gemini/i.test(this.buffer);
    for (const cb of this.cbs) cb(ok, this.buffer.slice(-500));
  }

  abort(): void {
    try {
      this.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}
