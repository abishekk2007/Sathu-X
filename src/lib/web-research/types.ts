/**
 * Phase 7C — Web Research
 *
 * Normalized types for the web-research pipeline. Everything downstream
 * (the chat route, citation UI, and the model prompt) depends only on these
 * shapes — never on a specific provider's (e.g. Tavily's) response format.
 */

/** A single normalized search result, before any selection/filtering. */
export interface SearchResult {
  /** Stable, deduplicated URL for this result. */
  url: string;
  title: string;
  /** Normalized domain/host (e.g. "react.dev"). */
  domain: string;
  /** Short provider snippet (may be empty). */
  snippet: string;
  /** Provider relevance score 0..1 when available. */
  score: number;
  /** Best-effort publication date (YYYY-MM-DD) when the provider reports one. */
  publishedAt: string | null;
  /** Whether this result was retrieved from a "news"-topic search. */
  isNews: boolean;
}

/** A source the app decided to surface to the user (citation). */
export interface WebSource {
  /** 1-based citation number shown in the UI. */
  index: number;
  title: string;
  url: string;
  domain: string;
  publishedAt: string | null;
}

/** Bounded, model-ready evidence extracted from retrieved sources. */
export interface WebEvidenceItem {
  sourceIndex: number;
  sourceTitle: string;
  url: string;
  passage: string;
  publishedAt: string | null;
}

/**
 * Phase 7F — a web image surfaced from an image search. These are app-owned
 * thumbnails (absolute https URLs returned by the provider); they are rendered
 * as a separate UI grid and never streamed as Gemini-generated content.
 */
export interface WebImage {
  /** Absolute https URL of the image (provider-verified; never user-invented). */
  url: string;
  /** Short provider description or the source domain when none was given. */
  title: string;
  /** Provider-supplied caption/description when available. */
  description?: string;
}

/** The complete result of a research run, ready to hand to Gemini + the UI. */
export interface WebResearchResult {
  /** Normalized, selected, deduplicated sources (the citations). */
  sources: WebSource[];
  /** Bounded evidence passages, one per source. */
  evidence: WebEvidenceItem[];
  /** True when any step failed and the run degraded or produced no results. */
  degraded: boolean;
  /** One-line server-side diagnostic (never sent to the client verbatim). */
  status: string;
  /** Phase 7F — web images returned when the user explicitly asked to SEE
   *  images/photos/pictures (empty unless Tavily ran with `include_images`). */
  images: WebImage[];
}
