/**
 * Phase 8E — Research Agent: web-vs-web conflict detection (pure).
 *
 * Detects disagreements between retrieved web evidence passages. This reuses
 * the lightweight token-overlap heuristic approach from the 5D document
 * conflict detector but operates on the 7C `WebEvidenceItem` shape (which is
 * grouped ONE passage per source already). Deterministic and bounded.
 */

import type { WebEvidenceItem } from "../../web-research/types";
import type { ResearchConflict } from "./types";

/** Bubble: at most this many conflicts are surfaced to synthesis. */
export const MAX_RESEARCH_CONFLICTS = 3;

/**
 * Tokenizes a passage into a Set of significant (len>=3) lowercase tokens,
 * letting the overlap comparison ignore stop-noise.
 */
function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3)
  );
}

/** A single evidence passage, normalized for value-pattern extraction. */
function valueAfterIs(sent: string): string | null {
  const m = /\bis\s+([\w\s'’-]+?)(?:\.|,|$)/i.exec(sent.trim());
  if (!m) return null;
  const value = m[1].toLowerCase().trim();
  return value.length > 2 ? value : null;
}

/**
 * Detects conflicts between evidence passages. One passage per source in the
 * 7C model, so each comparison is between two distinct retrieved snippets.
 * A conflict is only reported when both passages clearly discuss the same
 * topic (moderate token overlap) yet assert different "X is …" values.
 */
export function detectResearchConflicts(
  evidence: WebEvidenceItem[],
  maxConflicts = MAX_RESEARCH_CONFLICTS
): ResearchConflict[] {
  if (evidence.length < 2) return [];

  const conflicts: ResearchConflict[] = [];
  for (let i = 0; i < evidence.length; i++) {
    for (let j = i + 1; j < evidence.length; j++) {
      const a = evidence[i];
      const b = evidence[j];

      const tokA = tokenSet(a.passage);
      const tokB = tokenSet(b.passage);
      let overlap = 0;
      for (const t of tokA) if (tokB.has(t)) overlap++;
      const total = new Set([...tokA, ...tokB]).size;
      const jaccard = total > 0 ? overlap / total : 0;

      // Same topic = moderate overlap (30–90%). Too-low = unrelated; too-high
      // = near-identical (duplicate, not a conflict).
      if (jaccard < 0.3 || jaccard > 0.9) continue;

      const valA = valueAfterIs(a.passage);
      const valB = valueAfterIs(b.passage);
      if (!valA || !valB || valA === valB) continue;

      const sharedTokens = [...tokA].filter((t) => tokB.has(t)).slice(0, 4);
      conflicts.push({
        topic: sharedTokens.join(" ") || "shared topic",
        sides: [
          { sourceIndex: a.sourceIndex, passage: a.passage },
          { sourceIndex: b.sourceIndex, passage: b.passage },
        ],
      });

      if (conflicts.length >= maxConflicts) return conflicts;
    }
  }
  return conflicts;
}
