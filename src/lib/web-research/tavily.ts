/**
 * Phase 7C — Web Research: Tavily search adapter (server-only).
 *
 * Talks to the Tavily REST API and normalizes its responses into our
 * provider-agnostic SearchResult shapes. Secrets stay server-side (env var
 * TAVILY_API_KEY); nothing Tavily-specific leaks into the rest of the app.
 *
 * All failures fail OPEN: null is returned on any error so the chat route can
 * degrade gracefully to a normal Gemini answer instead of crashing.
 */

import type { SearchResult, WebImage } from "./types";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Phase 7F — the raw, unfiltered image URLs + captions Tavily returns at the
 * top level of the response when `include_images` is enabled.
 */
interface TavilyImagesPayload {
  images?: unknown[];
  image_descriptions?: unknown[];
}

/** Normalized domain from a URL (tiny, dependency-free). */
function domainOf(raw: string): string {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}

/** Best-effort YYYY-MM-DD from Tavily's publish_date (ISO 8601). */
function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

interface TavilyResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  raw_content?: unknown;
  score?: unknown;
  publish_date?: unknown;
}

/** Normalize one top-level Tavily image entry into a safe WebImage (https
 *  only, bounds applied). Non-http(s) URLs (data:/blob:/) are dropped so a
 *  remote page can never smuggle an inline/embedded payload through the grid. */
function toWebImage(
  url: unknown,
  index: number,
  descriptions: string[]
): WebImage | null {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) return null;
  const description =
    typeof descriptions[index] === "string" ? (descriptions[index] as string).trim() : "";
  return {
    url,
    title: description || "Web image",
    ...(description ? { description } : {}),
  };
}

/**
 * Executes a single search against Tavily and returns normalized results.
 * `news` selects Tavily's "news" topic for time-sensitive event queries.
 * Opting into `includeImages` requests image results (the caller decides, based
 * on a pure intent check — never turned on for ordinary research turns).
 * Returns null on any failure (key missing, network, timeout, malformed).
 */
export async function searchTavily(
  query: string,
  opts: { apiKey?: string; news?: boolean; maxResults?: number; includeImages?: boolean } = {}
): Promise<SearchResult[] | null> {
  const outcome = await tavilySearch(query, opts);
  return outcome?.results ?? null;
}

/**
 * Phase 7F — same search as `searchTavily`, but ALSO returns the top-level
 * image results (only populated when `includeImages` was set). Backwards
 * compatible: `searchTavily` keeps its exact single-shaped return, so the 7C
 * callers/tests are untouched.
 */
export async function searchTavilyWithImages(
  query: string,
  opts: { apiKey?: string; news?: boolean; maxResults?: number; includeImages?: boolean } = {}
): Promise<{ results: SearchResult[]; images: WebImage[] } | null> {
  return tavilySearch(query, opts);
}

async function tavilySearch(
  query: string,
  opts: { apiKey?: string; news?: boolean; maxResults?: number; includeImages?: boolean } = {}
): Promise<{ results: SearchResult[]; images: WebImage[] } | null> {
  const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        topic: opts.news ? "news" : "general",
        search_depth: "basic",
        time_range: opts.news ? "month" : "year",
        max_results: opts.maxResults ?? 8,
        include_answer: false,
        include_raw_content: false,
        // Phase 7F — image results are requested ONLY when the turn explicitly
        // asked for images/photos; ordinary research turns stay text-only.
        include_images: Boolean(opts.includeImages),
      }),
    });

    if (!res.ok) {
      // 401 invalid key, 429 rate limit, etc. — fail open, never throw.
      console.error(
        `[web-research] Tavily search failed status=${res.status} topic=${opts.news ? "news" : "general"}`
      );
      return null;
    }

    const body = (await res.json()) as {
      results?: TavilyResult[];
      images?: unknown[];
      image_descriptions?: unknown[];
    } satisfies TavilyImagesPayload;
    const results = (body.results ?? [])
      .map((r) => {
        const url = typeof r.url === "string" ? r.url : "";
        if (!url) return null;
        const score = typeof r.score === "number" ? r.score : 0;
        const snippet =
          typeof r.content === "string"
            ? r.content
            : typeof r.raw_content === "string"
              ? r.raw_content
              : "";
        return {
          url,
          title: typeof r.title === "string" ? r.title : "",
          domain: domainOf(url),
          snippet,
          score,
          publishedAt: normalizeDate(r.publish_date),
          isNews: Boolean(opts.news),
        } satisfies SearchResult;
      })
      .filter((r): r is SearchResult => r !== null);

    const rawImages = opts.includeImages && Array.isArray(body.images) ? body.images : [];
    const descriptions: string[] =
      opts.includeImages && Array.isArray(body.image_descriptions)
        ? body.image_descriptions.filter((d): d is string => typeof d === "string")
        : [];
    const images = rawImages
      .map((url, i) => toWebImage(url, i, descriptions))
      .filter((img): img is WebImage => img !== null)
      .slice(0, 12);

    return results.length > 0 || images.length > 0
      ? { results, images }
      : null;
  } catch (error) {
    // AbortError on timeout, TypeError on network failure — fail open.
    console.error(
      `[web-research] Tavily search ${controller.signal.aborted ? "timeout" : "failed"}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
