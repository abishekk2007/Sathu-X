/**
 * Phase 8F — Agent Safety: barrel.
 *
 * A deterministic safety/control boundary around the agent. It reuses (never
 * duplicates) the existing secret / raw-location / prompt-injection
 * primitives from the memory module and the closed tool set from 8C/8B.
 */

export { buildToolSafetyMatrix, indexToolSafetyMatrix, evaluateToolSafety, coversAllExecutionTypes } from "./policy";
export {
  classifyUserAction,
  contentLooksInjected,
  neutralizeContent,
  screenUntrustedContent,
  screenPersistProposal,
  reasonCodeOf,
} from "./guards";
export {
  createConfirmationTicket,
  verifyConfirmation,
  CONFIRMATION_TTL_MS,
  type ConfirmationTicket,
} from "./confirmation";
export {
  screenToolResultText,
  ownerMatches,
  safeLogText,
  type ToolResultScreen,
} from "./sanitize";
export { SAFETY_PREAMBLE, buildSafetyRefusalNote } from "./context";

export type {
  SafetyAction,
  SafetyReasonCode,
  AgentSafetyDecision,
  SafetyRisk,
  SafetySideEffect,
  ToolSafetyProfile,
  RequestSafety,
  AgentSafetyContext,
} from "./types";
