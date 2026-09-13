import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { config } from "../../../src/config.js";
import { promptAttachment } from "../../../src/app/managers/prompt-attachment-manager.js";
import { resolvePendingAttachment } from "../../../src/app/services/prompt-attachment-service.js";

const mocked = vi.hoisted(() => ({
  worktree: "",
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Only the current project is overridden: replacing the whole store would break the many
// unrelated modules that read other settings during test setup.
vi.mock("../../../src/app/stores/settings-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/app/stores/settings-store.js")>();
  return {
    ...actual,
    getCurrentProject: vi.fn(() => ({ id: "project-1", worktree: mocked.worktree })),
  };
});

describe("app/services/prompt-attachment-service", () => {
  let projectRoot: string;
  let filePath: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(os.tmpdir(), "attach-test-"));
    // The project root itself may be a symlink (/var -> /private/var on macOS); resolve it
    // so the service's realpath check compares like with like.
    projectRoot = await fs.realpath(projectRoot);
    mocked.worktree = projectRoot;

    filePath = path.join(projectRoot, "index.ts");
    await fs.writeFile(filePath, "export const a = 1;\n", "utf-8");

    promptAttachment.__resetForTests();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("returns null when nothing is attached", async () => {
    expect(await resolvePendingAttachment(projectRoot)).toBeNull();
  });

  it("builds a file part OpenCode reads as text", async () => {
    promptAttachment.set(filePath, projectRoot);

    const part = await resolvePendingAttachment(projectRoot);

    expect(part).toEqual({
      type: "file",
      mime: "text/plain",
      filename: "index.ts",
      url: pathToFileURL(filePath).href,
    });
    // `source` is only meaningful for MCP resources and must stay absent.
    expect(part).not.toHaveProperty("source");
    expect(part!.url.startsWith("file://")).toBe(true);
  });

  it("uses a worktree-relative filename for nested files", async () => {
    const nestedDir = path.join(projectRoot, "src", "bot");
    await fs.mkdir(nestedDir, { recursive: true });
    const nested = path.join(nestedDir, "index.ts");
    await fs.writeFile(nested, "// nested\n", "utf-8");

    promptAttachment.set(nested, projectRoot);

    const part = await resolvePendingAttachment(projectRoot);

    expect(part!.filename).toBe(path.join("src", "bot", "index.ts"));
  });

  it("drops the attachment when the project changed", async () => {
    promptAttachment.set(filePath, path.join(projectRoot, "other-project"));

    expect(await resolvePendingAttachment(projectRoot)).toBeNull();
    expect(promptAttachment.get()).toBeNull();
  });

  it("drops the attachment when the file was deleted", async () => {
    promptAttachment.set(filePath, projectRoot);
    await fs.rm(filePath);

    expect(await resolvePendingAttachment(projectRoot)).toBeNull();
    expect(promptAttachment.get()).toBeNull();
  });

  it("drops the attachment when the path became a directory", async () => {
    const replaced = path.join(projectRoot, "replaced");
    await fs.writeFile(replaced, "text\n", "utf-8");
    promptAttachment.set(replaced, projectRoot);

    await fs.rm(replaced);
    await fs.mkdir(replaced);

    expect(await resolvePendingAttachment(projectRoot)).toBeNull();
    expect(promptAttachment.get()).toBeNull();
  });

  it("drops the attachment when the file grew past the size limit", async () => {
    const big = path.join(projectRoot, "big.log");
    await fs.writeFile(big, "x".repeat((config.files.maxFileSizeKb + 1) * 1024), "utf-8");
    promptAttachment.set(big, projectRoot);

    expect(await resolvePendingAttachment(projectRoot)).toBeNull();
    expect(promptAttachment.get()).toBeNull();
  });

  it("drops the attachment when a symlink points outside the project", async () => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "attach-outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    await fs.writeFile(outsideFile, "secret\n", "utf-8");

    const link = path.join(projectRoot, "link.ts");
    try {
      await fs.symlink(outsideFile, link, "file");
    } catch {
      // Windows without developer mode forbids symlink creation for regular users.
      await rm(outsideDir, { recursive: true, force: true });
      return;
    }

    promptAttachment.set(link, projectRoot);

    expect(await resolvePendingAttachment(projectRoot)).toBeNull();
    expect(promptAttachment.get()).toBeNull();

    await rm(outsideDir, { recursive: true, force: true });
  });
});
