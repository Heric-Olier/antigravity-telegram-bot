export const AGENT_MODE_BUTTON_TEXT_PATTERN = /^(📋|🛠️|💬|🔍|📝|📄|📦|🤖)\s.+\s(?:Mode|Agent)$/;

export const MODEL_BUTTON_TEXT_PATTERN = /^🧠\s(?!.*\s(?:Mode|Agent)$)[\s\S]+$/;

// Keep support for both legacy "💭" and current "💡" prefix.
// Quota badge button (🟢/🟡/🔴 + "5h"/"sem") — routes to /usage.
export const VARIANT_BUTTON_TEXT_PATTERN = /^(?:💡|💭|[🟢🟡🔴])\s?[\s\S]+$/;
export const ACCOUNT_BUTTON_TEXT_PATTERN = /^🔁\s([\s\S]+)$/;

export const CONTEXT_BUTTON_TEXT_PATTERN = /^(?:📊|[🟢🟡🔴]sem )(?:(?:.|\n)*)$/;

export const QUEUED_PROMPT_BUTTON_TEXT_PATTERN = /^❌\s\d+\.\s/;

const REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS = [
  ACCOUNT_BUTTON_TEXT_PATTERN,
  AGENT_MODE_BUTTON_TEXT_PATTERN,
  MODEL_BUTTON_TEXT_PATTERN,
  VARIANT_BUTTON_TEXT_PATTERN,
  CONTEXT_BUTTON_TEXT_PATTERN,
  QUEUED_PROMPT_BUTTON_TEXT_PATTERN,
];

/**
 * Whether the text looks like a press on one of the reply-keyboard buttons
 * rather than a prompt the user typed.
 */
export function isReplyKeyboardButtonText(text: string): boolean {
  return REPLY_KEYBOARD_BUTTON_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}
