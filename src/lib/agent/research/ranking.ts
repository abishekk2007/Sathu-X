/**
 * Phase 8E — Research Agent: evidence ranking + confidence (pure).
 *
 * Scores the retrieved evidence for synthesis: how many distinct sources back
 * a claim, whether any are authoritative, and whether retrieval degraded.
 * Produces the 0..1 `confidence` used to seed honest hedging in the model
 * answer. All deterministic — no network, no model.
 */

import type { WebEvidenceItem, WebResearchResult } from "../../web-research/types";
import type {
  ResearchQuality,
  ResearchSourceMeta,
} from "./types";
import { hasAuthoritativeSource } from "./source-type";

/**
 * Ranks evidence entries by a deterministic quality signal so the synthesis
 * layer can present corroborated / higher-value passages first. Pure.
 *
 * The base is the source tier (authoritative first) then passage length
 * (informative passages over near-empty snippets). Never drops a passage —
 * it only reorders, so citation integrity is preserved.
 */
export function rankEvidence(
  evidence: WebEvidenceItem[],
  sourceMeta: ResearchSourceMeta[]
): WebEvidenceItem[] {
  const tierRank = new Map<number, number>();
  for (const s of sourceMeta) {
    // primary=3, secondary=2, tertiary=1
    tierRank.set(s.index, s.tier === "primary" ? 3 : s.tier === "secondary" ? 2 : 1);
  }
  return [...evidence].sort((a, b) => {
    const ta = tierRank.get(a.sourceIndex) ?? 1;
    const tb = tierRank.get(b.sourceIndex) ?? 1;
    if (tb !== ta) return tb - ta;
    return b.passage.length - a.passage.length;
  });
}

/**
 * Computes overall research quality/confidence from the single executed result.
 * Lower confidence when the run degraded, only one source surfaced, or the
 * passages are thin/were snippets-only.
 */
export function evaluateResearchQuality(
  research: WebResearchResult,
  sourceMeta: ResearchSourceMeta[]
): ResearchQuality {
  const evidenceCount = research.evidence.length;
  const totalSources = research.sources.length;
  const multiSource = research.sources.length >= 2;

  const authoritative = hasAuthoritativeSource(sourceMeta);
  const degraded = research.degraded || research.status === "snippets-only" ||
    research.status === "search-failed" || research.status === "no-results";

  // Start from a neutral base and build confidence from positive signals.
  let confidence = 0.1;
  if (evidenceCount > 0) confidence += 0.35;
  if (multiSource) confidence += 0.25;
  if (authoritative) confidence += 0.2;
  if (!degraded && research.status === "ok") confidence += 0.1;
  if (totalSources === 0 || evidenceCount === 0) confidence = 0;

  return {
    confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(2)))),
    evidenceCount,
    degraded,
    hasAuthoritative: authoritative,
    multiSource,
  };
}

/** Builds a short list of human-readable warnings for the model based on quality. */
export function buildQualityWarnings(quality: ResearchQuality): string[] {
  const warnings: string[] = [];
  if (quality.degraded) warnings.push("Retrieval degraded; base claims only on the evidence actually provided.");
  if (!quality.multiSource) warnings.push("Evidence came from a single source; treat as lightly corroborated.");
  if (!quality.hasAuthoritative) warnings.push("No authoritative (gov/edu/official) source surfaced; weight claims accordingly.");
  return warnings;
}
