// ---------------------------------------------------------------------------
// Source intent classification + explicit source reference resolution.
// Phase 5D: Multi-Source Intelligence
// ---------------------------------------------------------------------------

import type { AgentSource } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MultiSourceIntent =
  | "single_source"
  | "multi_source"
  | "compare_sources"
  | "summarize_sources"
  | "search_across_sources"
  | "source_identification"
  | "source_specific"
  | "follow_up_source"
  | "general";

export interface SourceReference {
  /** 0-indexed position in the attached source list. */
  position: number | null;
  /** Exact source id if determinable. */
  sourceId: string | null;
  /** The raw reference phrase. */
  phrase: string;
}

export interface SourceIntentAnalysis {
  strategy: MultiSourceIntent;
  referencedSources: SourceReference[];
  /** Sources to actually retrieve from. null = let strategy decide. */
  explicitSourceIds: string[] | null;
}

// ---------------------------------------------------------------------------
// Multi-source intent patterns
// ---------------------------------------------------------------------------

const COMPARE_PATTERNS: RegExp[] = [
  /\b(?:compare|comparison|contrast|difference|differ|versus|vs\.?)\b/i,
  /\bhow\s+(?:are|is)\s+(?:these|the(?:se)?)\s+(?:two|both|files|documents|sources)/i,
  /\bwhat'?s?\s+(?:the\s+)?difference\s+between/i,
  /\bhow\s+(?:does|do)\s+(?:\w+\s+){0,4}(?:differ|vary|compare)/i,
];

const SUMMARIZE_PATTERNS: RegExp[] = [
  /\b(?:summar(?:ize|ise|ization)|give me (?:a )?summary)\b/i,
  /\b(?:overview|recap|synthesize|synthesis)\b/i,
  /\bsummar(?:ize|ise)\s+(?:all|every|both|these|the\s+(?:files|documents|sources))/i,
  /\bwhat\s+(?:do|does)\s+(?:all\s+)?(?:these|the(?:se)?)\s+(?:files|documents|sources)\s+(?:say|cover|contain)/i,
];

const COMMONALITY_PATTERNS: RegExp[] = [
  /\b(?:common|shared|similar|overlap|overlap)\b/i,
  /\bwhat\s+do\s+(?:these|they|all|both)\s+(?:have\s+in\s+common|share|agree)/i,
  /\bwhat\s+(?:information|content|topics?)\s+appears?\s+in\s+(?:all|both|every)/i,
  /\bwhich\s+(?:topics?|concepts?|ideas?)\s+(?:are|is)\s+(?:shared|common|similar)/i,
];

const DIFFERENCE_PATTERNS: RegExp[] = [
  /\b(?:different|differ|unlike|contrast|distinct|unique)\b/i,
  /\bwhat\s+(?:does|do)\s+(?:\w+\s+){0,3}(?:that|this|it)\s+(?:say|contain)\s+that\s+(?:the\s+)?(?:other|other\s+file)/i,
  /\bhow\s+(?:are|is)\s+(?:these|the(?:se)?)\s+(?:files|documents|sources?)\s+different/i,
];

const SOURCE_IDENTIFICATION_PATTERNS: RegExp[] = [
  /\bwhich\s+(?:document|file|source|notes?|material)\b/i,
  /\bwhich\s+(?:one|file|document)\s+(?:contains?|has|discusses?|covers?|mentions?)/i,
  /\b(?:which|what)\s+(?:file|document|source)\s+(?:has|have|contains?|discusses?)/i,
];

const FOLLOW_UP_PATTERNS: RegExp[] = [
  /\b(?:explain|describe|elaborate|tell me more|go on|continue|expand)\s+(?:that|it|this)\b/i,
  /\b(?:what about|how about)\s+(?:the\s+)?(?:other|another|rest)\b/i,
  /\b(?:more|details?|deeper)\s+(?:on|about|into)\s+(?:that|it|this)\b/i,
];

const ALL_SOURCES_PATTERNS: RegExp[] = [
  /\b(?:all|every|both|each)\s+(?:files?|documents?|sources?|notes?)/i,
  /\b(?:summarize|compare|analyze|analyse|review)\s+(?:all|every|both|each)/i,
  /\bthese\s+(?:files?|documents?|sources?|notes?)/i,
  /\bthe\s+(?:attached|uploaded)\s+(?:files?|documents?|sources?)/i,
];

// ---------------------------------------------------------------------------
// Ordinal → position mapping
// ---------------------------------------------------------------------------

const ORDINAL_POSITION: Record<string, number> = {
  first: 0,
  second: 1,
  third: 2,
  fourth: 3,
  fifth: 4,
  sixth: 5,
  seventh: 6,
  eighth: 7,
  ninth: 8,
  tenth: 9,
  last: -1,
  previous: -1,
  next: 1,
};

// ---------------------------------------------------------------------------
// Source reference extraction
// ---------------------------------------------------------------------------

