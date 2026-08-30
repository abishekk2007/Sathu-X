// ---------------------------------------------------------------------------
// Agent types — Phase 5A + Phase 5C + Phase 5D
// ---------------------------------------------------------------------------

/**
 * A generic context source the agent can retrieve from.
 * Documents, pasted text, images, memory, student context, and future
 * sources (web, tools) all share this interface.
 */
export interface AgentSource {
  id: string;
  type: "document" | "pasted_text" | "image" | "memory" | "student_context";
  name: string;
  /** Inline content for sources that store text directly (pasted text). */
  content?: string;
  metadata?: Record<string, unknown>;
}

/** The agent's possible actions for a given user message. */
export type AgentAction =
  | "answer_directly"
  | "retrieve_context";

/**
 * The agent's decision after analysing the user message, attached sources,
 * and current mode. Internal only — never exposed to the client.
 */
export interface AgentDecision {
  action: AgentAction;
  reason: string;
  sourceTypes?: string[];
}

/** A request sent to the generic retrieval interface. */
export interface RetrievalRequest {
  query: string;
  sources: AgentSource[];
  maxChunks?: number;
  maxChars?: number;
}

/** A single retrieved passage from any source type. */
export interface RetrievalResult {
  sourceId: string;
  sourceType: AgentSource["type"];
  sourceName: string;
  content: string;
  score: number;
  confidence?: "high" | "medium" | "low" | "none";
  metadata?: Record<string, unknown>;
  /** Per-signal score breakdown for observability. */
  signals?: {
    exactPhrase: number;
    quotedPhrase: number;
    structuralRef: number;
    headingMatch: number;
    tokenOverlap: number;
    coverage: number;
    proximity: number;
    pageMatch: number;
    headingPhrase: number;
  };
}

/**
 * Full context object passed to the agent pipeline on each chat turn.
 * Everything here is server-side only.
 */
export interface AgentContext {
  userId: string;
  message: string;
  sources: AgentSource[];
  mode: string;
  subjectId?: string;
  topicId?: string;
}

/** Metadata attached to the streaming response for observability. */
export interface AgentResponseMetadata {
  action: AgentAction;
  sourceCount: number;
  retrievalChunks: number;
}
