import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { getRuntimePaths, type RuntimePaths } from "./paths.js";
import {
  getLocale,
  getLocaleOptions,
  resolveSupportedLocale,
  setRuntimeLocale,
  t,
  type Locale,
} from "../i18n/index.js";

interface EnvValidationResult {
  isValid: boolean;
  reason?: string | undefined;
}

interface WizardCollectedValues {
  locale: Locale;
  token: string;
  allowedUserId: string;
}

export interface WizardEnvValues {
  BOT_LOCALE: Locale;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ALLOWED_USER_ID: string;
}

interface ParsedEnvAssignmentLine {
  key: string;
  rawValue: string;
  line: string;
  isCommented: boolean;
}

const WIZARD_ENV_KEYS: ReadonlyArray<keyof WizardEnvValues> = [
  "BOT_LOCALE",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_ID",
];

function isPositiveInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

export function validateRuntimeEnvValues(values: Record<string, string>): EnvValidationResult {
  if (!values.TELEGRAM_BOT_TOKEN || values.TELEGRAM_BOT_TOKEN.trim().length === 0) {
    return { isValid: false, reason: "Missing TELEGRAM_BOT_TOKEN" };
  }

  if (!isPositiveInteger(values.TELEGRAM_ALLOWED_USER_ID || "")) {
    return { isValid: false, reason: "Invalid TELEGRAM_ALLOWED_USER_ID" };
  }

  return { isValid: true };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeEnvLineEndings(content: string): string[] {
  const lines = content.split(/\r?\n/).map((line) => line.replace(/\r$/, ""));

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function removeEnvKey(lines: string[], key: string): string[] {
  const regex = new RegExp(`^\\s*(?:export\\s+)?${escapeRegex(key)}\\s*=`);
  return lines.filter((line) => !regex.test(line));
}

function parseEnvAssignmentLine(line: string): ParsedEnvAssignmentLine | null {
  const match = /^(\s*#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
  if (!match) {
    return null;
  }

  const key = match[2];
  const rawValue = match[3];
  if (key === undefined || rawValue === undefined) {
    return null;
  }
  return {
    key,
    rawValue,
    line,
    isCommented: typeof match[1] === "string",
  };
}

function buildTemplateKeySet(templateContent: string): Set<string> {
  const keys = new Set<string>();

  for (const line of normalizeEnvLineEndings(templateContent)) {
    const parsedLine = parseEnvAssignmentLine(line);
    if (parsedLine !== null) {
      keys.add(parsedLine.key);
    }
  }

  return keys;
}

function collectActiveEnvAssignments(content: string): Map<string, ParsedEnvAssignmentLine> {
  const assignments = new Map<string, ParsedEnvAssignmentLine>();

  for (const line of normalizeEnvLineEndings(content)) {
    const parsedLine = parseEnvAssignmentLine(line);
    if (parsedLine === null || parsedLine.isCommented) {
      continue;
    }

    assignments.set(parsedLine.key, parsedLine);
  }

  return assignments;
}

function collectCustomEnvAssignments(existingContent: string, templateKeys: Set<string>): string[] {
  const customAssignments: ParsedEnvAssignmentLine[] = [];
  const seenKeys = new Set<string>();

  const lines = normalizeEnvLineEndings(existingContent);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const parsedLine = parseEnvAssignmentLine(line);
    if (parsedLine === null || parsedLine.isCommented || templateKeys.has(parsedLine.key)) {
      continue;
    }

    if (seenKeys.has(parsedLine.key)) {
      continue;
    }

    seenKeys.add(parsedLine.key);
    customAssignments.push(parsedLine);
  }

  return customAssignments.reverse().map((assignment) => assignment.line);
}

function renderEnvAssignment(key: string, rawValue: string): string {
  return `${key}=${rawValue}`;
}

function finalizeEnvContent(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function buildFlatEnvFileContent(existingContent: string, values: WizardEnvValues): string {
  let lines = normalizeEnvLineEndings(existingContent);

  const orderedUpdates: Array<[keyof WizardEnvValues, string | undefined]> = [
    ["BOT_LOCALE", values.BOT_LOCALE],
    ["TELEGRAM_BOT_TOKEN", values.TELEGRAM_BOT_TOKEN],
    ["TELEGRAM_ALLOWED_USER_ID", values.TELEGRAM_ALLOWED_USER_ID],
  ];

  for (const [key, value] of orderedUpdates) {
    lines = removeEnvKey(lines, key);

    if (value && value.trim().length > 0) {
      lines.push(`${key}=${value}`);
    }
  }

  return finalizeEnvContent(lines);
}

export function buildEnvFileContent(
  existingContent: string,
  values: WizardEnvValues,
  envExampleContent?: string | null,
): string {
  if (!envExampleContent) {
    return buildFlatEnvFileContent(existingContent, values);
  }

  const templateLines = normalizeEnvLineEndings(envExampleContent);
  if (templateLines.length === 0) {
    return buildFlatEnvFileContent(existingContent, values);
  }

  const templateKeys = buildTemplateKeySet(envExampleContent);
  const existingAssignments = collectActiveEnvAssignments(existingContent);
  const wizardOverrides = new Map<string, string | undefined>(
    WIZARD_ENV_KEYS.map((key) => [key, values[key]]),
  );

  const renderedLines = templateLines.map((line) => {
    const parsedLine = parseEnvAssignmentLine(line);
    if (parsedLine === null) {
      return line;
    }

    if (wizardOverrides.has(parsedLine.key)) {
      const overrideValue = wizardOverrides.get(parsedLine.key);
      if (overrideValue && overrideValue.trim().length > 0) {
        return renderEnvAssignment(parsedLine.key, overrideValue);
      }

      return line;
    }

    const existingAssignment = existingAssignments.get(parsedLine.key);
    if (existingAssignment !== undefined) {
      return renderEnvAssignment(parsedLine.key, existingAssignment.rawValue);
    }

    return line;
  });

  const customAssignments = collectCustomEnvAssignments(existingContent, templateKeys);
  if (customAssignments.length > 0) {
    if (renderedLines.length > 0 && renderedLines[renderedLines.length - 1] !== "") {
      renderedLines.push("");
    }

    renderedLines.push(...customAssignments);
  }

  return finalizeEnvContent(renderedLines);
}

async function readEnvFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tempFilePath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempFilePath, content, "utf-8");
  await fs.rename(tempFilePath, filePath);
}

function getEnvExamplePath(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFilePath), "..", "..", ".env.example");
}

