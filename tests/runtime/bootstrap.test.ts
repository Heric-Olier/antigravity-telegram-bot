import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEnvFileContent,
  ensureRuntimeConfigForStart,
  validateRuntimeEnvValues,
} from "../../src/runtime/bootstrap.js";
import { t } from "../../src/i18n/index.js";
import { setRuntimeMode } from "../../src/runtime/mode.js";

const ENV_EXAMPLE_CONTENT = fs.readFileSync(path.resolve(process.cwd(), ".env.example"), "utf-8");

describe("runtime/bootstrap", () => {
  it("validates required runtime env values", () => {
    const result = validateRuntimeEnvValues({
      TELEGRAM_BOT_TOKEN: "123456:abcdef",
      TELEGRAM_ALLOWED_USER_ID: "123456789",
    });

    expect(result).toEqual({ isValid: true });
  });

  it("fails validation when the token is missing", () => {
    const result = validateRuntimeEnvValues({
      TELEGRAM_ALLOWED_USER_ID: "123456789",
    });

    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("fails validation for invalid user id", () => {
    const result = validateRuntimeEnvValues({
      TELEGRAM_BOT_TOKEN: "123456:abcdef",
      TELEGRAM_ALLOWED_USER_ID: "0",
    });

    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("TELEGRAM_ALLOWED_USER_ID");
  });

  it("falls back to flat updates when template is unavailable", () => {
    const existingContent = [
      "CUSTOM_FLAG=enabled",
      "BOT_LOCALE=en",
      "TELEGRAM_BOT_TOKEN=old",
      "TELEGRAM_ALLOWED_USER_ID=1",
      "",
    ].join("\n");

    const updated = buildEnvFileContent(existingContent, {
      BOT_LOCALE: "ru",
      TELEGRAM_BOT_TOKEN: "new-token:value",
      TELEGRAM_ALLOWED_USER_ID: "777",
    });

    expect(updated).toContain("CUSTOM_FLAG=enabled");
    expect(updated).toContain("BOT_LOCALE=ru");
    expect(updated).toContain("TELEGRAM_BOT_TOKEN=new-token:value");
    expect(updated).toContain("TELEGRAM_ALLOWED_USER_ID=777");
  });

  it("builds env from template and keeps comments and section order", () => {
    const updated = buildEnvFileContent(
      "",
      {
        BOT_LOCALE: "ru",
        TELEGRAM_BOT_TOKEN: "token:value",
        TELEGRAM_ALLOWED_USER_ID: "42",
      },
      ENV_EXAMPLE_CONTENT,
    );

    expect(updated).toContain("TELEGRAM_BOT_TOKEN=token:value");
    expect(updated).toContain("TELEGRAM_ALLOWED_USER_ID=42");
    expect(updated).toContain("BOT_LOCALE=ru");

    expect(updated.indexOf("# Telegram Bot Token (from @BotFather)")).toBeLessThan(
      updated.indexOf("TELEGRAM_BOT_TOKEN=token:value"),
    );
    expect(updated.indexOf("# Bot locale: supported locale code (default: en)")).toBeLessThan(
      updated.indexOf("BOT_LOCALE=ru"),
    );
  });

  it("preserves existing values for template keys outside the wizard", () => {
    const existingContent = [
      "LOG_LEVEL=debug",
      "CUSTOM_FEATURE_FLAG=true",
      "OPEN_BROWSER_ROOTS=C:/Repos, D:/Work",
      "",
    ].join("\n");

    const updated = buildEnvFileContent(
      existingContent,
      {
        BOT_LOCALE: "en",
        TELEGRAM_BOT_TOKEN: "token:value",
        TELEGRAM_ALLOWED_USER_ID: "42",
      },
      ENV_EXAMPLE_CONTENT,
    );

    expect(updated).toContain("LOG_LEVEL=debug");
    expect(updated).toContain("CUSTOM_FEATURE_FLAG=true");
    expect(updated).toContain("OPEN_BROWSER_ROOTS=C:/Repos, D:/Work");
    expect(updated).not.toContain("# LOG_LEVEL=info");
    expect(updated).not.toContain("# OPEN_BROWSER_ROOTS=");
  });

  it("appends custom existing keys after the template", () => {
    const existingContent = ["CUSTOM_FLAG=enabled", "ANOTHER_CUSTOM=1", "LOG_LEVEL=debug", ""].join(
      "\n",
    );

    const updated = buildEnvFileContent(
      existingContent,
      {
        BOT_LOCALE: "en",
        TELEGRAM_BOT_TOKEN: "token:value",
        TELEGRAM_ALLOWED_USER_ID: "42",
      },
      ENV_EXAMPLE_CONTENT,
    );

    expect(updated).toContain("LOG_LEVEL=debug");
    expect(updated).toContain("CUSTOM_FLAG=enabled");
    expect(updated).toContain("ANOTHER_CUSTOM=1");
    expect(updated.lastIndexOf("# TTS_VOICE=alloy")).toBeLessThan(
      updated.lastIndexOf("CUSTOM_FLAG=enabled"),
    );
    expect(updated.trimEnd().endsWith("ANOTHER_CUSTOM=1")).toBe(true);
  });
});

describe("runtime/bootstrap installed configuration", () => {
  let tempHome: string;
  let stdinTtyDescriptor: PropertyDescriptor | undefined;
  let stdoutTtyDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "antigravity-tg-bootstrap-"));
    stdinTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    stdoutTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", tempHome);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:process-token");
    vi.stubEnv("TELEGRAM_ALLOWED_USER_ID", "123456789");
    vi.stubEnv("AGY_BIN", "");
    vi.stubEnv("AGY_WORKSPACE_DIR", "");
    vi.stubEnv("AGY_YOLO", "");
    vi.stubEnv("AGY_PRINT_TIMEOUT", "");
    vi.stubEnv("BOT_LOCALE", "en");
    setRuntimeMode("installed");
  });

  afterEach(async () => {
    if (stdinTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinTtyDescriptor);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
    if (stdoutTtyDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", stdoutTtyDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
    vi.unstubAllEnvs();
    delete process.env.OPENCODE_TELEGRAM_RUNTIME_MODE;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("accepts required values from process.env without an .env file", async () => {
    await ensureRuntimeConfigForStart();

    expect(fs.existsSync(path.join(tempHome, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(tempHome, "settings.json"))).toBe(false);
  });

  it("merges .env values with process.env taking precedence", async () => {
    await writeFile(
      path.join(tempHome, ".env"),
      [
        "TELEGRAM_BOT_TOKEN=",
        "TELEGRAM_ALLOWED_USER_ID=invalid",
        "",
      ].join("\n"),
      "utf-8",
    );

    await ensureRuntimeConfigForStart();

    expect(fs.existsSync(path.join(tempHome, "settings.json"))).toBe(false);
  });

  it("rejects an invalid process.env value even when .env is valid", async () => {
    vi.stubEnv("TELEGRAM_ALLOWED_USER_ID", "invalid");
    await writeFile(
      path.join(tempHome, ".env"),
      [
        "TELEGRAM_BOT_TOKEN=123456:file-token",
        "TELEGRAM_ALLOWED_USER_ID=42",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(ensureRuntimeConfigForStart()).rejects.toThrow(
      "Interactive wizard requires a TTY terminal",
    );
    expect(fs.existsSync(path.join(tempHome, "settings.json"))).toBe(false);
  });

  it("wizard saved copy names the env file and not settings.json", () => {
    const message = t("runtime.wizard.saved", { envPath: path.join(tempHome, ".env") });

    expect(message).toContain(path.join(tempHome, ".env"));
    expect(message).not.toMatch(/settings\.json/);
  });
});
