import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import { getCachedSessionProjects } from "./session-cache-service.js";
import { logger } from "../../utils/logger.js";
import type { ProjectInfo } from "../types/project.js";
import { listConversationFiles } from "../../antigravity/session-store.js";

/**
 * Project discovery for agy.
 *
 * agy has no project registry: projects are inferred from the workspace
 * directories referenced by stored conversations (each conversation runs with a
 * cwd inside the workspace). Fallback to the configured workspace root.
 */

interface InternalProject extends ProjectInfo {
  lastUpdated: number;
}

async function getResolvedProjects(options?: {
  includeLinkedWorktrees?: boolean;
}): Promise<InternalProject[]> {
  void options;

  // Directory -> latest conversation mtime map.
  const byWorktree = new Map<string, InternalProject>();
  const workspaceRoot = config.antigravity.workspaceDir;
  byWorktree.set(worktreeKey(workspaceRoot), {
    id: "workspace-root",
    worktree: workspaceRoot,
    name: path.basename(workspaceRoot) || workspaceRoot,
    lastUpdated: 0,
  });

  for (const file of listConversationFiles()) {
    void file; // agy stores no per-conversation cwd in the summary DB today.
  }

  const cachedProjects = await getCachedSessionProjects();
  for (const cachedProject of cachedProjects) {
    const key = worktreeKey(cachedProject.worktree);
    const existing = byWorktree.get(key);

    if (existing) {
      if ((cachedProject.lastUpdated ?? 0) > existing.lastUpdated) {
        existing.lastUpdated = cachedProject.lastUpdated;
      }
      continue;
    }

    byWorktree.set(key, {
      id: cachedProject.id,
      worktree: cachedProject.worktree,
      name: cachedProject.name,
      lastUpdated: cachedProject.lastUpdated ?? 0,
    });
  }

  const projectList = Array.from(byWorktree.values()).sort(
    (left, right) => right.lastUpdated - left.lastUpdated,
  );

  const linkedWorktreeFlags = await Promise.all(
    projectList.map((project) => isLinkedGitWorktree(project.worktree)),
  );

  const visibleProjects = projectList.filter((_, index) => !linkedWorktreeFlags[index]);
  const hiddenLinkedWorktrees = projectList.length - visibleProjects.length;

  const excludedPaths = config.bot.excludedProjectPaths;
  const excludedKeys = new Set(excludedPaths.map((excluded) => worktreeKey(excluded)));
  const filteredProjects = excludedKeys.size > 0
    ? visibleProjects.filter((p) => !excludedKeys.has(worktreeKey(p.worktree)))
    : visibleProjects;
  const hiddenExcluded = visibleProjects.length - filteredProjects.length;

  logger.debug(
    `[ProjectManager] Projects resolved: cached=${cachedProjects.length}, hiddenLinkedWorktrees=${hiddenLinkedWorktrees}, hiddenExcluded=${hiddenExcluded}, total=${filteredProjects.length}`,
  );

  return filteredProjects;
}

async function isLinkedGitWorktree(worktree: string): Promise<boolean> {
  if (worktree === "/") {
    return false;
  }

  const gitPath = path.join(worktree, ".git");

  try {
    const gitStat = await stat(gitPath);

    if (!gitStat.isFile()) {
      return false;
    }

    const gitPointer = (await readFile(gitPath, "utf-8")).trim();
    const match = gitPointer.match(/^gitdir:\s*(.+)$/i);
    if (!match) {
      return false;
    }

    const gitDirPointer = match[1];
    if (!gitDirPointer) {
      return false;
    }
    const gitDir = path.resolve(worktree, gitDirPointer.trim()).replace(/\\/g, "/").toLowerCase();
    return gitDir.includes("/.git/worktrees/");
  } catch {
    return false;
  }
}

function worktreeKey(worktree: string): string {
  const pathModule = isWindowsWorktreePath(worktree) ? path.win32 : path.posix;
  const normalizedWorktree = pathModule.normalize(worktree);
  const root = pathModule.parse(normalizedWorktree).root;
  const trimmedWorktree =
    normalizedWorktree === root ? normalizedWorktree : normalizedWorktree.replace(/[\\/]+$/, "");

  if (pathModule === path.win32) {
    return trimmedWorktree.toLowerCase();
  }

  return trimmedWorktree;
}

function isWindowsWorktreePath(worktree: string): boolean {
  return process.platform === "win32" || /^[a-zA-Z]:[\\/]/.test(worktree) || /^\\\\/.test(worktree);
}

export async function getProjects(): Promise<ProjectInfo[]> {
  const projects = await getResolvedProjects();
  return projects.map(({ id, worktree, name }) => ({ id, worktree, name }));
}

export async function getProjectById(id: string): Promise<ProjectInfo> {
  const projects = await getProjects();
  const project = projects.find((p) => p.id === id);
  if (!project) {
    throw new Error(`Project with id ${id} not found`);
  }
  return project;
}

export async function getProjectByWorktree(worktree: string): Promise<ProjectInfo> {
  const projects = await getResolvedProjects({ includeLinkedWorktrees: true });
  const key = worktreeKey(worktree);
  const project = projects.find((p) => worktreeKey(p.worktree) === key);
  if (!project) {
    throw new Error(`Project with worktree ${worktree} not found`);
  }
  return { id: project.id, worktree: project.worktree, name: project.name };
}
