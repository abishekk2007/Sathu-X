/**
 * Phase 7C — Web Research: search-query generation (pure).
 *
 * Turns a user message into 1–2 concise, effective search queries. Never
 * dumps the whole message verbatim into the engine. Allows a bounded number
 * of queries with a fixed default for the current year so results stay fresh.
 */

import { CHANGING_TOPIC_RE } from "./detect";

const MAX_QUERIES = 2;
const CURRENT_YEAR = new Date().getFullYear();
const CURRENT_YEAR_STR = String(CURRENT_YEAR);

/** Trims obvious conversational noise while keeping the core question. */
const NOISE_EDGES = /^(?:please\s+|hey\s+|hi\s+|so\s+|could\s+you\s+|can\s+you\s+|would\s+you\s+|tell\s+me\s+)/i;

/** If the query already names a year, prefer it; otherwise append the current
 *  year so time-sensitive searches stay current. "price of React" → "price of
 *  React 2026". */
function withYear(query: string): string {
  if (/\b20\d{2}\b/.test(query)) return query;
  return `${query} ${CURRENT_YEAR_STR}`.trim();
}

/** Turns the message into one crisp search query (deduplicated words kept). */
function buildPrimaryQuery(message: string): string {
  let q = message
    .trim()
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(NOISE_EDGES, "")
    .trim();
  // Cap length so we never send a paragraph to the engine.
  if (q.length > 120) {
    q = q.slice(0, 120).replace(/\s+\S*$/, "");
  }
  return withYear(q);
}

/**
 * Builds a bounded set of search queries for the turn.
 *
 * Returns exactly 1 or 2 queries, plus a `news` flag describing whether the
 * results are best fetched from a "news" topic (time-sensitive events) or the
 * general index.
 */
export function buildSearchQueries(message: string): {
  queries: string[];
  news: boolean;
} {
  const primary = buildPrimaryQuery(message);

  // News topic fits clear "what happened / latest news / developments" asks.
  const news =
    /\b(?:what\s+happened|latest|breaking|developments?|news|headlines?|today)\b/i.test(
      message
    ) &&
    CHANGING_TOPIC_RE.test(message);

  const queries = [primary];

  // One bounded refinement is allowed for compound asks: a short, topic-only
  // query focused on the fresh aspect ("latest developments X 2026").
  const freshWord = /\b(?:latest|current|recent|new|updates?|developments?)\b/i.exec(message)?.[0] ?? "latest";
  const refinement = `${freshWord} ${primary}`.slice(0, 140);
  if (queries.length < MAX_QUERIES && refinement !== primary) {
    queries.push(refinement);
  }

  return { queries, news };
}
