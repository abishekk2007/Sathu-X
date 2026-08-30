// ---------------------------------------------------------------------------
// Conflict detector — identifies disagreements between sources.
// Phase 5D: Multi-Source Intelligence
// ---------------------------------------------------------------------------

import type { RetrievalResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceConflict {
  topic: string;
  sources: Array<{
    sourceId: string;
    sourceName: string;
    evidence: string;
  }>;
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Detects potential conflicts between evidence from different sources.
 * Uses lightweight token overlap and sentence-level comparison.
 */
export function detectConflicts(
  results: RetrievalResult[],
  maxConflicts: number = 5
): SourceConflict[] {
  if (results.length < 2) return [];

  // Group results by source
  const bySource = new Map<string, { name: string; passages: string[] }>();
  for (const r of results) {
    const existing = bySource.get(r.sourceId) ?? { name: r.sourceName, passages: [] };
    existing.passages.push(r.content);
    bySource.set(r.sourceId, existing);
  }

  // If only one source has results, no conflicts possible
  if (bySource.size < 2) return [];

  const sourceEntries = Array.from(bySource.entries());
  const conflicts: SourceConflict[] = [];

  // Compare each pair of sources
  for (let i = 0; i < sourceEntries.length; i++) {
    for (let j = i + 1; j < sourceEntries.length; j++) {
      const [idA, srcA] = sourceEntries[i];
      const [idB, srcB] = sourceEntries[j];

      const pairConflicts = findConflictsBetween(
        idA,
        srcA.name,
        srcA.passages,
        idB,
        srcB.name,
        srcB.passages
      );

      conflicts.push(...pairConflicts);

      if (conflicts.length >= maxConflicts) return conflicts.slice(0, maxConflicts);
    }
  }

  return conflicts.slice(0, maxConflicts);
}

function findConflictsBetween(
  idA: string,
  nameA: string,
  passagesA: string[],
  idB: string,
  nameB: string,
  passagesB: string[]
): SourceConflict[] {
  const conflicts: SourceConflict[] = [];

  // Extract key sentences from each source
  const sentencesA = extractKeySentences(passagesA);
  const sentencesB = extractKeySentences(passagesB);

  // Find sentences with similar structure but different values
  // Pattern: "X is Y" vs "X is Z" where Y ≠ Z
  for (const sentA of sentencesA) {
    for (const sentB of sentencesB) {
      const conflict = detectSentenceConflict(sentA, sentB);
      if (conflict) {
        conflicts.push({
          topic: conflict.topic,
          sources: [
            { sourceId: idA, sourceName: nameA, evidence: sentA },
            { sourceId: idB, sourceName: nameB, evidence: sentB },
          ],
        });
      }

      if (conflicts.length >= 5) return conflicts;
    }
  }

  return conflicts;
}

function extractKeySentences(passages: string[]): string[] {
  const sentences: string[] = [];

  for (const passage of passages) {
    // Split into sentences
    const parts = passage
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20 && s.length < 300);

    sentences.push(...parts);
  }

  // Return at most the most information-dense sentences
  return sentences.slice(0, 20);
}

/**
 * Detects if two sentences from different sources express conflicting
 * information about the same topic.
 */
function detectSentenceConflict(
  sentA: string,
  sentB: string
): { topic: string } | null {
  const tokensA = new Set(
    sentA
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3)
  );
  const tokensB = new Set(
    sentB
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3)
  );

  // Compute overlap
  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
  }
  const totalUnique = new Set([...tokensA, ...tokensB]).size;
  const jaccard = totalUnique > 0 ? overlap / totalUnique : 0;

  // If sentences share ~40–80% of tokens, they're discussing the same topic
  // but may differ on specifics
  if (jaccard < 0.3 || jaccard > 0.9) return null;

  // Check for value conflicts: patterns like "X is Y" vs "X is Z"
  // where the predicate differs
  const valuePatternA = /\bis\s+([\w\s]+?)(?:\.|,|$)/i.exec(sentA);
  const valuePatternB = /\bis\s+([\w\s]+?)(?:\.|,|$)/i.exec(sentB);

  if (valuePatternA && valuePatternB) {
    const valA = valuePatternA[1].toLowerCase().trim();
    const valB = valuePatternB[1].toLowerCase().trim();

    if (valA !== valB && valA.length > 2 && valB.length > 2) {
      // Extract topic from shared tokens
      const sharedTokens = [...tokensA].filter((t) => tokensB.has(t));
      const topic = sharedTokens.slice(0, 3).join(" ");
      return { topic: topic || "shared topic" };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Evidence consolidation
// ---------------------------------------------------------------------------

/**
 * Consolidates evidence from multiple sources, deduplicating essentially
 * identical passages while preserving source attribution.
 */
export function consolidateEvidence(
  results: RetrievalResult[]
): RetrievalResult[] {
  if (results.length <= 1) return results;

  // Group by source — only deduplicate WITHIN the same source, never across
  // sources. A chunk from Document A must never cause a similar chunk from
  // Document B to be discarded.
  const bySource = new Map<string, RetrievalResult[]>();
  for (const r of results) {
    const existing = bySource.get(r.sourceId) ?? [];
    existing.push(r);
    bySource.set(r.sourceId, existing);
  }

  const consolidated: RetrievalResult[] = [];
  for (const [, sourceResults] of bySource) {
    const seen = new Set<string>();
    for (const r of sourceResults) {
      const fingerprint = createFingerprint(r.content);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      consolidated.push(r);
    }
  }

  return consolidated;
}

function createFingerprint(text: string): string {
  // Normalize and take first 200 chars as a rough fingerprint
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
