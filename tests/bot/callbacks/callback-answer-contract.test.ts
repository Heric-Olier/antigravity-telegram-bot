import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CALLBACKS_DIR = path.resolve(__dirname, "../../../src/bot/callbacks");

const ANSWER_PATTERN =
  /\b(?:answerCallbackQuery|notify|alert|failure|cancelMenu|cancelPrompt)\s*\(/;
const RETURN_FALSE_PATTERN = /^\s*return false;/;

// How far after an answer a `return false` still belongs to the same branch.
const LOOKAHEAD_LINES = 3;

interface Violation {
  file: string;
  answerLine: number;
  returnLine: number;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];

  for (const fileName of fs.readdirSync(CALLBACKS_DIR)) {
    if (!fileName.endsWith(".ts")) {
      continue;
    }

    const lines = fs.readFileSync(path.join(CALLBACKS_DIR, fileName), "utf8").split("\n");

    lines.forEach((line, index) => {
      if (!ANSWER_PATTERN.test(line)) {
        return;
      }

      for (let offset = 1; offset <= LOOKAHEAD_LINES; offset += 1) {
        const candidate = lines[index + offset];
        if (candidate === undefined) {
          break;
        }
        if (RETURN_FALSE_PATTERN.test(candidate)) {
          violations.push({
            file: fileName,
            answerLine: index + 1,
            returnLine: index + offset + 1,
          });
          break;
        }
      }
    });
  }

  return violations;
}

/**
 * Rule 5: a handler that answered the callback must return `true`. Returning
 * `false` makes the router treat the callback as unhandled and answer a second
 * time, which Telegram rejects with a 400.
 */
describe("callback answer contract", () => {
  it("never returns false right after answering a callback", () => {
    const violations = findViolations().map(
      ({ file, answerLine, returnLine }) =>
        `${file}: answered at line ${answerLine}, returns false at line ${returnLine}`,
    );

    expect(violations, "handlers that answer and then return false").toEqual([]);
  });
});
