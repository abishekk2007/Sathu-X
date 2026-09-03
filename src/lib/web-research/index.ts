/**
 * Phase 7C — Web Research: orchestrator (server-only).
 *
 * Runs the whole (bounded, single-pass) research pipeline for one turn:
 *
 *   build queries → search (Tavily) → select+dedupe sources → evidence
 *
 * It is deliberately NOT agentic: one bounded batch, no recursion, no
 * autonomous loop. Every budget is capped and every failure fails open so the
 * normal Gemini chat answer is never blocked.
 */

import { shouldResearch } from "./detect";
import { buildSearchQueries } from "./queries";
import { selectSources, toWebSources, MAX_SOURCES } from "./select";
import { buildEvidence } from "./evidence";
import { searchTavilyWithImages } from "./tavily";
import type { SearchResult, WebEvidenceItem, WebImage, WebResearchResult, WebSource } from "./types";

/** Total batch budget — at most this many queries run per turn. */
const MAX_QUERY_BUDGET = 2;

/** Total time budget for the entire research operation (ms). */
const TOTAL_BUDGET_MS = 12_000;

/** Upper bound on deduplicated web images handed back in a turn. */
const MAX_IMAGES = 12;

export interface ResearchOptions {
  apiKey?: string;
  /**
   * Phase 7F — run the search even without a freshness signal. The query
   * router supplies this when it decided web research is needed on intent
   * alone (image+web turns, image-result requests).
   */
  force?: boolean;
  /**
   * Phase 7F — request image results from the provider (only when the user
   * explicitly asked to SEE web images; never for ordinary research turns).
   */
  includeImages?: boolean;
}

/**
 * Executes web research for a turn. Returns a fully normalized result —
 * possibly empty/degraded — but never throws and never blocks chat.
 */
export async function researchWeb(
  message: string,
  options: ResearchOptions = {}
): Promise<WebResearchResult> {
  const empty: WebResearchResult = {
    sources: [],
    evidence: [],
    degraded: false,
    status: "no-research-needed",
    images: [],
  };
  // The router decides whether research runs; `force` bypasses the freshness
  // gate so intent-driven research (image+web) can start without one.
  if (!options.force && !shouldResearch(message)) return empty;

  const started = Date.now();
  const { queries, news } = buildSearchQueries(message);
  const budget = Math.min(queries.length, MAX_QUERY_BUDGET);
  const apiKey = options.apiKey ?? process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return { ...empty, status: "not-configured" };
  }

  // Single-pass bounded search (no recursion, no auto-expansion).
  const pooled: SearchResult[] = [];
  const pooledImages: WebImage[] = [];
  const seenImageUrls = new Set<string>();
  let failures = 0;
  for (let i = 0; i < budget; i += 1) {
    const q = queries[i];
    const outcome = await searchTavilyWithImages(q, {
      apiKey,
      news,
      maxResults: 8,
      includeImages: options.includeImages,
    });
    if (outcome) {
      pooled.push(...outcome.results);
      for (const img of outcome.images) {
        if (pooledImages.length >= MAX_IMAGES) break;
        if (seenImageUrls.has(img.url)) continue;
        seenImageUrls.add(img.url);
        pooledImages.push(img);
      }
    } else {
      failures += 1;
    }
    if (Date.now() - started > TOTAL_BUDGET_MS) break;
  }

  if (pooled.length === 0) {
    return {
      sources: [],
      evidence: [],
      images: pooledImages,
      degraded: failures > 0,
      status: failures > 0 ? "search-failed" : "no-results",
    };
  }

  const selected = selectSources(pooled, MAX_SOURCES);
  const sources: WebSource[] = toWebSources(selected);

  // Content map: snippets are already normalized into SearchResult.snippet.
  // No unbounded page fetching — we stay bounded and fail open on the body.
  const contentByUrl = new Map<string, string>();
  for (const s of selected) contentByUrl.set(s.url, s.snippet);
  const evidence: WebEvidenceItem[] = buildEvidence(selected, contentByUrl);

  return {
    sources,
    evidence,
    images: pooledImages,
    degraded: failures > 0 || evidence.length === 0,
    status:
      failures > 0
        ? "partial"
        : evidence.length > 0
          ? "ok"
          : "snippets-only",
  };
}

// Re-export pure helpers so tests/callers use one import surface.
export {
  hasFreshnessSignal,
  shouldInheritResearch,
  shouldResearch,
  detectWebImageRequest,
} from "./detect";
export { detectImageWebSearchIntent } from "./image-intent";
export { buildSearchQueries } from "./queries";
export { MAX_SOURCES, selectSources, toWebSources, normalizeUrl, domainOf } from "./select";
export {
  buildEvidence,
  buildWebGroundingInstruction,
  buildSourcesControlFrame,
  parseSourcesControlFrame,
  stripControlFrame,
  buildHybridControlFrame,
  parseHybridControlFrame,
  buildHybridGroundingInstruction,
} from "./evidence";

export type {
  SearchResult,
  WebSource,
  WebEvidenceItem,
  WebImage,
  WebResearchResult,
} from "./types";
