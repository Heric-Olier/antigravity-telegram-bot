import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: { antigravity: { bin: "/usr/bin/true", workspaceDir: "/tmp" } },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SwitchHandleImpl } from "../../../src/app/services/account-switch-service.js";

describe("app/services/account-switch-service — failure contract", () => {
  it("failed() surfaces ok=false to callbacks registered afterwards", () => {
    const handle = SwitchHandleImpl.failed("pty spawn failed: spawn script ENOENT");
    const cb = vi.fn();
    handle.onFinish(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]?.[0]).toBe(false);
    expect(String(cb.mock.calls[0]?.[1])).toContain("ENOENT");
  });

  it("fail() notifies registered callbacks exactly once (no double-finish)", () => {
    const handle = new SwitchHandleImpl(null);
    const cb = vi.fn();
    handle.onFinish(cb);
    handle.fail("boom");
    handle.fail("again");
    handle.closed(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]?.[0]).toBe(false);
    expect(String(cb.mock.calls[0]?.[1])).toBe("boom");
  });

  it("abort() and submitCode() are safe without a child process", () => {
    const handle = SwitchHandleImpl.failed("no pty");
    expect(() => handle.abort()).not.toThrow();
    expect(() => handle.submitCode("auth-code")).not.toThrow();
  });
});