function extractSourceReferences(
  query: string,
  sources: AgentSource[]
): SourceReference[] {
  const references: SourceReference[] = [];
  const q = query.toLowerCase();

  // Ordinal references: "first file", "second document", "the other file"
  const ordinalRe =
    /\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|previous|next|latest|other)\s+(?:file|document|source|notes?|one)?/gi;
  let ordinalMatch = ordinalRe.exec(q);
  while (ordinalMatch) {
    const word = ordinalMatch[1].toLowerCase();
    let position: number | null = ORDINAL_POSITION[word] ?? null;

    // "last" = last source in the list
    if (word === "last" || word === "previous") {
      position = sources.length - 1;
    }
    // "next" is relative — skip for now (context-dependent)
    if (word === "next") position = null;

    // "other" requires exactly 2 sources
    if (word === "other") {
      if (sources.length === 2) {
        // Assume the user is referring to the one not currently active —
        // default to the second source (index 1) since the first was likely
        // just discussed. The caller can override this via conversation context.
        position = 1;
      } else {
        position = null; // ambiguous with >2 sources
      }
    }

    references.push({
      position,
      sourceId: null,
      phrase: ordinalMatch[0],
    });
    ordinalMatch = ordinalRe.exec(q);
  }

  // "both files" / "all documents" — no specific position, but indicates multi-source
  // These don't produce individual references.

  // "the uploaded report" / "the notes" — these are generic, not positional.
  // They rely on source names which are resolved elsewhere.

  return references;
}

// ---------------------------------------------------------------------------
// Main classification function
// ---------------------------------------------------------------------------

/**
 * Classifies the multi-source intent and extracts explicit source references.
 */
export function classifySourceIntent(
  query: string,
  sources: AgentSource[]
): SourceIntentAnalysis {
  const references = extractSourceReferences(query, sources);
  const q = query.toLowerCase();

  // --- Strategy detection (order matters: most specific first) ---

  // 1. Explicit source-specific reference ("the first file", "the second document")
  const hasExplicitPosition = references.some((r) => r.position !== null);
  if (hasExplicitPosition) {
    const explicitIds = references
      .filter((r) => r.position !== null)
      .map((r) => {
        const pos = r.position!;
        // Handle "last" = sources.length - 1
        return sources[pos >= 0 ? pos : sources.length + pos]?.id ?? null;
      })
      .filter(Boolean) as string[];

    return {
      strategy: "source_specific",
      referencedSources: references,
      explicitSourceIds: explicitIds.length > 0 ? explicitIds : null,
    };
  }

  // 2. Compare
  if (COMPARE_PATTERNS.some((p) => p.test(q))) {
    return {
      strategy: "compare_sources",
      referencedSources: references,
      explicitSourceIds: null,
    };
  }

  // 3. Commonality / shared
  if (COMMONALITY_PATTERNS.some((p) => p.test(q))) {
    return {
      strategy: "multi_source",
      referencedSources: references,
      explicitSourceIds: null,
    };
  }

  // 4. Difference
  if (DIFFERENCE_PATTERNS.some((p) => p.test(q))) {
    return {
      strategy: "compare_sources",
      referencedSources: references,
      explicitSourceIds: null,
    };
  }

  // 5. Source identification ("which document discusses X?")
  if (SOURCE_IDENTIFICATION_PATTERNS.some((p) => p.test(q))) {
    return {
      strategy: "source_identification",
      referencedSources: references,
      explicitSourceIds: null,
    };
  }

  // 6. Summarize all
  if (SUMMARIZE_PATTERNS.some((p) => p.test(q))) {
    // Check if it's "summarize all" or "summarize the first file"
    const isAll = ALL_SOURCES_PATTERNS.some((p) => p.test(q));
    if (isAll || sources.length <= 2) {
      return {
        strategy: "summarize_sources",
        referencedSources: references,
        explicitSourceIds: null,
      };
    }
    // "Summarize these documents" with >2 sources → summarize all
    return {
      strategy: "summarize_sources",
      referencedSources: references,
      explicitSourceIds: null,
    };
  }

  // 7. All-sources patterns
  if (ALL_SOURCES_PATTERNS.some((p) => p.test(q))) {
    return {
      strategy: "summarize_sources",
      referencedSources: references,
      explicitSourceIds: null,
    };
  }

  // 8. Follow-up ("explain that more", "what about the other")
  if (FOLLOW_UP_PATTERNS.some((p) => p.test(q))) {
    return {
      strategy: "follow_up_source",
      referencedSources: references,
      explicitSourceIds: null,
    };
  }

  // 9. Single source vs multi-source based on source count
  if (sources.length <= 1) {
    return {
      strategy: "single_source",
      referencedSources: references,
      explicitSourceIds: null,
    };
  }

  // 10. Multiple sources attached but no explicit multi-source intent
  // → default to searching across sources (retrieval will handle relevance)
  return {
    strategy: "search_across_sources",
    referencedSources: references,
    explicitSourceIds: null,
  };
}
