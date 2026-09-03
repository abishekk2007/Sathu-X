// ---------------------------------------------------------------------------
// Phase 8C — Agent Tool Calling: barrel.
// ---------------------------------------------------------------------------

export {
  type AgentToolResult,
  type AgentToolStatus,
  type AgentToolErrorCode,
  type AgentToolName,
  type AgentToolContext,
  type AgentImageSource,
  type AgentRuntimeContext,
  type AgentExecutionResult,
  type ExecuteAgentPlanOptions,
} from "./types";

export {
  type AgentToolAdapter,
  type AgentToolRegistry,
  resolveAgentTool,
  agentToolSkipped,
} from "./registry";

export { buildAdapters } from "./adapters";

export {
  validateAgentPlan,
  executeAgentPlan,
  setDefaultRegistry,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_AGENT_EXECUTION_MS,
  MAX_AGENT_TOOL_CALLS,
  type PlanValidationResult,
} from "./executor";