async function loadEnvExampleContent(): Promise<string | null> {
  try {
    return await fs.readFile(getEnvExamplePath(), "utf-8");
  } catch {
    return null;
  }
}

async function askVisible(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const maskedRl = rl as readline.Interface & {
      stdoutMuted?: boolean;
      _writeToOutput?: (value: string) => void;
    };

    maskedRl._writeToOutput = (value: string): void => {
      if (maskedRl.stdoutMuted) {
        if (value.includes("\n") || value.includes("\r")) {
          process.stdout.write(value);
          return;
        }

        if (value.length > 0) {
          process.stdout.write("*");
        }
        return;
      }

      process.stdout.write(value);
    };

    maskedRl.stdoutMuted = false;

    rl.question(question, (answer) => {
      maskedRl.stdoutMuted = false;
      process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });

    maskedRl.stdoutMuted = true;
  });
}

async function askToken(): Promise<string> {
  for (;;) {
    const token = await askHidden(t("runtime.wizard.ask_token"));

    if (!token) {
      process.stdout.write(t("runtime.wizard.token_required"));
      continue;
    }

    if (!token.includes(":")) {
      process.stdout.write(t("runtime.wizard.token_invalid"));
      continue;
    }

    return token;
  }
}

async function askLocale(): Promise<Locale> {
  const localeOptions = getLocaleOptions();
  const defaultLocale = getLocale();
  const defaultLocaleOption =
    localeOptions.find((localeOption) => localeOption.code === defaultLocale) ?? localeOptions[0];
  if (!defaultLocaleOption) {
    return defaultLocale;
  }
  const optionsText = localeOptions
    .map((localeOption, index) => `${index + 1} - ${localeOption.label} (${localeOption.code})`)
    .join("\n");

  const prompt = t("runtime.wizard.ask_language", {
    options: optionsText,
    defaultLocale: `${defaultLocaleOption.label} (${defaultLocaleOption.code})`,
  });

  for (;;) {
    const answer = await askVisible(prompt);

    if (!answer) {
      return defaultLocaleOption.code;
    }

    if (/^\d+$/.test(answer)) {
      const index = Number.parseInt(answer, 10) - 1;
      if (index >= 0 && index < localeOptions.length) {
        const selectedLocale = localeOptions[index];
        if (selectedLocale) {
          return selectedLocale.code;
        }
      }
    }

    const localeByCode = resolveSupportedLocale(answer);
    if (localeByCode) {
      return localeByCode;
    }

    process.stdout.write(t("runtime.wizard.language_invalid"));
  }
}

