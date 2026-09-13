import { getAgentDisplayName } from "../types/agent.js";
import { DURATION_ICON, formatDuration } from "./duration-formatter.js";

interface AssistantRunFooterParams {
  agent: string;
  providerID: string;
  modelID: string;
  elapsedMs: number;
}

export function formatAssistantRunFooter({
  agent,
  providerID,
  modelID,
  elapsedMs,
}: AssistantRunFooterParams): string {
  const agentDisplay = getAgentDisplayName(agent);
  return `${agentDisplay} · 🧠 ${providerID}/${modelID} · ${DURATION_ICON} ${formatDuration(elapsedMs)}`;
}
