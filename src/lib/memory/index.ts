// ---------------------------------------------------------------------------
// Phase 6F — Advanced Memory: public module surface.
//
// The chat route, the memories API and the tests import everything from here:
//   intent      deterministic MEMORY_SAVE/UPDATE/DELETE/LIST/DISABLE/NONE
//   policy      ALLOW / DENY / ASK / UPDATE_EXISTING write-read gates
//   security    credential veto + safe logging
//   extractor   conservative verb-strip → typed candidate
//   store       RLS-scoped CRUD + dedup + master switch
//   retrieval   relevance ranking (MAX 10, enabled only)
//   context     bounded, identity-free prompt block
// ---------------------------------------------------------------------------

export {
  MEMORY_TYPES,
  MEMORY_SOURCES,
  MEMORY_CONFIDENCES,
  MEMORY_INTENTS,
  MEMORY_TYPE_LABELS,
  MAX_MEMORIES_PER_REQUEST,
  MEMORY_CONTEXT_CHAR_BUDGET,
  MEMORY_FETCH_LIMIT,
} from "./types";
export type {
  MemoryType,
  MemorySource,
  MemoryConfidence,
  MemoryIntent,
  MemoryIntentResult,
  $UserMemory,
  MemoryWrite,
  MemorySaveResult,
  PrimaryOutputIntent,
} from "./types";

export { detectMemoryIntent, isMemoryCommand } from "./intent";

export { evaluateSave, evaluateRecall, evaluateDelete } from "./policy";
export type { PolicyDecision, SaveContext } from "./policy";

export { looksSensitive, sanitizeForLog, describeMemoryForLog } from "./security";

export {
  parseMemoryCandidate,
  buildDedupKey,
  inferType,
  normalizeContent,
  deriveImportance,
  mapCategoryToType,
  slugify,
} from "./extractor";

export {
  listMemories,
  findMemoryByKey,
  isMemoryEnabled,
  setMemoryMode,
  upsertMemory,
  patchMemory,
  deleteMemory,
  deleteAllMemories,
  touchMemoryUsage,
  resolveDeleteTarget,
  areMemoriesSimilar,
} from "./store";

export { retrieveRelevantMemories, rankMemories, tokenize, TYPE_SIGNAL_WORDS } from "./retrieval";

export { buildMemoryContextBlock, summarizeMemories } from "./context";