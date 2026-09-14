/**
 * Rolling context-size tracker from agy step usage events.
 *
 * agy reports per-step usage {input_tokens, cache_read_tokens,...}; the
 * conversation context ≈ the largest (input + cache_read) seen in the active
 * conversation. Reset on /new or session switch.
 */
const LIMIT = 1_000_000;

let used = 0;

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
  if (total > used) used = total;
}

export function getContextUsed(): number {
  return used;
}

export function getContextLimit(): number {
  return LIMIT;
}

export function resetContextUsage(): void {
  used = 0;
}
