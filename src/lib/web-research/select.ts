/**
 * Phase 7C — Web Research: source selection + deduplication (pure).
 *
 * Takes the normalized search results and reduces them to a bounded, relevant,
 * deduplicated set. Prefers primary/authoritative domains heuristically and
 * never lets one provider response dominate. All logic is deterministic and
 * unit-testable.
 */

import type { SearchResult, WebSource } from "./types";

/** Cap on how many sources we surface and pass to the model. */
export const MAX_SOURCES = 5;

/** Low-relevance floor: results below this provider score are dropped. */
const MIN_SCORE = 0.1;

/** Authorities generally trusted for factual/technical grounding. Boundary-
 *  aware: matches the TLD even when a path/fragment/query follows (e.g.
 *  cdc.gov/x), without matching lookalike words like "government". */
const AUTHORITY_HINTS: Array<{ re: RegExp; boost: number }> = [
  { re: /\.(?:gov|edu|mil)(?:[/?#]|$)/i, boost: 0.15 },
  { re: /\.ac\.[a-z]{2}(?:[/?#]|$)/i, boost: 0.15 },
  { re: /\.(?:wikipedia|wikimedia)\.org(?:[/?#]|$)/i, boost: 0.02 },
];

/** Low-quality / content-farm-ish hosts we demote (never hard-block). */
const DEMOTE_HINTS = /\b(?:pinterest|tiktok|facebook\.com|reddit\.com)\b/i;

/** Normalizes a URL for safe deduplication: lowercased host + path with a
 *  stable default scheme. Never follows redirects or executes anything. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const p of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "ref_src", "fbclid", "gclid"]) {
      u.searchParams.delete(p);
    }
    return `${u.hostname.toLowerCase()}${u.pathname}`.replace(/\/+$/, "") || u.hostname.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** Extract a clean domain (host) from a URL. */
export function domainOf(raw: string): string {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/**
 * Selects + dedupes the most relevant sources from pooled search results.
 * Results are scored by provider relevance plus authority boosts, then capped.
 */
export function selectSources(results: SearchResult[], maxSources = MAX_SOURCES): SearchResult[] {
  const seen = new Set<string>();
  const selected: SearchResult[] = [];

  // Normalize + composite scores.
  const ranked = results
    .filter((r) => r.url && r.score >= MIN_SCORE && r.title)
    .map((r) => {
      const norm = normalizeUrl(r.url);
      let score = r.score;
      for (const { re, boost } of AUTHORITY_HINTS) if (re.test(r.url)) score += boost;
      if (DEMOTE_HINTS.test(domainOf(r.url))) score -= 0.1;
      return { ...r, norm, score };
    })
    .sort((a, b) => b.score - a.score);

  for (const r of ranked) {
    if (seen.has(r.norm)) continue;
    seen.add(r.norm);
    selected.push(r);
    if (selected.length >= maxSources) break;
  }
  return selected;
}

/** Builds the final citation list (re-indexed 1..n) from selected sources. */
export function toWebSources(results: SearchResult[]): WebSource[] {
  return results.map((r, i) => ({
    index: i + 1,
    title: r.title,
    url: r.url,
    domain: r.domain,
    publishedAt: r.publishedAt,
  }));
}
