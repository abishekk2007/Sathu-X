/**
 * Phase 7C — Web Research: intent detection (pure).
 *
 * Decides whether a chat turn warrants a web search. This is intentionally
 * NOT keyword-heavy: it looks for RECENCY signals (freshness matters —
 * "latest", "current", a current year, "today's news") and facts that change
 * over time ("price of", "version", "status of", "updates"). Static knowledge
 * questions ("What is binary search?", "Explain inheritance in Java") carry
 * no recency signal and flow through the existing Gemini/RAG path untouched.
 */

const CURRENT_YEAR = new Date().getFullYear();
const CURRENT_YEAR_STR = String(CURRENT_YEAR);
const NEXT_YEAR_STR = String(CURRENT_YEAR + 1);
const PRIOR_YEAR_STR = String(CURRENT_YEAR - 1);

/** Direct freshness words — "latest", "current", "recent", "new in 2026". */
const RECENCY_WORDS =
  /\b(?:latest|current|recent|newest|new\b|up\s*to\s*date|as\s+of\s+(?:now|today)|nowadays|right\s+now)\b/i;

/** Time-relative phrases that demand fresh data. */
const RECENCY_PHRASES =
  /\b(?:today|today['’]s|this\s+(?:week|month|year|quarter)|this\s+year|last\s+week|last\s+month|this\s+quarter|this\s+weekend|as\s+of\s+(?:late|recently)|in\s+recent\s+(?:months|weeks|years))\b/i;

/** Recency hints that are stronger/cleaner than bare "today" (which is often
 *  conversational boilerplate: "today I studied X"). */
const STRONG_RECENCY_WORDS =
  /\b(?:latest|current|recent|newest|up\s*to\s*date)\b/i;

/** Self-updating factual subjects — these should always re-check the web. */
const RECENT_CHANGING_TOPICS =
  /\b(?:price|prices|version|release|releases|announcemen[ct]|chang(?:e|es|ing)|updates?|developments?|news|results|standings|fixtures|schedule|election|candidate|policy|legislation|live\s+score)\b/i;

/** Year mentions that anchor a question to the present/recent past. */
const YEAR_RE = /\b(20\d{2})\b/;

/** "…as of <date>" / "…on <date>" — explicit time anchors. */
const DATE_ANCHOR_RE =
  /\b(?:as\s+of|on|by)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:\s*,\s*\d{4})?\b/i;

/** Verbs that a model might answer from memory but should re-verify when
 *  paired with a recency signal ("announced", "released", "won"). */
const RELEASE_VERBS = /\b(?:announced?|released?|launched?|introduced?|unveiled?|won|sold|happened?|changed?|updated?|decided?)\b/i;

/** Terms that explicitly request current/past-timeframe events. */
const EVENT_QUERY_TERMS =
  /\b(?:happened?|is\s+happening|going\s+on|went\s+down|breaking\s+news|headlines?)\b/i;

/**
 * True when the message carries a freshness signal strong enough to justify
 * a web search. Pure and deterministic.
 */
export function hasFreshnessSignal(message: string): boolean {
  const text = message.trim();
  if (!text) return false;

  // A current/recent year explicitly named is a strong recency anchor.
  if (
    YEAR_RE.test(text) &&
    (text.includes(CURRENT_YEAR_STR) ||
      text.includes(PRIOR_YEAR_STR) ||
      text.includes(NEXT_YEAR_STR))
  ) {
    return true;
  }

  // Explicit date anchors ("as of March 2026", "on June 15") only matter for
  // facts, but pairing with a changing-topic or release verb keeps them
  // decisive without over-triggering on "on my birthday".
  if (DATE_ANCHOR_RE.test(text) && (RECENT_CHANGING_TOPICS.test(text) || EVENT_QUERY_TERMS.test(text))) {
    return true;
  }

  // Strong explicit words alone are decisive.
  if (STRONG_RECENCY_WORDS.test(text)) {
    return true;
  }

  // Softer recency phrases only win when paired with a changing/event topic
  // or a release verb — so "today I studied calculus" never searches, but
  // "what are today's top stories?" and "latest React version" do.
  if (RECENCY_WORDS.test(text) || RECENCY_PHRASES.test(text)) {
    return RECENT_CHANGING_TOPICS.test(text) || EVENT_QUERY_TERMS.test(text) || RELEASE_VERBS.test(text);
  }

  return false;
}

/** Verifiable churn words for the query builder's news/generic split. */
export const CHANGING_TOPIC_RE = RECENT_CHANGING_TOPICS;

/**
 * True when a bare follow-up ("and its latest release?") should inherit a web
 * search from the prior turn. Only positive when the previous user turn was
 * itself a web-research turn, so it never invents research out of nowhere.
 */
export function shouldInheritResearch(
  message: string,
  priorTurns: Array<{ role: string; content: string }>
): boolean {
  if (!message || message.trim().length > 80) return false;
  const lastUser = [...priorTurns].reverse().find((t) => t.role === "user");
  if (!lastUser) return false;
  // The prior turn must itself be a research-worthy question.
  return hasFreshnessSignal(lastUser.content);
}

/**
 * High-level "does this turn need web research?" decision used by the query
 * router. Pure and deterministic; composition of the freshness signal and
 * follow-up inheritance.
 */
export function shouldResearch(
  message: string,
  priorTurns: Array<{ role: string; content: string }> = []
): boolean {
  if (hasFreshnessSignal(message)) return true;
  return shouldInheritResearch(message, priorTurns);
}

/**
 * Phase 7F — explicit image RESULT requests: "show me images of…", "find
 * pictures of…", "give me photos of…". These are about the USER SEEING web
 * images (the results grid), NOT analyzing a camera photo and NOT generating
 * images — so they must only route research with `include_images`, never touch
 * the camera/vision or image-generation pipelines (whose routers run first).
 *
 * Deliberately conservative: the verb must clearly ask to display/fetch image
 * results, so "describe this image" / "generate an image of a dragon" never
 * match, and "latest npm images" (bare noun, no display verb) won't either.
 */
export function detectWebImageRequest(message: string): boolean {
  const text = message.trim();
  if (!text) return false;

  const SHOW_ME =
    /\b(?:show|get|find|give|send|fetch|pull\s+up|look\s+up)\s+(?:me\s+)?(?:images?|pictures?|pics|photos?)\s+(?:of|for|about)\b/i;
  const NOUN_FIRST = /^(?:images?|pictures?|pics|photos?)\s+(?:of|for|about)\b/i;
  const WHAT_LOOKS =
    /\bwhat\s+(?:does|do)\b.{0,40}\b(?:look\s+like)\b/i;

  return SHOW_ME.test(text) || NOUN_FIRST.test(text) || WHAT_LOOKS.test(text);
}
