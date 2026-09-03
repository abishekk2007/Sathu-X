// ---------------------------------------------------------------------------
// Phase 8C — Agent Tool Calling: types.
//
// The executor (`executor.ts`) turns an 8B `AgentPlan` into an
// `AgentExecutionResult` by running each step's CLOSED execution type through
// the typed registry (`registry.ts`). The plan stays immutable (status
// "PLANNED"); execution state lives ONLY here, in a separate result object.
//
// Guarantees:
//   - `AgentToolResult` is fully serializable and NEVER contains API keys,
//     secrets, raw coordinates, stack traces, or internal error detail.
//   - `AgentToolName` is the SAME closed set as `PlanExecutionType` (8B) — the
//     executor never resolves an arbitrary user string to a tool.
//   - Browser-only capabilities (geolocation, camera, mic, Leaflet) never run
//     server-side. Their data is CONSUMED from what the client already sends
//     (`sharedLocation`, `inputModality`, image bytes) via injectable context.
// ---------------------------------------------------------------------------

import type { PlanExecutionType } from "../planner";

/** A tool's runtime outcome for a single step. Closed union. */
export type AgentToolStatus =
  | "SUCCESS"
  | "FAILED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "SKIPPED";

/** Safe error taxonomy exposed to callers (never raw internals). */
export type AgentToolErrorCode =
  | "not_found"
  | "invalid_input"
  | "location_required"
  | "no_evidence"
  | "no_image"
  | "not_configured"
  | "upstream_error"
  | "timed_out"
  | "not_allowed"
  | "internal";

/** The single truthful set of tool names — identical to 8B's execution types. */
export type AgentToolName = PlanExecutionType;

/** Per-step, serializable, secret-free result returned by an adapter. */
export interface AgentToolResult {
  /** Which tool ran (mirrors `AgentPlanStep.executionType`). */
  toolName: AgentToolName;
  /** The plan step this result belongs to. */
  stepId: string;
  status: AgentToolStatus;
  /**
   * Structured, safe output the rest of the pipeline may consume. Never raw
   * bytes, never secrets, never raw coordinates, never stack traces.
   */
  output?: unknown;
  /** Structured failure detail (server-safe copy only). */
  error?: {
    code: AgentToolErrorCode;
    /** Short human-safe message; must never echo secrets or internals. */
    message: string;
  };
  /** Observability metadata — always optional, never sensitive. */
  metadata?: {
    durationMs?: number;
    /** Which capability backed the tool (for logging). */
    source?: string;
    /** How many documents/items were produced (when applicable). */
    count?: number;
  };
}

/** A validated source-image byte payload carried into image adapters. */
export interface AgentImageSource {
  /** Stable key (conversation image key or "upload"). */
  sourceKey: string;
  /** Magic-byte-sniffed MIME type. */
  mimeType: string;
  /** Raw image bytes to hand to the (server-side) provider. */
  bytes: Buffer;
}

/** Everything an adapter needs to run a single step safely. */
export interface AgentToolContext {
  stepId: string;
  /** The user's latest (normalized) request text. */
  message: string;
  /** Chat mode: "general" | "student" | "assistant". */
  mode: string;
  /** Coarsened shared location (Phase 7F) or null when absent. */
  sharedLocation: import("@/lib/location").SharedLocation | null;
  /** "voice" when the turn arrived via speech-to-text. */
  inputModality: "text" | "voice";
  /** Whether fresh image BYTES rode along with the turn. */
  hasFreshImage: boolean;
  /** How many agent sources are attached. */
  sourceCount: number;
  /** Explicit near-me place noun for a MAPS turn (or null). */
  mapQuery: string | null;  /** Prior user turns base text (for refinement / edit). */
  priorUserMessage: string | null;
  /** The retrieval base message for document-visual refinement turns. */
  retrievalMessage: string;
  /** Validated source-image bytes for edit/upload turns (or null). */
  imageSource: AgentImageSource | null;
  /** Validated camera/upload bytes to inline into a vision turn (or null). */
  visionSource: AgentImageSource | null;
  /** Conversation image metadata (keyed refs) for edit resolution. */
  imageRefs: Array<import("@/lib/image-generation").ImageContextRef>;
  /** Confirmed image-edit selection key when deterministically resolvable. */
  editSourceKey: string | null;
  /** Closed-taxonomy image operation for an IMAGE_GENERATION turn. */
  imageOperation: "generate" | "edit" | "document_visual" | null;
  /** Phase 6G IANA timezone for task due-date resolution. */
  timezone?: string;
  /**
   * Narrow input derived solely from the request the client already sends —
   * never a server-side probe of geolocation/camera/mic/Leaflet. These are
   * just the coalesced values the route already holds.
   */
  capabilities: {
    web: boolean;
    realtime: boolean;
    maps: boolean;
    tasks: boolean;
    rag: boolean;
    images: boolean;
    voice: boolean;
    location: boolean;
  };
}

