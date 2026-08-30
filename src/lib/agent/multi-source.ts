// ---------------------------------------------------------------------------
// Multi-source orchestrator — Phase 5D
// Coordinates source intent, selection, retrieval, conflict detection,
// and context assembly across multiple sources.
// ---------------------------------------------------------------------------

import type { AgentSource, RetrievalResult } from "./types";
import { classifySourceIntent, type SourceIntentAnalysis } from "./source-intent";
import {
  selectSources,
  type SourceSelection,
} from "./source-selector";
import { detectConflicts, consolidateEvidence, type SourceConflict } from "./conflict-detector";
import { retrieveAgentContext } from "./context";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MultiSourceAnalysis {
  intent: SourceIntentAnalysis;
  sourceSelections: SourceSelection[];
  conflicts: SourceConflict[];
  /** Number of sources that had ready evidence. */
  readySourceCount: number;
  /** Number of sources that had no relevant evidence. */
  emptySourceCount: number;
  /** Number of sources that had processing errors. */
  errorSourceCount: number;
}

export interface MultiSourceResult {
  results: RetrievalResult[];
  analysis: MultiSourceAnalysis;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_CONTEXT_CHARS = 12_000;
const MAX_CONTEXT_CHUNKS = 8;

/**
 * Per-source budget: minimum chars guaranteed when multiple sources are present.
 * Ensures at least one meaningful passage from each selected source.
 */
const PER_SOURCE_MIN_CHARS = 800;

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestrates multi-source retrieval: classifies intent, selects sources,
 * retrieves evidence, detects conflicts, and assembles bounded context.
 */
export async function orchestrateMultiSourceRetrieval(
  query: string,
  sources: AgentSource[],
  userId: string
): Promise<MultiSourceResult> {
  const maxChars = MAX_CONTEXT_CHARS;
  const maxChunks = MAX_CONTEXT_CHUNKS;

  // 1. Classify multi-source intent
  const intent = classifySourceIntent(query, sources);

  console.log(
    `[MultiSourceIntent] strategy=${intent.strategy} referencedSources=${intent.referencedSources.length} explicitIds=${intent.explicitSourceIds?.length ?? 0}`
  );

  // 2. Select which sources to retrieve from
  const selections = selectSources(
    sources,
    intent.strategy,
    query,
    intent.explicitSourceIds
  );

  for (const s of selections) {
    console.log(
      `[SourceSelection] source=${s.sourceName} score=${s.score.toFixed(2)} reasons=${s.reasons.join("; ")}`
    );
  }

  // 3. Retrieve from selected sources in parallel
  const selectedSourceIds = new Set(selections.map((s) => s.sourceId));
  const selectedSources = sources.filter((s) => selectedSourceIds.has(s.id));

  console.log(
    `[MultiSourceRetrieval] sources=${selectedSources.length} parallel=true strategy=${intent.strategy}`
  );

  // Build per-source retrieval requests
  const retrievalPromises = selectedSources.map(async (source) => {
    try {
      // Use the existing retrieveAgentContext with a single source
      const results = await retrieveAgentContext(
        {
          query,
          sources: [source],
          maxChunks: computePerSourceChunks(intent.strategy, maxChunks, selectedSources.length),
          maxChars: computePerSourceChars(intent.strategy, maxChars, selectedSources.length),
        },
        userId
      );
      return { sourceId: source.id, results, error: null };
    } catch (error) {
      return {
        sourceId: source.id,
        results: [] as RetrievalResult[],
        error: error instanceof Error ? error.message : "unknown error",
      };
    }
  });

  const retrievalResults = await Promise.allSettled(retrievalPromises);

  // 4. Collect results and track source status
  const allResults: RetrievalResult[] = [];
  let readyCount = 0;
  let emptyCount = 0;
  let errorCount = 0;

  for (const result of retrievalResults) {
    if (result.status === "fulfilled") {
      const { sourceId, results, error } = result.value;
      if (error) {
        errorCount++;
        console.error(`[SourceRetrieval] source=${sourceId} error=${error}`);
      } else if (results.length > 0) {
        readyCount++;
        allResults.push(...results);
        console.log(
          `[SourceEvidence] source=${sourceId} chunks=${results.length} confidence=${results[0]?.confidence ?? "none"}`
        );
      } else {
        emptyCount++;
        console.log(`[SourceEvidence] source=${sourceId} chunks=0 (no match)`);
      }
    } else {
      errorCount++;
      console.error(`[SourceRetrieval] promise rejected:`, result.reason);
    }
  }

  // 5. Consolidate evidence (deduplicate similar passages across sources)
  const consolidated = consolidateEvidence(allResults);

  // 6. Detect conflicts between sources
  const conflicts = detectConflicts(consolidated);
  if (conflicts.length > 0) {
    console.log(
      `[CrossSourceAnalysis] conflicts=${conflicts.length} topics=${conflicts.map((c) => c.topic).join(", ")}`
    );
  }

  // 7. Apply budget-aware bounding
  const bounded = applyMultiSourceBudget(consolidated, intent.strategy, maxChunks, maxChars);

  console.log(
    `[ContextAssembly] sources=${readyCount} chunks=${bounded.length} chars=${bounded.reduce((sum, r) => sum + r.content.length, 0)} conflicts=${conflicts.length}`
  );

  return {
    results: bounded,
    analysis: {
      intent,
      sourceSelections: selections,
      conflicts,
      readySourceCount: readyCount,
      emptySourceCount: emptyCount,
      errorSourceCount: errorCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Budget allocation
// ---------------------------------------------------------------------------

/**
 * Computes per-source chunk limit based on strategy and source count.
 */
function computePerSourceChunks(
  strategy: string,
  maxChunks: number,
  sourceCount: number
): number {
  switch (strategy) {
    case "compare_sources":
    case "multi_source":
    case "summarize_sources":
      // Distribute chunks evenly across sources
      return Math.max(2, Math.floor(maxChunks / sourceCount));
    case "source_identification":
      // Discovery: fewer chunks per source
      return Math.max(1, Math.floor(maxChunks / sourceCount));
    default:
      // Single source gets the full budget
      return maxChunks;
  }
}

/**
 * Computes per-source character limit based on strategy and source count.
 */
function computePerSourceChars(
  strategy: string,
  maxChars: number,
  sourceCount: number
): number {
  switch (strategy) {
    case "compare_sources":
    case "multi_source":
    case "summarize_sources":
      return Math.max(PER_SOURCE_MIN_CHARS, Math.floor(maxChars / sourceCount));
    case "source_identification":
      return Math.max(500, Math.floor(maxChars / sourceCount));
    default:
      return maxChars;
  }
}

/**
 * Applies multi-source budget: ensures at least one passage per source
 * when possible, while respecting the global limit.
 */
function applyMultiSourceBudget(
  results: RetrievalResult[],
  strategy: string,
  maxChunks: number,
  maxChars: number
): RetrievalResult[] {
  if (results.length === 0) return [];

  // Group by source
  const bySource = new Map<string, RetrievalResult[]>();
  for (const r of results) {
    const existing = bySource.get(r.sourceId) ?? [];
    existing.push(r);
    bySource.set(r.sourceId, existing);
  }

  // For single-source strategies, use simple bounding
  if (bySource.size <= 1 || strategy === "source_specific" || strategy === "single_source") {
    return simpleBound(results, maxChunks, maxChars);
  }

  // For multi-source strategies: ensure diversity
  const selected: RetrievalResult[] = [];
  let totalChars = 0;

  // Round 1: pick the top result from each source (ensure diversity)
  const topPerSource: RetrievalResult[] = [];
  for (const [, sourceResults] of bySource) {
    const sorted = [...sourceResults].sort((a, b) => b.score - a.score);
    if (sorted[0]) topPerSource.push(sorted[0]);
  }
  topPerSource.sort((a, b) => b.score - a.score);

  for (const r of topPerSource) {
    if (selected.length >= maxChunks) break;
    if (totalChars + r.content.length > maxChars && selected.length > 0) break;
    selected.push(r);
    totalChars += r.content.length;
  }

  // Round 2: fill remaining budget with best remaining chunks
  // Dedup key includes sourceId so chunks from different sources with similar
  // content are never dropped against each other.
  const selectedKeys = new Set(selected.map((r) => `${r.sourceId}::${r.content}`));
  const remaining = results
    .filter((r) => !selectedKeys.has(`${r.sourceId}::${r.content}`))
    .sort((a, b) => b.score - a.score);

  for (const r of remaining) {
    if (selected.length >= maxChunks) break;
    if (totalChars + r.content.length > maxChars) break;
    selected.push(r);
    totalChars += r.content.length;
  }

  // Re-sort by source order to maintain grouping
  return selected;
}

function simpleBound(
  results: RetrievalResult[],
  maxChunks: number,
  maxChars: number
): RetrievalResult[] {
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const bounded: RetrievalResult[] = [];
  let totalChars = 0;

  for (const r of sorted) {
    if (bounded.length >= maxChunks) break;
    if (totalChars + r.content.length > maxChars && bounded.length > 0) break;
    bounded.push(r);
    totalChars += r.content.length;
  }

  return bounded;
}
