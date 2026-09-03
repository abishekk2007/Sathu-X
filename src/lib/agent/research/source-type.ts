/**
 * Phase 8E — Research Agent: source trust-tier classification (pure).
 *
 * Maps a source's clean domain to a trust tier (primary/secondary/tertiary).
 * This is a HEURISTIC for synthesis weighting — it never hard-blocks a source
 * and never fabricates authority. Primary = the org/entity itself or an
 * institutional authority; secondary = reputable reference/aggregators;
 * tertiary = everything else (social, forums, low-authority hosts).
 */

import type { ResearchSourceMeta, ResearchSourceTier } from "./types";
import type { WebSource } from "../../web-research/types";

/** Domains that ARE the origin of facts (official entity/organization sites).
 *  Boundary-aware: the authoritative word must end the host token (org/io/edu/official
 *  or a gov/mil/institution) so lookalikes ("notgov.com") never match. */
const PRIMARY_ORIGIN_RE =
  /\.(?:org|io|edu|ac\.[a-z]{2}|gov|mil|int)(?:[/?#]|$)/i;

/** Official product/framework/standard-docs domains that live on a modern
 *  TLD (e.g. react.dev) yet ARE the authoritative origin. Exact host matches
 *  only — never a fuzzy substring match. */
const PRIMARY_OFFICIAL_HOSTS = new Set([
  "react.dev",
  "nextjs.org",
  "nextjs.dev",
  "typescriptlang.org",
  "nodejs.org",
  "python.org",
  "developer.mozilla.org",
  "developer.apple.com",
  "docs.docker.com",
  "kubernetes.io",
  "kubernetes.dev",
  "tc39.es",
  "postgresql.org",
  "sqlite.org",
  "homestone.dev",
]);

/** Institution/organization names whose content is the primary record. */
const PRIMARY_ORG_NAMES =
  /\b(?:who|united\s*nations|wto|imf|world\s*bank|nasa|cdc|fda|nih|noaa|github|mozilla|apple|microsoft|google|npmjs|maven)\b/i;

/** Reputable reference/aggregation hubs — secondary, not the origin. */
const SECONDARY_REFERENCE_RE =
  /\b(?:reuters|apnews|bbc|npr|the\s*guardian|nytimes|wsj|bloomberg|forbes|wired|techcrunch|verge|engadget|arstechnica|zdnet|investopedia|khanacademy|owasp|mdn|w3schools|stackoverflow|stackexchange|medium|dev\.to|coursera|edx)\b/i;

/** Content-less / low-authority hosts we demote to tertiary (never block). */
const TERTIARY_HOST_RE =
  /\b(?:pinterest|tiktok|facebook\.com|reddit\.com|quora|answers\.com|yahoo\s*answers|blogspot|wordpress\.com|wixsite|weebly|tripadvisor|airbnb|yelp)\b/i;

/**
 * Classifies one source (by clean domain + display title + URL) to a tier.
 * Deterministic and pure.
 */
export function classifySourceTier(
  domain: string,
  title: string,
  url: string
): ResearchSourceTier {
  const d = domain.trim().toLowerCase();
  const t = title.trim();
  const u = url.trim();

  // Content-less social/forum hosts are always tertiary — even when they sit
  // on a .org whois (e.g. pinterest is not authoritative because of ".com").
  if (TERTIARY_HOST_RE.test(u) || TERTIARY_HOST_RE.test(d)) return "tertiary";

  // A Wikipedia page is a curated reference (secondary best), even though it
  // is a "primary" brand — its content is still a tertiary aggregation. This
  // must run BEFORE the primary-brand check below.
  if (/\bwikipedia\.org\b/i.test(u) || /\bwikipedia\.org\b/i.test(d)) return "secondary";

  // Official origin: a gov/mil/institution TLD, or the entity's own official
  // site (wikipedia, the standard-body/primary-record names listed above).
  if (PRIMARY_ORIGIN_RE.test(u) || PRIMARY_ORIGIN_RE.test(d)) return "primary";
  if (PRIMARY_OFFICIAL_HOSTS.has(d) || PRIMARY_OFFICIAL_HOSTS.has(d.replace(/^www\./, ""))) return "primary";
  if (PRIMARY_ORG_NAMES.test(t) || PRIMARY_ORG_NAMES.test(d)) return "primary";

  // Reputable reference hubs centralize and cite — secondary.
  if (SECONDARY_REFERENCE_RE.test(t) || SECONDARY_REFERENCE_RE.test(d)) {
    return "secondary";
  }

  return "tertiary";
}

/**
 * Builds the typed source-metadata list from the surfaced citations, assigning
 * each its tier + relevance from the underlying evidence items. Pure.
 */
export function buildSourceMeta(
  sources: WebSource[],
  evidence: import("../../web-research/types").WebEvidenceItem[]
): ResearchSourceMeta[] {
  const relevanceByIndex = new Map<number, number>();
  for (const e of evidence) relevanceByIndex.set(e.sourceIndex, e.passage.length > 0 ? 0.7 : 0);

  return sources.map((s) => {
    const tier = classifySourceTier(s.domain, s.title, s.url);
    const relevance = relevanceByIndex.get(s.index) ?? null;
    return {
      index: s.index,
      title: s.title,
      url: s.url,
      domain: s.domain,
      tier,
      relevance,
    };
  });
}

/** True when any surfaced source came from an authoritative origin. */
export function hasAuthoritativeSource(sources: ResearchSourceMeta[]): boolean {
  return sources.some((s) => s.tier === "primary");
}
