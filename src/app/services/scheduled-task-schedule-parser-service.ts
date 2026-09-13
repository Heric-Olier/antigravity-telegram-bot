import { execFile } from "node:child_process";
import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import type { ParsedTaskSchedule } from "../types/scheduled-task.js";

/**
 * Schedule parser (agy version).
 *
 * Uses a one-shot agy print run with a JSON schema to turn natural-language
 * schedule text into a structured ParsedTaskSchedule (once or cron).
 */

function agyPrint(prompt: string, directory: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      config.antigravity.bin,
      ["--print", prompt, "--output-format", "json"],
      { cwd: directory, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function parseTaskSchedule(
  scheduleText: string,
  directory: string,
): Promise<ParsedTaskSchedule> {
  logger.info(`[ScheduledTaskScheduleParser] Parsing schedule via agy one-shot: ${scheduleText}`);

  const prompt =
    `You are a schedule parser. Convert the user's schedule request into JSON with ` +
    `these fields: kind ("once"|"cron"). For "once": runAt (ISO 8601), timezone (IANA, default UTC), ` +
    `summary (human readable), nextRunAt (ISO 8601). For "cron": cron.expression, cron.summary, ` +
    `cron.nextRunAt. Use the current time for relative calculations. Schedule request: "${scheduleText}"`;

  const stdout = await agyPrint(prompt, directory);

  const cleaned = stdout.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    throw new Error("Schedule parsing returned invalid JSON from Antigravity");
  }

  const kind = parsed.kind;
  if (kind === "once") {
    const runAt = String(parsed.runAt ?? "");
    if (!runAt) {
      throw new Error("Schedule parsing did not include runAt for a one-time schedule");
    }
    const timezone = String(parsed.timezone ?? "UTC");
    const summary = String(parsed.summary ?? scheduleText);
    const nextRunAt = String(parsed.nextRunAt ?? runAt);
    return { kind: "once", runAt, timezone, summary, nextRunAt };
  }

  if (kind === "cron") {
    const cronField = parsecExpressionField(parsed.cron);
    const expression = String(cronField ?? "");
    if (!expression) {
      throw new Error("Schedule parsing did not include a cron expression");
    }
    const summary = String(parsed.summary ?? scheduleText);
    const nextRunAt = String(parsed.nextRunAt ?? "");
    if (!nextRunAt) {
      throw new Error("Schedule parsing did not include the next cron occurrence");
    }
    const timezone = String(parsed.timezone ?? "UTC");
    return { kind: "cron", cron: expression, timezone, summary, nextRunAt };
  }

  throw new Error("Schedule parsing returned an unknown schedule kind");
}

function parsecExpressionField(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return String(obj.expression ?? "");
  }
  return "";
}
