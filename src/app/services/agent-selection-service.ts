import { getCurrentAgent, setCurrentAgent } from "../stores/settings-store.js";
import { getStoredModel } from "./model-selection-service.js";
import { logger } from "../../utils/logger.js";
import type { AgentInfo } from "../types/agent.js";

/**
 * Agent selection for the Antigravity backend.
 *
 * agy has no user-facing agent picker — the CLI runs one agent. The service is
 * kept because the bot UI (agent button/menu) still persists a selection name,
 * but there is no server to enumerate agents from.
 */

const DEFAULT_AGENT = "build";

/**
 * "Available agents": agy exposes no list, so the single default is it.
 */
export async function getAvailableAgents(): Promise<AgentInfo[]> {
  return [
    {
      name: DEFAULT_AGENT,
      mode: "primary",
    },
  ];
}

export async function resolveProjectAgent(preferredAgent?: string): Promise<string> {
  const requestedAgent = preferredAgent ?? getCurrentAgent() ?? DEFAULT_AGENT;

  if (requestedAgent !== DEFAULT_AGENT) {
    logger.debug(`[AgentManager] agy has a single agent; keeping requested name "${requestedAgent}"`);
  }

  return requestedAgent;
}

/**
 * Get current agent from settings.
 */
export async function fetchCurrentAgent(): Promise<string> {
  const storedAgent = getCurrentAgent();
  return storedAgent ?? DEFAULT_AGENT;
}

/**
 * Select agent and persist to settings.
 */
export function selectAgent(agentName: string): void {
  logger.info(`[AgentManager] Selected agent: ${agentName}`);
  setCurrentAgent(agentName);
}

/**
 * agy agents have no configured model/variant to apply.
 */
export async function applyAgentConfiguredSettings(_agentName: string): Promise<boolean> {
  void getStoredModel();
  return false;
}

/**
 * Get stored agent from settings (synchronous).
 */
export function getStoredAgent(): string {
  return getCurrentAgent() ?? DEFAULT_AGENT;
}
