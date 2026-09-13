import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getCurrentAgentMock,
  setCurrentAgentMock,
  setCurrentAgentState,
  resetCurrentAgentState,
} = vi.hoisted(() => {
  let currentAgent: string | undefined;

  const getCurrentAgentMock = vi.fn(() => currentAgent);
  const setCurrentAgentMock = vi.fn((agentName: string) => {
    currentAgent = agentName;
  });

  return {
    getCurrentAgentMock,
    setCurrentAgentMock,
    setCurrentAgentState: (agentName?: string) => {
      currentAgent = agentName;
    },
    resetCurrentAgentState: () => {
      currentAgent = undefined;
      getCurrentAgentMock.mockClear();
      setCurrentAgentMock.mockClear();
    },
  };
});

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  __resetSettingsForTests: vi.fn(),
  getCurrentAgent: getCurrentAgentMock,
  setCurrentAgent: setCurrentAgentMock,
}));

vi.mock(
  "../../../src/app/services/model-selection-service.js",
  () => ({
    getStoredModel: vi.fn(() => ({
      providerID: "antigravity",
      modelID: "gemini-3.8-flash-high",
      variant: "default",
    })),
  }),
);

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  applyAgentConfiguredSettings,
  fetchCurrentAgent,
  getAvailableAgents,
  getStoredAgent,
  resolveProjectAgent,
  selectAgent,
} from "../../../src/app/services/agent-selection-service.js";

describe("app/services/agent-selection-service", () => {
  beforeEach(() => {
    resetCurrentAgentState();
  });

  describe("getAvailableAgents", () => {
    it("returns the single default agy agent", async () => {
      await expect(getAvailableAgents()).resolves.toEqual([
        { name: "build", mode: "primary" },
      ]);
    });
  });

  describe("resolveProjectAgent", () => {
    it("keeps the requested agent name", async () => {
      await expect(resolveProjectAgent("plan")).resolves.toBe("plan");
    });

    it("falls back to the stored agent", async () => {
      setCurrentAgentState("plan");

      await expect(resolveProjectAgent()).resolves.toBe("plan");
    });

    it("falls back to build when nothing is stored", async () => {
      await expect(resolveProjectAgent()).resolves.toBe("build");
    });
  });

  describe("fetchCurrentAgent", () => {
    it("returns the stored agent", async () => {
      setCurrentAgentState("plan");

      await expect(fetchCurrentAgent()).resolves.toBe("plan");
    });

    it("defaults to build without a stored agent", async () => {
      await expect(fetchCurrentAgent()).resolves.toBe("build");
    });
  });

  describe("selectAgent", () => {
    it("persists the agent name", () => {
      selectAgent("plan");

      expect(setCurrentAgentMock).toHaveBeenCalledWith("plan");
    });
  });

  describe("getStoredAgent", () => {
    it("returns the stored agent synchronously", () => {
      setCurrentAgentState("plan");

      expect(getStoredAgent()).toBe("plan");
    });

    it("defaults to build without a stored agent", () => {
      expect(getStoredAgent()).toBe("build");
    });
  });

  describe("applyAgentConfiguredSettings", () => {
    it("is a no-op for agy and reports nothing applied", async () => {
      await expect(applyAgentConfiguredSettings("plan")).resolves.toBe(false);
    });
  });
});
