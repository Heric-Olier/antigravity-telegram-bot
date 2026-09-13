import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { config } from "../../../src/config.js";
import {
  LS_CALLBACK_ATTACH_PREFIX,
  renderLsFileDetailsView,
} from "../../../src/bot/menus/file-browser-menu.js";

const mocked = vi.hoisted(() => ({
  worktree: "",
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/app/stores/settings-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/app/stores/settings-store.js")>();
  return {
    ...actual,
    getCurrentProject: vi.fn(() => ({ id: "project-1", worktree: mocked.worktree })),
  };
});

function callbackDataOf(view: { keyboard: { inline_keyboard: { callback_data?: string }[][] } }) {
  return view.keyboard.inline_keyboard.flat().map((button) => button.callback_data ?? "");
}

describe("bot/menus/file-browser-menu - attach button", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.realpath(await mkdtemp(path.join(os.tmpdir(), "ls-menu-test-")));
    mocked.worktree = projectRoot;
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("offers the attach button for a text file within the size limit", async () => {
    const filePath = path.join(projectRoot, "index.ts");
    await fs.writeFile(filePath, "export const a = 1;\n", "utf-8");

    const view = await renderLsFileDetailsView(filePath, 0);

    expect("error" in view).toBe(false);
    expect(callbackDataOf(view as never).some((data) => data.startsWith(LS_CALLBACK_ATTACH_PREFIX))).toBe(
      true,
    );
  });

  it("hides the attach button for a binary file but keeps download", async () => {
    const filePath = path.join(projectRoot, "logo.png");
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const view = await renderLsFileDetailsView(filePath, 0);

    const callbacks = callbackDataOf(view as never);
    expect(callbacks.some((data) => data.startsWith(LS_CALLBACK_ATTACH_PREFIX))).toBe(false);
    expect(callbacks.some((data) => data.startsWith("ls:download:"))).toBe(true);
  });

  it("hides the attach button for a text file over the size limit", async () => {
    const filePath = path.join(projectRoot, "huge.log");
    await fs.writeFile(filePath, "x".repeat((config.files.maxFileSizeKb + 1) * 1024), "utf-8");

    const view = await renderLsFileDetailsView(filePath, 0);

    expect(callbackDataOf(view as never).some((data) => data.startsWith(LS_CALLBACK_ATTACH_PREFIX))).toBe(
      false,
    );
  });
});
