import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  getSessionDirectoryCache,
  setSessionDirectoryCache,
  __resetSettingsForTests,
} from "../stores/settings-store.js";
import { isRecord } from "../../utils/type-guards.js";
import type { CachedSessionDirectory, SessionDirectoryProject } from "../types/session.js";

/**
 * Session directory cache (agy version).
 *
 * agy scans conversations under one fixed root
 * (~/.gemini/antigravity-cli/conversations), so the OpenCode-era storage-root
 * discovery / SQLite fallback layers are gone. The cache now just remembers the
 * workspace directory as the single project.
 */

interface SessionDirectoryCacheData {
  version: 1;
  lastSyncedUpdatedAt: number;
  directories: CachedSessionDirectory[];
}

const CACHE_VERSION = 1;
const MAX_CACHED_DIRECTORIES = 10;

const EMPTY_CACHE: SessionDirectoryCacheData = {
  version: CACHE_VERSION,
  lastSyncedUpdatedAt: 0,
  directories: [],
};

function createEmptyCacheData(): SessionDirectoryCacheData {
  return {
    version: EMPTY_CACHE.version,
    lastSyncedUpdatedAt: EMPTY_CACHE.lastSyncedUpdatedAt,
    directories: [],
  };
}

let cacheData: SessionDirectoryCacheData = createEmptyCacheData();
let cacheLoaded = false;
let lastSyncAttemptAt = 0;
const persistQueue: Promise<void> = Promise.resolve();

function worktreeKey(worktree: string): string {
  if (process.platform === "win32") {
    return worktree.toLowerCase();
  }

  return worktree;
}

function isValidWorktree(worktree: string): boolean {
  const trimmed = worktree.trim();
  return trimmed.length > 0 && trimmed !== "/";
}

function normalizeCacheData(raw: unknown): SessionDirectoryCacheData {
  if (!isRecord(raw)) {
    return createEmptyCacheData();
  }

  const lastSyncedUpdatedAt =
    typeof raw.lastSyncedUpdatedAt === "number" && Number.isFinite(raw.lastSyncedUpdatedAt)
      ? raw.lastSyncedUpdatedAt
      : 0;

  const directories: CachedSessionDirectory[] = Array.isArray(raw.directories)
    ? raw.directories
        .filter(
          (item): item is { worktree: string; lastUpdated: number } =>
            isRecord(item) &&
            typeof item.worktree === "string" &&
            typeof item.lastUpdated === "number",
        )
        .map((item) => ({
          worktree: item.worktree.trim(),
          lastUpdated: item.lastUpdated,
        }))
        .filter((item) => isValidWorktree(item.worktree))
    : [];

  const data: SessionDirectoryCacheData = {
    version: CACHE_VERSION,
    lastSyncedUpdatedAt,
    directories,
  };

  dedupeAndTrimDirectories(data);
  return data;
}

function dedupeAndTrimDirectories(data: SessionDirectoryCacheData): void {
  const unique = new Map<string, CachedSessionDirectory>();

  for (const item of data.directories) {
    const key = worktreeKey(item.worktree);
    const existing = unique.get(key);

    if (!existing || existing.lastUpdated < item.lastUpdated) {
      unique.set(key, item);
    }
  }

  data.directories = Array.from(unique.values())
    .sort((a, b) => b.lastUpdated - a.lastUpdated)
    .slice(0, MAX_CACHED_DIRECTORIES);
}

async function ensureCacheLoaded(): Promise<void> {
  if (cacheLoaded) {
    return;
  }

  const storedCache = getSessionDirectoryCache();
  cacheData = normalizeCacheData(storedCache);
  cacheLoaded = true;
  logger.debug(
    `[SessionCache] Loaded ${cacheData.directories.length} directories from settings.sessionDirectoryCache`,
  );
}

async function persist(): Promise<void> {
  try {
    await setSessionDirectoryCache(configCacheSnapshot());
  } catch (error) {
    logger.error("[SessionCache] Failed to persist sessions cache", error);
  }
}

function configCacheSnapshot(): SessionDirectoryCacheData {
  return {
    version: cacheData.version,
    lastSyncedUpdatedAt: cacheData.lastSyncedUpdatedAt,
    directories: [...cacheData.directories],
  };
}

function upsertDirectory(worktree: string, lastUpdated: number): boolean {
  if (!isValidWorktree(worktree)) {
    return false;
  }

  const key = worktreeKey(worktree);
  const existing = cacheData.directories.find((d) => worktreeKey(d.worktree) === key);

  if (existing && existing.lastUpdated >= lastUpdated) {
    return false;
  }

  if (existing) {
    existing.lastUpdated = lastUpdated;
  } else {
    cacheData.directories.push({ worktree, lastUpdated });
  }

  dedupeAndTrimDirectories(cacheData);
  return true;
}

async function runSync(): Promise<void> {
  await ensureCacheLoaded();

  // agy keeps every conversation under the configured workspace; nothing
  // external to sync, just make sure the workspace root itself is cached.
  let changed = false;
  const workspace = config.antigravity.workspaceDir;
  if (upsertDirectory(workspace, Date.now())) {
    changed = true;
  }

  if (changed) {
    await persist();
  }

  logger.debug(`[SessionCache] Synced agy workspace: directories=${cacheData.directories.length}`);
}

export async function syncSessionDirectoryCache(options?: { force?: boolean }): Promise<void> {
  void options;

  const now = Date.now();
  if (now - lastSyncAttemptAt < 60_000) {
    return;
  }

  lastSyncAttemptAt = now;

  try {
    await runSync();
  } catch (error) {
    logger.warn("[SessionCache] Failed to sync session directory cache", error);
  }
}

export async function getCachedSessionProjects(): Promise<SessionDirectoryProject[]> {
  await ensureCacheLoaded();
  return cacheData.directories.map((directory) => ({
    id: `agy-${worktreeKey(directory.worktree)}`,
    worktree: directory.worktree,
    name: directory.worktree.split("/").pop() || directory.worktree,
    lastUpdated: directory.lastUpdated,
  }));
}

/**
 * Persist a session's directory info into the cache (call sites pass agy
 * conversation metadata; the worktree is the directory key).
 */
export async function ingestSessionInfoForCache(session: {
  id?: string | undefined;
  directory?: string | undefined;
  title?: string | undefined;
  time?: { updated?: number | undefined };
}): Promise<void> {
  if (!session.directory || !isValidWorktree(session.directory)) {
    return;
  }

  await ensureCacheLoaded();
  if (
    upsertDirectory(session.directory, session.time?.updated ?? Date.now())
  ) {
    await persist();
  }
}

export async function upsertSessionDirectory(
  worktree: string,
  lastUpdated: number,
): Promise<void> {
  await ensureCacheLoaded();
  if (upsertDirectory(worktree, lastUpdated)) {
    await persist();
  }
}

export function __resetSessionCacheForTests(): void {
  cacheData = createEmptyCacheData();
  cacheLoaded = false;
  lastSyncAttemptAt = 0;
  __resetSettingsForTests();
}

// Legacy alias kept for the shared test reset helper (opencode-era name).
export const __resetSessionDirectoryCacheForTests = __resetSessionCacheForTests;

void persistQueue;