/**
 * Server-side collaborators the executor may need. Everything here defaults to
 * the REAL implementation; tests inject controlled mocks only for the network-
 * capable adapters. No user input ever selects a collaborator — resolution is
 * closed at build time.
 */
export interface AgentRuntimeContext {
  /** Phase 7C orchestrator. */
  researchWeb?: typeof import("@/lib/web-research").researchWeb;
  /** Phase 6A orchestrator. */
  executeRealtimeTool?: typeof import("@/lib/realtime").executeRealtimeTool;
  /** Phase 6G command handler. */
  handleTaskCommand?: typeof import("@/lib/tasks/chat-handler").handleTaskCommand;
  /** Phase 6C/6E image services. */
  generateImage?: typeof import("@/lib/image-generation").generateImage;
  editImage?: typeof import("@/lib/image-generation").editImage;
  generateDocumentVisual?: typeof import("@/lib/image-generation").generateDocumentVisual;
  /** Phase 5C/5D retrieval. */
  retrieveAgentContext?: typeof import("@/lib/agent").retrieveAgentContext;
  orchestrateMultiSourceRetrieval?: typeof import("@/lib/agent").orchestrateMultiSourceRetrieval;
  /** Shared Nominatim geocoder. */
  geocodePlaces?: typeof import("@/lib/map-geocode").geocodePlaces;
  /** Phase 6B realtime decision + decision intents. */
  realtimeDecision?: import("@/lib/agent/query-router").QueryRouteDecision["realtimeDecision"];
  taskIntent?: import("@/lib/tasks").TaskIntentResult;
  planIntent?: import("@/lib/tasks").PlanIntentResult;
  /** Resolved agent source objects (for DOCUMENT_RETRIEVAL). */
  agentSources?: import("../types").AgentSource[];
  /** Authenticated Supabase client (for TASK_MANAGEMENT). */
  supabase?: import("@supabase/supabase-js").SupabaseClient;
  /** Authenticated user id (for retrieval/realtime scoping). */
  userId?: string;
  /** Injectable fetch impl for the geocoder/tests. */
  fetchImpl?: typeof fetch;
  /** Verified evidence for grounded image/edit generations. */
  imageEvidence?: string | null;
  /** Structured evidence items for document-visual generation. */
  documentVisualEvidence?: import("@/lib/image-generation").DocumentVisualEvidenceItem[];
  /** Closed-taxonomy visual type for document-visual generation. */
  documentVisualType?: import("@/lib/image-generation").DocumentVisualType | null;
  /** Refinement base for a document-visual refinement turn. */
  documentVisualRefinementOf?: string | null;
}

/** Final, serializable outcome of executing a whole plan. */
export interface AgentExecutionResult {
  version: 1;
  /** COMPLETED: every step resolved; PARTIAL: at least one non-success with a
   *  pipeline continuation; FAILED: no usable output to continue on. */
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  /** Results keyed by plan step id — one per step. */
  results: AgentToolResult[];
  /** All steps that actually ran a tool (subset of steps). */
  executedStepIds: string[];
  /** Steps marked SKIPPED because a dependency failed/timed out. */
  skippedStepIds: string[];
  metadata: {
    toolCallCount: number;
    durationMs: number;
    /** Which execution type produced the pipeline continuation output. */
    continuationSource?: AgentToolName;
  };
}

/** Options for `executeAgentPlan`. */
export interface ExecuteAgentPlanOptions {
  context: AgentToolContext;
  runtime?: AgentRuntimeContext;
  /** Hard ceilings — bounded, never exceeded (defaults in executor.ts). */
  maxExecutionMs?: number;
  maxToolCalls?: number;
  toolTimeoutMs?: number;
  /** Deterministic seed for tests (unused today; reserved for ordering). */
  now?: () => number;
  /**
   * Phase 8F — optional agent-safety context. When supplied, every tool step
   * is gated deterministically through the tool-safety matrix BEFORE it runs.
   * When absent, execution behaves exactly as before (fully backward
   * compatible). Unknown/unprofiled tools are denied (fail closed).
   */
  safety?: import("../safety").AgentSafetyContext;
}