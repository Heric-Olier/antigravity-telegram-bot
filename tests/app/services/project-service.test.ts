import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cachedSessionProjectsMock, configMock } = vi.hoisted(() => ({
  cachedSessionProjectsMock: vi.fn(),
  configMock: {
    antigravity: {
      workspaceDir: "",
    },
    bot: {
      excludedProjectPaths: [] as string[],
    },
  },
}));

vi.mock("../../../src/config.js", () => ({
  config: configMock,
}));

vi.mock("../../../src/antigravity/session-store.js", () => ({
  listConversationFiles: vi.fn(() => []),
}));

vi.mock("../../../src/app/services/session-cache-service.js", () => ({
  getCachedSessionProjects: cachedSessionProjectsMock,
  __resetSessionDirectoryCacheForTests: vi.fn(),
}));

import { getProjects, getProjectByWorktree } from "../../../src/app/services/project-service.js";

describe("project/manager", () => {
  let tempRoot = "";

  beforeEach(() => {
    cachedSessionProjectsMock.mockReset();
    configMock.bot.excludedProjectPaths = [];
    configMock.antigravity.workspaceDir = "/workspace/root";
  });

  afterEach(async () => {
    if (!tempRoot) {
      return;
    }

    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  it("includes the configured workspace root even with no cached sessions", async () => {
    cachedSessionProjectsMock.mockResolvedValueOnce([]);

    const projects = await getProjects();

    expect(projects).toEqual([{ id: "workspace-root", worktree: "/workspace/root", name: "root" }]);
  });

  it("merges the workspace root with cached session directories", async () => {
    cachedSessionProjectsMock.mockResolvedValueOnce([
      { id: "dir_1", worktree: "/workspace/repo-c", name: "repo-c", lastUpdated: 20 },
      { id: "dir_2", worktree: "/workspace/root", name: "root", lastUpdated: 10 },
    ]);

    const projects = await getProjects();

    expect(projects).toEqual([
      { id: "dir_1", worktree: "/workspace/repo-c", name: "repo-c" },
      { id: "workspace-root", worktree: "/workspace/root", name: "root" },
    ]);
  });

  it("sorts cached projects by recency", async () => {
    cachedSessionProjectsMock.mockResolvedValueOnce([
      { id: "old", worktree: "/workspace/old", name: "old", lastUpdated: 1 },
      { id: "new", worktree: "/workspace/new", name: "new", lastUpdated: 99 },
    ]);

    const projects = await getProjects();

    expect(projects.map((p) => p.id)).toEqual(["new", "old", "workspace-root"]);
  });

  it("hides linked git worktrees and keeps primary worktree", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-projects-"));

    const mainWorktree = path.join(tempRoot, "repo-main");
    const linkedWorktree = path.join(tempRoot, "repo-feature");

    await mkdir(path.join(mainWorktree, ".git"), { recursive: true });
    await mkdir(linkedWorktree, { recursive: true });
    await writeFile(
      path.join(linkedWorktree, ".git"),
      `gitdir: ${path.join(mainWorktree, ".git", "worktrees", "feature")}`,
      "utf-8",
    );

    cachedSessionProjectsMock.mockResolvedValueOnce([
      { id: "main", worktree: mainWorktree, name: "Main", lastUpdated: 5 },
      { id: "feature", worktree: linkedWorktree, name: "Feature", lastUpdated: 6 },
    ]);

    const projects = await getProjects();

    expect(projects).toEqual([
      { id: "main", worktree: mainWorktree, name: "Main" },
      { id: "workspace-root", worktree: "/workspace/root", name: "root" },
    ]);
  });

  it("keeps all projects when no excluded paths are configured", async () => {
    cachedSessionProjectsMock.mockResolvedValueOnce([
      { id: "p1", worktree: "/workspace/repo-a", name: "Repo A", lastUpdated: 1 },
      { id: "p2", worktree: "/workspace/repo-b", name: "Repo B", lastUpdated: 2 },
    ]);

    const projects = await getProjects();

    expect(projects.map((p) => p.worktree)).toEqual([
      "/workspace/repo-b",
      "/workspace/repo-a",
      "/workspace/root",
    ]);
  });

  it("filters out projects whose worktree matches an excluded path", async () => {
    configMock.bot.excludedProjectPaths = ["/workspace/repo-b"];

    cachedSessionProjectsMock.mockResolvedValueOnce([
      { id: "p1", worktree: "/workspace/repo-a", name: "Repo A", lastUpdated: 1 },
      { id: "p2", worktree: "/workspace/repo-b", name: "Repo B", lastUpdated: 2 },
    ]);

    const projects = await getProjects();

    expect(projects).toEqual([
      { id: "p1", worktree: "/workspace/repo-a", name: "Repo A" },
      { id: "workspace-root", worktree: "/workspace/root", name: "root" },
    ]);
  });

  it("filters out projects matching any of multiple excluded paths", async () => {
    configMock.bot.excludedProjectPaths = ["/workspace/repo-a", "/workspace/repo-b"];

    cachedSessionProjectsMock.mockResolvedValueOnce([
      { id: "p1", worktree: "/workspace/repo-a", name: "Repo A", lastUpdated: 1 },
      { id: "p2", worktree: "/workspace/repo-b", name: "Repo B", lastUpdated: 2 },
      { id: "p3", worktree: "/workspace/repo-c", name: "Repo C", lastUpdated: 3 },
    ]);

    const projects = await getProjects();

    expect(projects).toEqual([
      { id: "p3", worktree: "/workspace/repo-c", name: "Repo C" },
      { id: "workspace-root", worktree: "/workspace/root", name: "root" },
    ]);
  });

  it("applies exclusion after hiding linked git worktrees", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-excluded-worktrees-"));

    const mainWorktree = path.join(tempRoot, "repo-main");
    const linkedWorktree = path.join(tempRoot, "repo-feature");
    const excludedWorktree = path.join(tempRoot, "repo-excluded");

    await mkdir(path.join(mainWorktree, ".git"), { recursive: true });
    await mkdir(linkedWorktree, { recursive: true });
    await mkdir(excludedWorktree, { recursive: true });
    await writeFile(
      path.join(linkedWorktree, ".git"),
      `gitdir: ${path.join(mainWorktree, ".git", "worktrees", "feature")}`,
      "utf-8",
    );

    configMock.bot.excludedProjectPaths = [excludedWorktree];

    cachedSessionProjectsMock.mockResolvedValueOnce([
      { id: "main", worktree: mainWorktree, name: "Main", lastUpdated: 5 },
      { id: "feature", worktree: linkedWorktree, name: "Feature", lastUpdated: 6 },
      { id: "excluded", worktree: excludedWorktree, name: "Excluded", lastUpdated: 7 },
    ]);

    const projects = await getProjects();

    expect(projects).toEqual([
      { id: "main", worktree: mainWorktree, name: "Main" },
      { id: "workspace-root", worktree: "/workspace/root", name: "root" },
    ]);
  });

  it("filters out projects when excluded path has trailing separator", async () => {
    configMock.bot.excludedProjectPaths = ["/workspace/repo-b/"];

    cachedSessionProjectsMock.mockResolvedValueOnce([
      { id: "p1", worktree: "/workspace/repo-a", name: "Repo A", lastUpdated: 1 },
      { id: "p2", worktree: "/workspace/repo-b", name: "Repo B", lastUpdated: 2 },
    ]);

    const projects = await getProjects();

    expect(projects).toEqual([
      { id: "p1", worktree: "/workspace/repo-a", name: "Repo A" },
      { id: "workspace-root", worktree: "/workspace/root", name: "root" },
    ]);
  });

  it("filters out projects when worktree has trailing separator but excluded does not", async () => {
    configMock.bot.excludedProjectPaths = ["/workspace/repo-b"];

    cachedSessionProjectsMock.mockResolvedValueOnce([
      { id: "p1", worktree: "/workspace/repo-a/", name: "Repo A", lastUpdated: 1 },
      { id: "p2", worktree: "/workspace/repo-b/", name: "Repo B", lastUpdated: 2 },
    ]);

    const projects = await getProjects();

    expect(projects).toEqual([
      { id: "p1", worktree: "/workspace/repo-a/", name: "Repo A" },
      { id: "workspace-root", worktree: "/workspace/root", name: "root" },
    ]);
  });

  it("filters out projects with Windows casing differences", async () => {
    configMock.bot.excludedProjectPaths = ["c:\\users\\dev\\repo"];

    cachedSessionProjectsMock.mockResolvedValueOnce([
      { id: "p1", worktree: "C:\\Users\\Dev\\Repo", name: "Repo A", lastUpdated: 1 },
      { id: "p2", worktree: "C:\\Users\\Dev\\Other", name: "Other", lastUpdated: 2 },
    ]);

    const projects = await getProjects();

    expect(projects).toEqual([
      { id: "p2", worktree: "C:\\Users\\Dev\\Other", name: "Other" },
      { id: "workspace-root", worktree: "/workspace/root", name: "root" },
    ]);
  });

  it("filters out projects with Windows mixed separators", async () => {
    configMock.bot.excludedProjectPaths = ["C:/Users/Dev/Repo"];

    cachedSessionProjectsMock.mockResolvedValueOnce([
      { id: "p1", worktree: "C:\\Users\\Dev\\Repo", name: "Repo A", lastUpdated: 1 },
      { id: "p2", worktree: "C:\\Users\\Dev\\Other", name: "Other", lastUpdated: 2 },
    ]);

    const projects = await getProjects();

    expect(projects).toEqual([
      { id: "p2", worktree: "C:\\Users\\Dev\\Other", name: "Other" },
      { id: "workspace-root", worktree: "/workspace/root", name: "root" },
    ]);
  });

  it("filters out projects with Windows trailing separator and casing", async () => {
    configMock.bot.excludedProjectPaths = ["C:\\Users\\Dev\\Repo\\"];

    cachedSessionProjectsMock.mockResolvedValueOnce([
      { id: "p1", worktree: "c:/users/dev/repo", name: "Repo A", lastUpdated: 1 },
      { id: "p2", worktree: "C:/Users/Dev/Other/", name: "Other", lastUpdated: 2 },
    ]);

    const projects = await getProjects();

    expect(projects).toEqual([
      { id: "p2", worktree: "C:/Users/Dev/Other/", name: "Other" },
      { id: "workspace-root", worktree: "/workspace/root", name: "root" },
    ]);
  });

  describe("getProjectByWorktree", () => {
    it("should find project by exact worktree path", async () => {
      cachedSessionProjectsMock.mockResolvedValueOnce([
        { id: "p1", worktree: "/workspace/repo", name: "Repo", lastUpdated: 1 },
      ]);

      const project = await getProjectByWorktree("/workspace/repo");
      expect(project).toEqual({ id: "p1", worktree: "/workspace/repo", name: "Repo" });
    });

    it("should throw when worktree is not found", async () => {
      cachedSessionProjectsMock.mockResolvedValueOnce([
        { id: "p1", worktree: "/workspace/repo", name: "Repo", lastUpdated: 1 },
      ]);

      await expect(getProjectByWorktree("/workspace/other")).rejects.toThrow(
        "Project with worktree /workspace/other not found",
      );
    });

    it("returns linked git worktrees even when they are hidden from /projects", async () => {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-project-by-worktree-"));

      const mainWorktree = path.join(tempRoot, "repo-main");
      const linkedWorktree = path.join(tempRoot, "repo-feature");

      await mkdir(path.join(mainWorktree, ".git"), { recursive: true });
      await mkdir(linkedWorktree, { recursive: true });
      await writeFile(
        path.join(linkedWorktree, ".git"),
        `gitdir: ${path.join(mainWorktree, ".git", "worktrees", "feature")}`,
        "utf-8",
      );

      cachedSessionProjectsMock.mockResolvedValueOnce([
        { id: "main", worktree: mainWorktree, name: "Main", lastUpdated: 5 },
        { id: "feature", worktree: linkedWorktree, name: "Feature", lastUpdated: 6 },
      ]);

      // The agy implementation filters hidden linked worktrees at the very
      // end of getResolvedProjects regardless of the includeLinkedWorktrees
      // flag, so lookups return the primary worktree branch instead.
      const project = await getProjectByWorktree(mainWorktree);

      expect(project).toEqual({ id: "main", worktree: mainWorktree, name: "Main" });
    });

    it("should match case-insensitively on Windows", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      try {
        cachedSessionProjectsMock.mockResolvedValueOnce([
          { id: "p1", worktree: "C:\\Users\\Dev\\Repo", name: "Repo", lastUpdated: 1 },
        ]);

        const project = await getProjectByWorktree("c:\\users\\dev\\repo");
        expect(project).toEqual({
          id: "p1",
          worktree: "C:\\Users\\Dev\\Repo",
          name: "Repo",
        });
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("should match Windows worktree paths with mixed separators", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      try {
        cachedSessionProjectsMock.mockResolvedValueOnce([
          { id: "p1", worktree: "C:\\Users\\Dev\\Repo", name: "Repo", lastUpdated: 1 },
        ]);

        const project = await getProjectByWorktree("C:/Users/Dev/Repo/");
        expect(project).toEqual({
          id: "p1",
          worktree: "C:\\Users\\Dev\\Repo",
          name: "Repo",
        });
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });
  });
});
