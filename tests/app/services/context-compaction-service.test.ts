import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  getAutoCompactEnabled: vi.fn(() => true),
  getAutoCompactThresholdTokens: vi.fn(() => 150_000),
}));

vi.mock("../../../src/app/stores/settings-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/app/stores/settings-store.js")>(
    "../../../src/app/stores/settings-store.js",
  );

  return {
    ...actual,
    getAutoCompactEnabled: mocked.getAutoCompactEnabled,
    getAutoCompactThresholdTokens: mocked.getAutoCompactThresholdTokens,
  };
});

import {
  __resetContextCompactionForTests,
  buildCompactionSeedPrompt,
  buildCompactionSummaryPrompt,
  captureCompactionSummary,
  clearAwaitingSummary,
  getPendingHandoff,
  isAwaitingSummary,
  markAwaitingSummary,
  requestCompaction,
  setCompactionRequester,
  shouldAutoCompactNow,
} from "../../../src/app/services/context-compaction-service.js";

describe("app/services/context-compaction", () => {
  beforeEach(() => {
    __resetContextCompactionForTests();
    mocked.getAutoCompactEnabled.mockReturnValue(true);
    mocked.getAutoCompactThresholdTokens.mockReturnValue(150_000);
  });

  afterEach(() => {
    __resetContextCompactionForTests();
  });

  it("captures the summary once, only for the requesting session", () => {
    markAwaitingSummary("s1");
    expect(isAwaitingSummary()).toBe(true);

    expect(captureCompactionSummary("s2", "otra conversación")).toBe(false);
    expect(isAwaitingSummary()).toBe(true);

    expect(captureCompactionSummary("s1", "  resumen de traspaso  ")).toBe(true);
    expect(isAwaitingSummary()).toBe(false);
    expect(getPendingHandoff()).toEqual({
      summary: "resumen de traspaso",
      sourceSessionId: "s1",
    });

    expect(captureCompactionSummary("s1", "duplicado")).toBe(false);
  });

  it("ignores empty summaries", () => {
    markAwaitingSummary("s1");
    expect(captureCompactionSummary("s1", "   ")).toBe(false);
    expect(getPendingHandoff()).toBeNull();
  });

  it("clearAwaitingSummary resets the awaiting state", () => {
    markAwaitingSummary("s1");
    clearAwaitingSummary();
    expect(isAwaitingSummary()).toBe(false);
    expect(captureCompactionSummary("s1", "x")).toBe(false);
  });

  it("auto-compacts once per session past the threshold", () => {
    expect(shouldAutoCompactNow("s1", 100_000)).toBe(false);
    expect(shouldAutoCompactNow("s1", 160_000)).toBe(true);
    expect(shouldAutoCompactNow("s1", 300_000)).toBe(false);
    expect(shouldAutoCompactNow("s2", 160_000)).toBe(true);
  });

  it("respects the disabled setting", () => {
    mocked.getAutoCompactEnabled.mockReturnValue(false);
    expect(shouldAutoCompactNow("s1", 999_999)).toBe(false);
  });

  it("builds the summary and seed prompts", () => {
    expect(buildCompactionSummaryPrompt()).toContain("resumen de traspaso");
    const seed = buildCompactionSeedPrompt("ESTADO-X");
    expect(seed).toContain("ESTADO-X");
    expect(seed).toContain("CONTEXTO DE CONTINUIDAD");
  });

  it("routes requestCompaction through the registered requester", async () => {
    const requester = vi.fn(async () => undefined);
    setCompactionRequester(requester);
    await requestCompaction("manual");
    expect(requester).toHaveBeenCalledWith("manual");
  });
});
