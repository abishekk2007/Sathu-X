/**
 * Phase 7F — Image + Web research: explicit web-intent detection (pure).
 *
 * Decides whether a turn typed ALONGSIDE a fresh uploaded/camera image wants a
 * web search to complement (never replace) the vision pipeline:
 *
 *   - 7F.4  "Where can I buy / find this product online?"
 *   - 7F.5  "What is the latest version / info about this device/product?"
 *   - 7F.1  "Find information about this object."
 *
 * This function WALKS alongside the image, so it only fires when the router
 * also sees the fresh upload (callers gate on `hasUploadedImage`). It is
 * deliberately conservative: a deictic subject ("this/that") must be backed by
 * an explicit commerce/web/identification noun, so ordinary vision asks
 * ("describe this image", "what is this?"), image edits and generations never
 * trigger an accidental web search.
 */

/** Direct commerce/physical-world verbs — the strongest signal. */
const COMMERCE_RE =
  /\b(?:buy|purchase|order|price|prices?|cost|sells?|sold|shop|store|seller|vendor|retail|amazon|ebay)\b/i;

/** Web/information nouns — pairing a deictic subject with these means the user
 *  wants OUTSIDE context about the thing in the photo. */
const WEB_INFO_RE =
  /\b(?:online|web\b|website|internet|product|products|model|version|manual|reviews?|specs?|specifications|details?|information|info\b|identify|where|compatible|availability|stock|launch|release)\b/i;

/** Deictic subject pointing at the photo. */
const DEICTIC_RE = /\b(?:this|that)\b/i;

/** Commands that look outward for context about a photographed thing. */
const LOOKUP_VERB_RE =
  /\b(?:find|search|look\s+up|look\s+for|research|identify)\b/i;

/**
 * True when the message is an explicit "look this up on the web" request that
 * pairs a deictic subject with a commerce/web noun. Pure and deterministic.
 *
 * Two decisive shapes:
 *   1. Direct commerce verb + deictic subject — "buy this", "how much does
 *      this cost", "where can I get this" — with an optional web/noun suffix.
 *   2. A lookup verb ("find/search/look up/what is") + deictic subject +
 *      a web/info/commerce noun — "find this product", "what version is this
 *      device", "find information about this object".
 */
export function detectImageWebSearchIntent(message: string): boolean {
  const text = message.trim();
  if (!text) return false;

  // Shape 1 — commerce verbs dominate any phrasing: "buy/order/price/cost"
  // + deictic subject ("this/that").
  if (COMMERCE_RE.test(text) && DEICTIC_RE.test(text)) return true;

  // Shape 2 — explicit lookup verb + deictic subject + an outward-facing
  // web/info/commerce noun (after the subject).
  if (LOOKUP_VERB_RE.test(text) && DEICTIC_RE.test(text) && WEB_INFO_RE.test(text)) {
    return true;
  }

  // Shape 3 — "what ... this <noun>" where the noun is device/product/model.
  if (/\bwhat\b/i.test(text) && DEICTIC_RE.test(text) && WEB_INFO_RE.test(text)) {
    return true;
  }

  return false;
}