async function askAllowedUserId(): Promise<string> {
  for (;;) {
    const allowedUserId = await askVisible(t("runtime.wizard.ask_user_id"));

    if (!isPositiveInteger(allowedUserId)) {
      process.stdout.write(t("runtime.wizard.user_id_invalid"));
      continue;
    }

    return allowedUserId;
  }
}

async function collectWizardValues(): Promise<WizardCollectedValues> {
  const locale = await askLocale();
  setRuntimeLocale(locale);
  const selectedLocaleOption =
    getLocaleOptions().find((localeOption) => localeOption.code === locale) ?? null;

  process.stdout.write("\n");
  process.stdout.write(
    t("runtime.wizard.language_selected", {
      language:
        selectedLocaleOption !== null
          ? `${selectedLocaleOption.label} (${selectedLocaleOption.code})`
          : locale,
    }),
  );
  process.stdout.write("\n");
  process.stdout.write(t("runtime.wizard.start"));
  process.stdout.write("\n");

  const token = await askToken();
  const allowedUserId = await askAllowedUserId();

  process.stdout.write("\n");

  return {
    locale,
    token,
    allowedUserId,
  };
}

function ensureInteractiveTty(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(t("runtime.wizard.tty_required"));
  }
}

async function validateExistingEnv(envFilePath: string): Promise<EnvValidationResult> {
  const content = await readEnvFileIfExists(envFilePath);
  const effectiveValues: Record<string, string> = content === null ? {} : dotenv.parse(content);

  for (const key of WIZARD_ENV_KEYS) {
    const processValue = process.env[key];
    if (processValue !== undefined) {
      effectiveValues[key] = processValue;
    }
  }

  return validateRuntimeEnvValues(effectiveValues);
}

async function runWizardAndPersist(runtimePaths: RuntimePaths): Promise<void> {
  ensureInteractiveTty();

  const [existingContent, envExampleContent, wizardValues] = await Promise.all([
    readEnvFileIfExists(runtimePaths.envFilePath),
    loadEnvExampleContent(),
    collectWizardValues(),
  ]);

  const envValues: WizardEnvValues = {
    BOT_LOCALE: wizardValues.locale,
    TELEGRAM_BOT_TOKEN: wizardValues.token,
    TELEGRAM_ALLOWED_USER_ID: wizardValues.allowedUserId,
  };

  const envContent = buildEnvFileContent(existingContent ?? "", envValues, envExampleContent);
  await writeFileAtomically(runtimePaths.envFilePath, envContent);

  process.stdout.write(
    t("runtime.wizard.saved", {
      envPath: runtimePaths.envFilePath,
    }),
  );
}

export async function ensureRuntimeConfigForStart(): Promise<void> {
  const runtimePaths = getRuntimePaths();

  if (runtimePaths.mode !== "installed") {
    return;
  }

  const validationResult = await validateExistingEnv(runtimePaths.envFilePath);
  if (validationResult.isValid) {
    return;
  }

  process.stdout.write(t("runtime.wizard.not_configured_starting"));
  await runWizardAndPersist(runtimePaths);
}

export async function runConfigWizardCommand(): Promise<void> {
  const runtimePaths = getRuntimePaths();
  await runWizardAndPersist(runtimePaths);
}
