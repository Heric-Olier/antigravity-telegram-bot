import { execFile } from "node:child_process";
import { extractErrorMessage } from "../../utils/opencode-error.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import type { ScheduledTask, ScheduledTaskExecutionResult } from "../types/scheduled-task.js";

/**
 * Scheduled task execution (agy version).
 *
 * v1 runs the task as a one-shot agy print run in the project directory
 * (fresh conversation — satisfies unattended execution). Interactive
 * permission requests cannot be answered unattended, so yolo mode is used
 * when enabled (default) and the run is logged otherwise.
 */

export class ScheduledTaskInteractiveRequestError extends Error {
  constructor(kind: string) {
    super(`Scheduled tasks require an interactive ${kind}, which the Antigravity backend cannot run unattended`);
    this.name = "ScheduledTaskInteractiveRequestError";
  }
}

export class ScheduledTaskEmptyAssistantResponseError extends Error {
  constructor() {
    super("Scheduled task finished without an assistant response");
    this.name = "ScheduledTaskEmptyAssistantResponseError";
  }
}

let cachedTimeoutMs: number | null = null;

export async function executeScheduledTask(
  task: ScheduledTask,
): Promise<ScheduledTaskExecutionResult> {
  const startedAt = new Date().toISOString();
  const projectDir = task.projectWorktree || config.antigravity.workspaceDir;

  logger.info(`[ScheduledTaskExecutor] Running agy one-shot for taskId=${task.id} in ${projectDir}`);

  const args = ["--print", task.prompt, "--output-format", "json"];
  const maxMs = getExecutionTimeoutMs();

  try {
    const resultText = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        config.antigravity.bin,
        args,
        { cwd: projectDir, timeout: maxMs > 0 ? maxMs : undefined, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout);
        },
      );
      child.stdin?.end();
    });

    let response = resultText.trim();
    if (!response) {
      throw new ScheduledTaskEmptyAssistantResponseError();
    }
    // --print with --output-format json returns a JSON envelope {response,...}
    try {
      const parsed = JSON.parse(response) as { response?: string };
      if (typeof parsed.response === "string") {
        response = parsed.response.trim();
      }
    } catch {
      // plain text output — keep as-is
    }
    if (!response) {
      throw new ScheduledTaskEmptyAssistantResponseError();
    }

    return {
      taskId: task.id,
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      resultText: response,
      errorMessage: null,
    };
  } catch (err) {
    logger.error(`[ScheduledTaskExecutor] agy one-shot failed for taskId=${task.id}:`, err);
    return {
      taskId: task.id,
      status: "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      resultText: null,
      errorMessage: extractErrorMessage(err),
    };
  }
}

export function getExecutionTimeoutMs(): number {
  if (cachedTimeoutMs === null) {
    cachedTimeoutMs = config.bot.scheduledTaskExecutionTimeoutMinutes * 60_000;
  }
  return cachedTimeoutMs;
}
