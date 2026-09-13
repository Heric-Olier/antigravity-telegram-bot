
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSessionDirectoryCacheForTests,
  getCachedSessionProjects,
  ingestSessionInfoForCache,
  syncSessionDirectoryCache,
  upsertSessionDirectory,
} from "../../../src/app/services/session-cache-service.js";

const mocked = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: mocked.loggerDebugMock,
    warn: mocked.loggerWarnMock,
    error: vi.fn(),
  },
}));

/**
 * agy version: the cache remembers the single workspace directory (plus any
 * directories learned from conversation metadata). No server sync involved.
 */

describe("session-cache-service (agy)", () => {
  beforeEach(() => {
    mocked.loggerWarnMock.mockReset();
    mocked.loggerDebugMock.mockReset();
    __resetSessionDirectoryCacheForTests();
  });

  it("upserts and returns known project directories sorted by recency", async () => {
    await upsertSessionDirectory("/repo/a", 1_700_000_000_100);
    await upsertSessionDirectory("/repo/b", 1_700_000_000_200);

    const projects = await getCachedSessionProjects();
    expect(projects.map((p) => [p.worktree, p.lastUpdated])).toEqual([
      ["/repo/b", 1_700_000_000_200],
      ["/repo/a", 1_700_000_000_100],
    ]);
    expect(projects[0].id).toBe("agy-/repo/b");
    expect(projects[0].name).toBe("b");
  });

  it("updates an existing directory with a newer timestamp", async () => {
    await upsertSessionDirectory("/repo/a", 1_700_000_000_100);
    await upsertSessionDirectory("/repo/a", 1_700_000_000_900);

    const projects = await getCachedSessionProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].lastUpdated).toBe(1_700_000_000_900);
  });

  it("ingests agy conversation metadata for the cache", async () => {
    await ingestSessionInfoForCache({
      id: "conv-1",
      directory: "/repo/b",
      title: "Conv",
      time: { updated: 1_700_000_000_300 },
    });

    const projects = await getCachedSessionProjects();
    expect(projects.map((p) => p.worktree)).toEqual(["/repo/b"]);
  });

  it("keeps learning the workspace directory on sync", async () => {
    await syncSessionDirectoryCache();

    const projects = await getCachedSessionProjects();
    expect(projects.length).toBeGreaterThanOrEqual(1);
  });

  it("ignores invalid directories silently", async () => {
    await upsertSessionDirectory("", -1);
    const projects = await getCachedSessionProjects();
    expect(projects).toHaveLength(0);
  });
});
