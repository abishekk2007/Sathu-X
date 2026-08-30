// ---------------------------------------------------------------------------
// Phase 6F — Advanced Memory: shared types, taxonomy and constants.
//
// The typed model is the boundary every other memory module speaks:
//   type       → 7-value taxonomy (preference/profile/project/workflow/
//                instruction/fact/goal)
//   key        → stable dedup identity (e.g. "preference:response_language");
//                empty for legacy rows
//   source     → explicit (user asked) or inferred (behavioral estimate)
//   confidence → high/medium/low (explicit starts high, inferred capped)
//   enabled    → false keeps the row but removes it from recall/context
//   lastUsedAt → recency signal for ranking
//
// Nothing in this file depends on Supabase, Gemini or the network, so every
// layer below is unit-testable with plain fixtures.
// ---------------------------------------------------------------------------

export const MEMORY_TYPES = [
  "preference",
  "profile",
  "project",
  "workflow",
  "instruction",
  "fact",
  "goal",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SOURCES = ["explicit", "inferred"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const MEMORY_CONFIDENCES = ["high", "medium", "low"] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

/** Deterministic intent labels — no LLM is ever consulted for these. */
export const MEMORY_INTENTS = [
  "MEMORY_SAVE",
  "MEMORY_UPDATE",
  "MEMORY_DELETE",
  "MEMORY_LIST",
  "MEMORY_DISABLE",
  "MEMORY_NONE",
] as const;

export type MemoryIntent = (typeof MEMORY_INTENTS)[number];

/** Human label + short description used by the context block and UI. */
export const MEMORY_TYPE_LABELS: Record<MemoryType, { label: string; note: string }> = {
  preference: { label: "Preference", note: "likes, dislikes, communication style" },
  profile: { label: "Profile", note: "identity, studies, background" },
  project: { label: "Project", note: "current or planned projects" },
  workflow: { label: "Workflow", note: "habits and recurring process" },
  instruction: { label: "Instruction", note: "how I should behave" },
  fact: { label: "Fact", note: "standalone durable fact" },
  goal: { label: "Goal", note: "targets and aspirations" },
};

/** A single owned memory as the 6F layers and chat route see it. */
export interface $UserMemory {
  id: string;
  /** Stable dedup identity ("preference:response_language"). */
  key: string;
  /** Human-readable fact ("The user prefers concise answers."). */
  content: string;
  type: MemoryType;
  source: MemorySource;
  confidence: MemoryConfidence;
  /** 1 (nice to know) … 5 (core fact). */
  importance: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
}

/** Payload accepted by the store for create/update. */
export interface MemoryWrite {
  /** Stable dedup key; derived when empty. */
  key?: string;
  content: string;
  type?: MemoryType;
  source?: MemorySource;
  confidence?: MemoryConfidence;
  importance?: number;
  enabled?: boolean;
}

/** Result of a store save — tells the caller whether a row was created or merged. */
export type MemorySaveResult =
  | { kind: "created"; memory: $UserMemory }
  | { kind: "updated"; memory: $UserMemory }
  | { kind: "error" };

/** Deterministic command outcome the chat route turns into a reply. */
export interface MemoryIntentResult {
  intent: MemoryIntent;
  /** Extracted target phrase for DELETE commands. "__all__" means wipe-all. */
  target: string;
  /** Memory master-switch request for MEMORY_DISABLE commands. */
  mode: "off" | "on" | null;
}

/** Maximum memories injected into a request context. */
export const MAX_MEMORIES_PER_REQUEST = 10;

/** Char budget for the whole memory context block (matches Phase 4A cap). */
export const MEMORY_CONTEXT_CHAR_BUDGET = 1200;

/** Ceiling for reads so a pathological table never bloats a chat request. */
export const MEMORY_FETCH_LIMIT = 200;

/** A bounded-range, deterministic primary output mode (used for overrides). */
export type PrimaryOutputIntent =
  | "none"
  | "realtime"
  | "document"
  | "image"
  | "visual_document"
  | "domain"
  | "calculation";