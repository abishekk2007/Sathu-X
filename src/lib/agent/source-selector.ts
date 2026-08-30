// ---------------------------------------------------------------------------
// Source selection strategy — determines which sources to retrieve from.
// Phase 5D: Multi-Source Intelligence
// ---------------------------------------------------------------------------

import type { AgentSource } from "./types";
import type { MultiSourceIntent } from "./source-intent";
import { tokenizeImportant } from "@/lib/retrieval";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceSelection {
  sourceId: string;
  sourceName: string;
  /** Selection score (0–1). Higher = more relevant. */
  score: number;
  /** Why this source was selected. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum sources to actively retrieve from for discovery queries. */
const DISCOVERY_MAX_SOURCES = 10;

/** Minimum relevance score to include a source in discovery results. */
const DISCOVERY_MIN_SCORE = 0.15;

// ---------------------------------------------------------------------------
// Lightweight source relevance scoring
// ---------------------------------------------------------------------------

/**
 * Scores source relevance against a query using lightweight signals:
 * source name token overlap, filename extension relevance, metadata.
 * No database access — pure in-memory.
 */
export function scoreSourceRelevance(
  source: AgentSource,
  queryTokens: string[]
): number {
  if (queryTokens.length === 0) return 0.5; // no signal → neutral

  let score = 0;
  const maxPossible = queryTokens.length * 2; // each token contributes max 2

  // Source name token overlap
  const nameTokens = new Set(
    source.name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  );

  let matchedTokens = 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token)) {
      score += 2; // exact name match
      matchedTokens++;
    } else {
      // Partial match: check if any name token starts with the query token
      for (const nameToken of nameTokens) {
        if (nameToken.startsWith(token) || token.startsWith(nameToken)) {
          score += 1;
          matchedTokens++;
          break;
        }
      }
    }
  }

  // Coverage bonus
  if (queryTokens.length > 0 && matchedTokens > 0) {
    const coverage = matchedTokens / queryTokens.length;
    score += coverage * 2;
  }

  // Normalize to 0–1
  return maxPossible > 0 ? Math.min(score / maxPossible, 1) : 0;
}

// ---------------------------------------------------------------------------
// Source selection strategies
// ---------------------------------------------------------------------------

/**
 * Selects which sources to retrieve from based on the multi-source intent.
 * Returns sources in priority order.
 */
export function selectSources(
  sources: AgentSource[],
  strategy: MultiSourceIntent,
  query: string,
  explicitSourceIds: string[] | null
): SourceSelection[] {
  const queryTokens = tokenizeImportant(query);

  switch (strategy) {
    case "source_specific":
      return selectExplicitSources(sources, explicitSourceIds);

    case "single_source":
      return selectSingleBest(sources, queryTokens);

    case "compare_sources":
    case "multi_source":
    case "summarize_sources":
      return selectAllRelevant(sources, queryTokens);

    case "source_identification":
      return selectDiscovery(sources, queryTokens);

    case "search_across_sources":
      return selectAllRelevant(sources, queryTokens);

    case "follow_up_source":
      // For follow-up, select all sources (context determines which one)
      return selectAllRelevant(sources, queryTokens);

    case "general":
    default:
      return selectAllRelevant(sources, queryTokens);
  }
}

function selectExplicitSources(
  sources: AgentSource[],
  explicitIds: string[] | null
): SourceSelection[] {
  if (!explicitIds || explicitIds.length === 0) {
    // Fallback: select all
    return sources.map((s, i) => ({
      sourceId: s.id,
      sourceName: s.name,
      score: 1 - i * 0.1,
      reasons: ["fallback: no explicit match found"],
    }));
  }

  return sources
    .filter((s) => explicitIds.includes(s.id))
    .map((s, i) => ({
      sourceId: s.id,
      sourceName: s.name,
      score: 1 - i * 0.05,
      reasons: [`explicitly referenced by the user`],
    }));
}

function selectSingleBest(
  sources: AgentSource[],
  queryTokens: string[]
): SourceSelection[] {
  const scored = sources.map((s) => ({
    source: s,
    score: scoreSourceRelevance(s, queryTokens),
  }));

  scored.sort((a, b) => b.score - a.score);

  // Return only the best source
  if (scored.length === 0) return [];

  const best = scored[0];
  return [
    {
      sourceId: best.source.id,
      sourceName: best.source.name,
      score: best.score,
      reasons: [
        best.score > 0.5
          ? "high name relevance"
          : best.score > 0.2
            ? "moderate name relevance"
            : "only source available",
      ],
    },
  ];
}

function selectAllRelevant(
  sources: AgentSource[],
  queryTokens: string[]
): SourceSelection[] {
  const scored = sources.map((s) => ({
    source: s,
    score: scoreSourceRelevance(s, queryTokens),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.map((s) => ({
    sourceId: s.source.id,
    sourceName: s.source.name,
    score: s.score,
    reasons: [
      s.score > 0.5
        ? "name matches query"
        : s.score > 0.2
          ? "partial name relevance"
          : "included in multi-source set",
    ],
  }));
}

function selectDiscovery(
  sources: AgentSource[],
  queryTokens: string[]
): SourceSelection[] {
  const scored = sources.map((s) => ({
    source: s,
    score: scoreSourceRelevance(s, queryTokens),
  }));

  scored.sort((a, b) => b.score - a.score);

  // For discovery: select sources above threshold, up to max
  const selected: SourceSelection[] = [];
  for (const s of scored) {
    if (selected.length >= DISCOVERY_MAX_SOURCES) break;
    if (selected.length > 0 && s.score < DISCOVERY_MIN_SCORE) break;
    selected.push({
      sourceId: s.source.id,
      sourceName: s.source.name,
      score: s.score,
      reasons: [
        s.score > 0.5
          ? "strong candidate"
          : s.score > 0.2
            ? "moderate candidate"
            : "included for discovery",
      ],
    });
  }

  // Always include at least the top source
  if (selected.length === 0 && scored.length > 0) {
    const top = scored[0];
    selected.push({
      sourceId: top.source.id,
      sourceName: top.source.name,
      score: top.score,
      reasons: ["top candidate"],
    });
  }

  return selected;
}
