// ---------------------------------------------------------------------------
// Phase 6F — Advanced Memory: relevance-ranked retrieval.
//
// Deterministic, explainable ranking — no embeddings, no vector DB. A memory
// scores by:
//   keyword overlap with the current query   (dominant)
//   type topical match                        (preference/… signal words)
//   source explicitness                       (explicit > inferred)
//   confidence tier                           (high > medium > low)
//   importance                                (core facts surface)
//   recency (updated_at + last_used_at)       (tie-breaks)
//
// Only enabled memories are eligible, results are capped at
// MAX_MEMORIES_PER_REQUEST, and duplicates by stable key collapse to the best
// row. Retrieval is fail-open: [] — a memory outage never breaks chat.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";

import type { $UserMemory, MemoryType } from "./types";
import { MAX_MEMORIES_PER_REQUEST } from "./types";
import { listMemories } from "./store";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "are", "was",
  "have", "has", "how", "what", "when", "where", "who", "why", "not", "but",
  "can", "could", "should", "would", "will", "about", "into", "from", "does",
  "want", "need", "please", "tell", "explain",
]);

export function tokenize(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
  return new Set(words.filter((word) => word.length >= 3 && !STOPWORDS.has(word)));
}

/** Topical signal words per memory type. */
export const TYPE_SIGNAL_WORDS: Record<MemoryType, string[]> = {
  preference: [
    "prefer", "preference", "like", "likes", "favourite", "favorite",
    "dislike", "language", "tamil", "hindi", "english", "telugu",
    "communication", "concise", "tone",
  ],
  profile: [
    "name", "college", "school", "university", "course", "degree", "semester",
    "study", "student", "year", "from", "live", "address", "roll",
  ],
  project: [
    "project", "projects", "build", "develop", "app", "website", "code",
    "startup", "repo", "thesis", "working",
  ],
  workflow: [
    "always", "usually", "habit", "routine", "when", "before", "after",
    "process", "step", "workflow", "schedule",
  ],
  instruction: [
    "call", "address", "explain", "respond", "reply", "answer", "never",
    "always", "named", "pronounce",
  ],
  goal: [
    "goal", "goals", "want", "plan", "aim", "target", "prepare", "score",
    "exam", "ambition", "aspire",
  ],
  fact: [],
};

interface ScoredMemory extends $UserMemory {
  relevance: number;
  topical: number;
  score: number;
}

function tokenOverlap(queryTokens: Set<string>, text: string): number {
  let overlap = 0;
  for (const token of tokenize(text)) if (queryTokens.has(token)) overlap += 1;
  return overlap;
}

function recencyBonus(iso: string): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && Date.now() - ms < 7 * 86_400_000 ? 1 : 0;
}

/** Deterministic ranking (exported for tests). */
export function rankMemories(
  memories: $UserMemory[],
  userMessage: string
): ScoredMemory[] {
  const queryTokens = tokenize(userMessage);
  const queryHasTokens = queryTokens.size > 0;
  const seenKeys = new Set<string>();

  const scored = memories
    .filter((row) => row.enabled)
    .map((row) => {
      const relevance = tokenOverlap(queryTokens, row.content);
      const topical = tokenOverlap(
        new Set(TYPE_SIGNAL_WORDS[row.type] ?? []),
        queryHasTokens ? userMessage : ""
      );
      const sourceBoost = row.source === "explicit" ? 1 : 0;
      const confidenceBoost = row.confidence === "high" ? 1 : row.confidence === "medium" ? 0.5 : 0;
      const recency =
        recencyBonus(row.lastUsedAt) + 0.5 * recencyBonus(row.updatedAt);
      // Keyword overlap dominates; explicitness + type match next; importance,
      // confidence and recency break ties.
      const score =
        relevance * 3 +
        topical +
        sourceBoost +
        confidenceBoost +
        row.importance * 0.5 +
        recency;
      return { ...row, relevance, topical, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.importance - a.importance ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    );

  // Collapse legacy duplicates sharing a key, keeping the best-scoring row.
  const distinct: ScoredMemory[] = [];
  for (const row of scored) {
    const dedup = row.key ? row.key : row.id;
    if (seenKeys.has(dedup)) continue;
    seenKeys.add(dedup);
    distinct.push(row);
  }

  // A small set of core facts (importance ≥ 4) always reaches the model when
  // the query itself has no keyword overlap, mirroring Phase 4A behaviour.
  const core: ScoredMemory[] = [];
  const chosen = new Set<string>();
  const coreRanked = [...distinct].sort((a, b) => b.importance - a.importance);
  const usedTokens = distinct.length > 0 || queryHasTokens;
  if (!usedTokens) {
    for (const row of coreRanked) {
      if (row.importance >= 4 && !chosen.has(row.id)) {
        core.push(row);
        chosen.add(row.id);
      }
    }
  }

  const merged = distinct.length > 0 ? distinct : core;
  return merged
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.importance - a.importance ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    )
    .slice(0, MAX_MEMORIES_PER_REQUEST);
}

/**
 * Loads the caller's enabled memories and returns the top MAX_MEMORIES
 * relevant to the current message. Fail-open: any DB problem → [].
 */
export async function retrieveRelevantMemories(
  supabase: SupabaseClient,
  message: string,
  opts?: { max?: number }
): Promise<$UserMemory[]> {
  try {
    const owned = await listMemories(supabase, { enabledOnly: true });
    const ranked = rankMemories(owned, message);
    const max = opts?.max ?? MAX_MEMORIES_PER_REQUEST;
    return ranked.slice(0, max);
  } catch {
    console.error("[memory/retrieval] retrieveRelevantMemories crashed");
    return [];
  }
}