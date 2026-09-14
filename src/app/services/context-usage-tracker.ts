/**
 * Rolling context-size tracker from agy step usage events.
 *
 * agy reports per-step usage {input_tokens, cache_read_tokens,...}; the
 * conversation context ≈ the largest (input + cache_read) seen in the active
 * conversation. Reset on /new or session switch.
 */
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const LIMIT = 1_000_000;
const PERSIST_PATH = join(process.env.OPENCODE_TELEGRAM_HOME ?? (join(homedir(), ".config", "antigravity-telegram-bot")), "context-usage.json");

let used = 0;

function loadPersisted(): void {
  try {
    used = (JSON.parse(readFileSync(PERSIST_PATH, "utf8")) as { used?: number }).used ?? 0;
  } catch {
    used = 0;
  }
}

loadPersisted();

function persist(): void {
  try {
    mkdirSync(dirname(PERSIST_PATH), { recursive: true });
    writeFileSync(PERSIST_PATH, JSON.stringify({ used }));
  } catch {
    // best-effort
  }
}

export function noteStepUsage(
  u:
    | {
        input_tokens?: number | undefined;
        cache_read_tokens?: number | undefined;
      }
    | undefined,
): void {
  if (!u) return;
  const total = (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0);
  if (total > used) {
    used = total;
    persist();
  }
}

export function getContextUsed(): number {
  return used;
}

export function getContextLimit(): number {
  return LIMIT;
}

export function resetContextUsage(): void {
  used = 0;
  persist();
}
