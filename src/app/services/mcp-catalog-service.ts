import { logger } from "../../utils/logger.js";
import { isRecord } from "../../utils/type-guards.js";

/**
 * MCP catalog for agy.
 *
 * agy has no MCP status API in v1; the catalog is always empty. Parsing helpers
 * are kept because the catalog callback handler unit-tests them.
 */

export interface McpCatalogServerItem {
  name: string;
  status: { status: string; error?: string | undefined };
}

const MCP_STATUS_NAMES = [
  "connected",
  "disabled",
  "failed",
  "needs_auth",
  "needs_client_registration",
] as const;

function isMcpStatusName(value: unknown): value is (typeof MCP_STATUS_NAMES)[number] {
  return typeof value === "string" && MCP_STATUS_NAMES.some((name) => name === value);
}

function buildMcpStatus(statusValue: (typeof MCP_STATUS_NAMES)[number], errorValue: unknown): McpCatalogServerItem["status"] {
  if (statusValue === "failed" || statusValue === "needs_client_registration") {
    return { status: statusValue, error: typeof errorValue === "string" ? errorValue : "" };
  }

  return { status: statusValue };
}

type ParsedMcpServerStatus =
  | { kind: "ok"; status: McpCatalogServerItem["status"] }
  | { kind: "skip" }
  | { kind: "invalid" };

function parseMcpServerStatus(status: unknown): ParsedMcpServerStatus {
  if (!isRecord(status)) {
    return { kind: "invalid" };
  }

  if (!isMcpStatusName(status.status)) {
    if (typeof status.status === "string") {
      logger.debug(`[McpCatalog] Unknown MCP status "${status.status}", skipping server`);
      return { kind: "skip" };
    }

    return { kind: "invalid" };
  }

  return { kind: "ok", status: buildMcpStatus(status.status, status.error) };
}

export function parseMcpCatalogServers(value: unknown): McpCatalogServerItem[] | null {
  if (!isRecord(value)) {
    return null;
  }

  if (Array.isArray(value)) {
    const servers: McpCatalogServerItem[] = [];
    for (const item of value) {
      if (!isRecord(item)) {
        return null;
      }

      const name = item.name;
      if (typeof name !== "string") {
        return null;
      }

      const parsed = parseMcpServerStatus(item.status);
      if (parsed.kind === "invalid") {
        return null;
      }
      if (parsed.kind === "skip") {
        continue;
      }

      servers.push({ name, status: parsed.status });
    }

    return servers;
  }

  const servers: McpCatalogServerItem[] = [];

  for (const [name, statusValue] of Object.entries(value)) {
    const parsed = parseMcpServerStatus(statusValue);
    if (parsed.kind === "invalid") {
      return null;
    }
    if (parsed.kind === "skip") {
      continue;
    }

    servers.push({ name, status: parsed.status });
  }

  return servers;
}

export async function loadMcpCatalog(_projectDirectory: string): Promise<McpCatalogServerItem[]> {
  return [];
}

export async function toggleMcpCatalogServer(
  _projectDirectory: string,
  _serverName: string,
  _enable: boolean,
): Promise<void> {
  throw new Error("MCP server toggling is not available with the Antigravity backend");
}
