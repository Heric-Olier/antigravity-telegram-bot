import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMcpCatalogServers } from "../../../src/app/services/mcp-catalog-service.js";
import { logger } from "../../../src/utils/logger.js";

describe("app/services/mcp-catalog-service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a dictionary-form catalog", () => {
    const servers = parseMcpCatalogServers({
      "server-a": { status: "connected" },
      "server-b": { status: "disabled" },
    });

    expect(servers).toEqual([
      { name: "server-a", status: { status: "connected" } },
      { name: "server-b", status: { status: "disabled" } },
    ]);
  });

  it("parses an array-form catalog", () => {
    const servers = parseMcpCatalogServers([
      { name: "server-a", status: { status: "needs_auth" } },
    ]);

    expect(servers).toEqual([{ name: "server-a", status: { status: "needs_auth" } }]);
  });

  it("keeps the error on failed servers", () => {
    const servers = parseMcpCatalogServers({
      "server-broken": { status: "failed", error: "boom" },
    });

    expect(servers).toEqual([
      { name: "server-broken", status: { status: "failed", error: "boom" } },
    ]);
  });

  it("normalizes a missing error on failed servers to an empty string", () => {
    const servers = parseMcpCatalogServers({
      "server-broken": { status: "failed" },
    });

    expect(servers).toEqual([
      { name: "server-broken", status: { status: "failed", error: "" } },
    ]);
  });

  it("skips servers with an unknown status string but keeps the rest", () => {
    const warnSpy = vi.spyOn(logger, "debug");
    const servers = parseMcpCatalogServers({
      "server-future": { status: "connecting" },
      "server-ok": { status: "connected" },
    });

    expect(servers).toEqual([{ name: "server-ok", status: { status: "connected" } }]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[McpCatalog] Unknown MCP status "connecting", skipping server',
    );
  });

  it("returns null for structurally broken input", () => {
    expect(parseMcpCatalogServers(null)).toBeNull();
    expect(parseMcpCatalogServers(42)).toBeNull();
    expect(parseMcpCatalogServers({ "server-a": "not-an-object" })).toBeNull();
    expect(parseMcpCatalogServers({ "server-a": { status: 42 } })).toBeNull();
    expect(parseMcpCatalogServers([{ name: "server-a", status: null }])).toBeNull();
  });
});
