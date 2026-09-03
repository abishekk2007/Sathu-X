/**
 * Phase 7C — Web Research: unit tests.
 *
 * Follows the project convention (standalone tsx, no test framework).
 * Covers the pure web-research logic AND the deterministic router routing.
 * External search calls are MOCKED via a global fetch stub — these tests prove
 * pipeline logic, NOT live web connectivity.
 */

import { routeQuery, EXTENSION_POINTS } from "./src/lib/agent";
import type { QueryRouteDecision, QueryRoutingInput } from "./src/lib/agent";
import {
  hasFreshnessSignal,
  shouldResearch,
} from "./src/lib/web-research/detect";
import { buildSearchQueries } from "./src/lib/web-research/queries";
import {
  selectSources,
  toWebSources,
  normalizeUrl,
  domainOf,
  MAX_SOURCES,
} from "./src/lib/web-research/select";
import {
  buildEvidence,
  buildWebGroundingInstruction,
  buildSourcesControlFrame,
  parseSourcesControlFrame,
  stripControlFrame,
  cleanPassage,
  MAX_EVIDENCE_ITEMS,
  MAX_PASSAGE_LENGTH,
} from "./src/lib/web-research/evidence";
import { searchTavily } from "./src/lib/web-research/tavily";
import type {
  SearchResult,
  WebSource,
} from "./src/lib/web-research/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed += 1;
    console.log(`  PASS — ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL — ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual === expected) {
    passed += 1;
    console.log(`  PASS — ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL — ${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  }
}

function section(name: string) {
  console.log(`\n== ${name} ============================================`);
}

// ---------------------------------------------------------------------------
// Router helper
// ---------------------------------------------------------------------------
interface RouteOpts {
  message: string;
  hasSources?: boolean;
  sourceCount?: number;
  priorTurns?: Array<{ role: "user" | "assistant"; content: string }>;
}

function route(opts: RouteOpts): QueryRouteDecision {
  const input: QueryRoutingInput = {
    userId: "test-user-7c",
    message: opts.message,
    hasSources: opts.hasSources ?? false,
    sourceCount: opts.sourceCount,
    priorTurns: opts.priorTurns,
  };
  return routeQuery(input);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function sampleResults(titles: string[]): SearchResult[] {
  return titles.map((title, i) => ({
    url: `https://example.com/${i}.html`,
    title,
    domain: "example.com",
    snippet: `Snippet about ${title} with enough real text to pass the relevance floor.`,
    score: 0.8,
    publishedAt: null,
    isNews: false,
  }));
}

const DUP_RESULTS: SearchResult[] = [
  {
    url: "https://react.dev/version",
    title: "React version",
    domain: "react.dev",
    snippet: "Repeated content A — the actual body of the current version page.",
    score: 0.9,
    publishedAt: null,
    isNews: false,
  },
  {
    url: "https://react.dev/version?utm_source=test",
    title: "React version (dup)",
    domain: "react.dev",
    snippet: "Same resource, different tracking query string — must dedupe.",
    score: 0.85,
    publishedAt: null,
    isNews: false,
  },
  {
    url: "https://news.example.com/ai",
    title: "AI developments",
    domain: "news.example.com",
    snippet: "Fresh AI news body.",
    score: 0.7,
    publishedAt: "2026-08-01",
    isNews: true,
  },
];

// ===========================================================================
section("1. Web-needed classification (freshness detection)");
// ===========================================================================
assert(
  hasFreshnessSignal("What is the latest version of React?") === true,
  "FRESHNESS latest-version"
);
assert(
  hasFreshnessSignal("What are the latest developments in AI?") === true,
  "FRESHNESS latest-developments"
);
assert(
  hasFreshnessSignal("What is the current price of Bitcoin?") === true,
  "FRESHNESS current-price"
);
const CURRENT_YEAR = new Date().getFullYear();
assert(
  hasFreshnessSignal(`Who won the election in ${CURRENT_YEAR - 1}?`) === true,
  "FRESHNESS prior-year-anchor"
);
assert(
  hasFreshnessSignal("What is binary search?") === false,
  "FRESHNESS static-knowledge-no-search"
);
assert(
  hasFreshnessSignal("Explain inheritance in Java") === false,
  "FRESHNESS static-tech-no-search"
);
assert(
  hasFreshnessSignal("Today I studied calculus for my exam") === false,
  "FRESHNESS conversational-today-no-search"
);
assert(
  hasFreshnessSignal("") === false,
  "FRESHNESS empty-message"
);

// ===========================================================================
section("2. shouldResearch (incl. follow-up inheritance)");
// ===========================================================================
assert(
  shouldResearch("What is the latest React version?") === true,
  "SHOULD_RESEARCH latest"
);
assert(
  shouldResearch("What is binary search?") === false,
  "SHOULD_RESEARCH static"
);
assert(
  shouldResearch("Who released it?", [
    { role: "user", content: "What is the latest React version?" },
    { role: "assistant", content: "It is 19." },
  ]) === true,
  "SHOULD_RESEARCH follow-up-inherits"
);
assert(
  shouldResearch("Who released it?", [
    { role: "user", content: "What is binary search?" },
    { role: "assistant", content: "A search algorithm." },
  ]) === false,
  "SHOULD_RESEARCH follow-up-static-prior-no-inherit"
);
assert(
  shouldResearch("Who released it?") === false,
  "SHOULD_RESEARCH bare-followup-no-prior"
);

// ===========================================================================
section("3. Router — normal question routing (GENERAL, no web)");
// ===========================================================================
{
  const d = route({ message: "What is binary search?" });
  assertEqual(d.primaryRoute, "GENERAL", "ROUTE normal static -> GENERAL");
  assertEqual(d.requiresWeb, false, "ROUTE normal requiresWeb false");
}

// ===========================================================================
section("4. Router — current-information routing (WEB_RESEARCH)");
// ===========================================================================
{
  const d = route({ message: "What is the latest version of React?" });
  assertEqual(d.primaryRoute, "WEB_RESEARCH", "ROUTE latest-version -> WEB_RESEARCH");
  assertEqual(d.requiresWeb, true, "ROUTE requiresWeb true");
  assert(
    d.routes.includes("WEB_RESEARCH"),
    "ROUTE routes includes WEB_RESEARCH"
  );

  const d2 = route({ message: "What are the latest developments in AI?" });
  assertEqual(d2.primaryRoute, "WEB_RESEARCH", "ROUTE latest-ai -> WEB_RESEARCH");

  const d3 = route({ message: "What is the current price of Bitcoin?" });
  assertEqual(d3.primaryRoute, "WEB_RESEARCH", "ROUTE current-price -> WEB_RESEARCH");

  const d4 = route({ message: "Who released it?", priorTurns: [
    { role: "user", content: "What is the latest React version?" },
    { role: "assistant", content: "It is 19." },
  ]});
  assertEqual(d4.primaryRoute, "WEB_RESEARCH", "ROUTE follow-up -> WEB_RESEARCH");
  assertEqual(d4.requiresWeb, true, "ROUTE follow-up requiresWeb true");
}

// ===========================================================================
section("5. Router — clarification priority over web");
// ===========================================================================
{
  const d = route({
    message: "what about that?",
    priorTurns: [
      { role: "user", content: "What is the latest version of React?" },
      { role: "assistant", content: "It is 19." },
    ],
  });
  assertEqual(d.primaryRoute, "CLARIFICATION", "ROUTE ambiguous-deictic -> CLARIFICATION, not web");
}

// ===========================================================================
section("6. Router — document/RAG not hijacked by web");
// ===========================================================================
{
  const d = route({
    message: "What is the latest version of React?",
    hasSources: true,
    sourceCount: 1,
  });
  assertEqual(
    d.primaryRoute,
    "DOCUMENT_RAG",
    "ROUTE document+latest stays DOCUMENT_RAG (RAG preserved)"
  );
}

// ===========================================================================
section("7. Extension point activated");
// ===========================================================================
assert(
  EXTENSION_POINTS.WEB_SEARCH === true,
  "EXTENSION POINTS.WEB_SEARCH active"
);

// ===========================================================================
section("8. Search-query generation");
// ===========================================================================
{
  const { queries, news } = buildSearchQueries(
    "What are the latest developments in AI?"
  );
  assert(queries.length >= 1 && queries.length <= 2, "QUERY bounded 1-2");
  assert(/AI/.test(queries[0]), "QUERY primary keeps subject");
  assert(/\b20\d{2}\b/.test(queries[0]), "QUERY appends current year");
  assertEqual(news, true, "QUERY news flag true for 'latest developments'");

  const newsQ = buildSearchQueries("What is the latest news in AI?");
  assertEqual(newsQ.news, true, "QUERY news flag true for headline ask");
}

// ===========================================================================
section("9. URL validation + normalization");
// ===========================================================================
assert(
  normalizeUrl("https://Example.com/A?utm_source=x#frag") === "example.com/A",
  "URL normalize lowercase host + strip tracking + fragment, preserve path case"
);
assert(
  normalizeUrl("https://example.com/path/") === "example.com/path",
  "URL normalize trailing slash"
);
assertEqual(
  domainOf("https://www.react.dev/x"),
  "react.dev",
  "URL domain strips www"
);
assertEqual(
  domainOf("https://react.dev"),
  "react.dev",
  "URL domain bare host"
);

// ===========================================================================
section("10. Duplicate source removal + source selection");
// ===========================================================================
{
  const selected = selectSources(DUP_RESULTS);
  const urls = selected.map((s) => s.url);
  assertEqual(urls.length, 2, "SELECT dedupes to 2 (react.dev + news)");
  assert(
    !urls.some((u) => u.includes("?utm_source")),
    "SELECT tracking variant removed"
  );
  assertEqual(selected[0].url, "https://react.dev/version", "SELECT top relevance kept");

  // Authority boost: a .gov TLD with a PATH (cdc.gov/x) gets +0.15 and is
  // lifted above a slightly-higher generic result — proving the boost applies
  // even when a path follows the TLD.
  const boosted = selectSources([
    {
      url: "https://www.cdc.gov/x",
      title: "CDC",
      domain: "cdc.gov",
      snippet: "Authority body.",
      score: 0.5,
      publishedAt: null,
      isNews: false,
    },
    {
      url: "https://example.com/x",
      title: "Example",
      domain: "example.com",
      snippet: "Generic body.",
      score: 0.6,
      publishedAt: null,
      isNews: false,
    },
  ]);
  assertEqual(boosted[0].url, "https://www.cdc.gov/x", "SELECT authority boosted above score");

  // Cap.
  const many = sampleResults(Array.from({ length: 12 }, (_, i) => `T${i}`));
  assertEqual(selectSources(many).length, MAX_SOURCES, `SELECT capped at ${MAX_SOURCES}`);
}

// ===========================================================================
section("11. Empty search results");
// ===========================================================================
{
  const empty: SearchResult[] = [];
  const selected = selectSources(empty);
  assertEqual(selected.length, 0, "EMPTY selectSources -> 0");
  const evidence = buildEvidence(empty, new Map());
  assertEqual(evidence.length, 0, "EMPTY buildEvidence -> 0");
  const sources: WebSource[] = toWebSources(selected);
  assertEqual(sources.length, 0, "EMPTY toWebSources -> 0");
}

// ===========================================================================
section("12. Search provider failure / timeout / malformed (mocked fetch)");
// ===========================================================================
(async () => {
  const originalFetch = globalThis.fetch;
  process.env.TAVILY_API_KEY = "test-key";

  try {
    // Timeout (abort)
    globalThis.fetch = (() => {
      return new Promise((_, reject) => {
        setTimeout(() => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        }, 1);
      }) as unknown as typeof fetch;
    })() as unknown as typeof fetch;

    const t = await searchTavily("latest React", { apiKey: "test-key" });
    assertEqual(t, null, "PROVIDER timeout -> null (fail open)");
  } finally {
    globalThis.fetch = originalFetch;
  }
})().then(async () => {
  const originalFetch = globalThis.fetch;
  process.env.TAVILY_API_KEY = "test-key";

  // Provider HTTP failure
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: false,
      status: 429,
    }) as unknown as Promise<Response>) as unknown as typeof fetch;
  const httpFail = await searchTavily("latest React", { apiKey: "test-key" });
  assertEqual(httpFail, null, "PROVIDER http-failure -> null (fail open)");

  // Malformed provider response (no results / bad shapes)
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ results: [{ score: 0.9 }] }),
    }) as unknown as Promise<Response>) as unknown as typeof fetch;
  const malformed = await searchTavily("latest React", { apiKey: "test-key" });
  assertEqual(malformed === null || malformed.length === 0, true, "PROVIDER malformed -> filtered/null");

  // Network failure (TypeError)
  globalThis.fetch = (() =>
    Promise.reject(new TypeError("Failed to fetch")) as unknown as Promise<Response>) as unknown as typeof fetch;
  const netFail = await searchTavily("latest React", { apiKey: "test-key" });
  assertEqual(netFail, null, "PROVIDER network-failure -> null (fail open)");

  // Missing key -> abort, no fetch
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ results: [] }),
    }) as unknown as Promise<Response>;
  }) as unknown as typeof fetch;
  const noKey = await searchTavily("latest React", { apiKey: "" });
  assertEqual(noKey, null, "PROVIDER missing-key -> null (no fetch)");
  assertEqual(fetchCalled, false, "PROVIDER no fetch when key absent");

  // Happy path normalization through mocked provider
  globalThis.fetch = (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          results: [
            {
              url: "https://react.dev/version",
              title: "React — Current Version",
              content: "React 19 is the current stable release.",
              score: 0.9,
              publish_date: "2026-06-15T00:00:00Z",
            },
          ],
        }),
    }) as unknown as Promise<Response>) as unknown as typeof fetch;
  const good = await searchTavily("latest React", { apiKey: "test-key" });
  assert(good !== null, "PROVIDER happy-path returns results");
  if (good) {
    assertEqual(good[0].url, "https://react.dev/version", "PROVIDER normalized url");
    assertEqual(good[0].domain, "react.dev", "PROVIDER normalized domain");
    assertEqual(good[0].publishedAt, "2026-06-15", "PROVIDER normalized date");
  }

  globalThis.fetch = originalFetch;

  // =========================================================================
  section("13. Evidence building + size limits");
  // =========================================================================
  {
    const contentByUrl = new Map<string, string>();
    const sel = DUP_RESULTS.slice(0, 2);
    for (const s of sel) contentByUrl.set(s.url, s.snippet);
    const ev = buildEvidence(sel, contentByUrl);
    assert(ev.length <= MAX_EVIDENCE_ITEMS, "EVIDENCE bounded by MAX_EVIDENCE_ITEMS");
    assertEqual(ev.length, sel.length, "EVIDENCE one item per source");
    assertEqual(ev[0].sourceIndex, 1, "EVIDENCE citation index is 1-based to source position");
    assertEqual(ev[0].url, sel[0].url, "EVIDENCE pinned to real url");

    // Clean + cap passage length.
    const longText = "word ".repeat(1000);
    assert(
      cleanPassage(longText).length <= MAX_PASSAGE_LENGTH,
      "EVIDENCE passage capped at MAX_PASSAGE_LENGTH"
    );
  }

  // No fabricated passages: a source with no retrievable body still gets
  // evidence pinned to ITS OWN real snippet (never invented content), and a
  // source with a real body uses that body.
  {
    const sel = sampleResults(["A", "B"]);
    const contentByUrl = new Map<string, string>([
      [sel[0].url, "Real body for A retrieved from the page"],
    ]);
    const ev = buildEvidence(sel, contentByUrl);
    assertEqual(ev.length, sel.length, "EVIDENCE one item per source (snippet fallback)");
    assertEqual(ev[0].passage, "Real body for A retrieved from the page", "EVIDENCE body used when available");
    // B has no body -> falls back to B's own snippet, never fabricated text.
    assert(
      ev[1].passage.includes(sel[1].snippet.slice(0, 20)),
      "EVIDENCE snippet-only source uses its own real snippet (no fabrication)"
    );
    // No evidence item ever references a URL that is not a selected source.
    assert(
      ev.every((e) => sel.some((s) => s.url === e.url)),
      "EVIDENCE all passages pinned to real selected source URLs"
    );
  }

  // =========================================================================
  section("14. Citation mapping + integrity (control frame)");
  // =========================================================================
  {
    const sources: WebSource[] = [
      { index: 1, title: "React — Current Version", url: "https://react.dev/version", domain: "react.dev", publishedAt: "2026-06-15" },
      { index: 2, title: "AI News", url: "https://news.example.com/ai", domain: "news.example.com", publishedAt: null },
    ];
    const research = {
      sources,
      evidence: [],
      images: [],
      degraded: false,
      status: "ok",
    };

    const frame = buildSourcesControlFrame(research);
    assert(frame.startsWith("\u0000WEB_RESEARCH_SOURCES\u0000"), "FRAME has open delimiter");
    assert(frame.endsWith("\u0000END\u0000"), "FRAME has close delimiter");

    const parsed = parseSourcesControlFrame(frame);
    assert(parsed !== null, "FRAME parses");
    if (parsed) {
      assertEqual(parsed.sources.length, 2, "FRAME carries both sources");
      assertEqual(parsed.sources[0].url, "https://react.dev/version", "FRAME real url preserved");
      assertEqual(parsed.degraded, false, "FRAME degraded flag");
    }

    // strip removes the frame from a real head-of-stream payload (frame first,
    // then model text) with no artificial surrounding spaces.
    const headText = `${frame}Here is the grounded answer text.`;
    assert(
      stripControlFrame(headText) === "Here is the grounded answer text.",
      "FRAME stripped from stream head"
    );
    assert(
      !stripControlFrame(headText).includes("\u0000"),
      "FRAME no delimiter remains in clean text"
    );

    // Malformed frame -> parse null, text untouched.
    assert(parseSourcesControlFrame("no frame here") === null, "FRAME absent -> null");
    assert(
      parseSourcesControlFrame("\u0000WEB_RESEARCH_SOURCES\u0000{not json}\u0000END\u0000") === null,
      "FRAME malformed json -> null"
    );
    assert(
      parseSourcesControlFrame("\u0000WEB_RESEARCH_SOURCES\u0000{\"sources\":\"nope\"}\u0000END\u0000") === null,
      "FRAME wrong shape -> null"
    );
  }

  // =========================================================================
  section("15. Grounding instruction + no fabricated sources");
  // =========================================================================
  {
    const research = {
      sources: [
        { index: 1, title: "React — Current Version", url: "https://react.dev/version", domain: "react.dev", publishedAt: "2026-06-15" },
      ],
      evidence: [
        { sourceIndex: 1, sourceTitle: "React — Current Version", url: "https://react.dev/version", passage: "React 19 is current.", publishedAt: "2026-06-15" },
      ],
      images: [],
      degraded: false,
      status: "ok",
    };
    const inst = buildWebGroundingInstruction(research);
    assert(inst.includes("React 19 is current"), "GROUNDING embeds real evidence");
    assert(inst.includes("react.dev/version"), "GROUNDING embeds real url");
    assert(inst.toLowerCase().includes("do not fabricate"), "GROUNDING anti-fabrication rule");
    assert(inst.includes("[1]"), "GROUNDING citation index reference");

    // Empty research -> empty instruction (never invents).
    assertEqual(
      buildWebGroundingInstruction({ sources: [], evidence: [], images: [], degraded: false, status: "none" }),
      "",
      "GROUNDING empty -> blank (no fabrication)"
    );
  }

  // =========================================================================
  section("16. researchWeb orchestration end-to-end (mocked)");
  // =========================================================================
  // Imported lazily so the server-only adapter runs under the same fetch stub.
  const { researchWeb } = await import("./src/lib/web-research");

  {
    // Static question -> no research at all.
    const r = await researchWeb("What is binary search?");
    assertEqual(r.status, "no-research-needed", "RESEARCH static -> no-research-needed");

    // Current question, mocked provider returning data.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            results: [
              { url: "https://react.dev/version", title: "React Current", content: "React 19 body.", score: 0.9, publish_date: "2026-06-15T00:00:00Z" },
              { url: "https://news.example.com/ai", title: "AI News", content: "AI news body.", score: 0.8, publish_date: "2026-08-01T00:00:00Z" },
            ],
          }),
      }) as unknown as Promise<Response>) as unknown as typeof fetch;

    const r2 = await researchWeb("What is the latest version of React?");
    assert(r2.sources.length > 0, "RESEARCH returns real sources");
    assert(r2.evidence.length > 0, "RESEARCH returns real evidence");
    assertEqual(r2.sources[0].url, "https://react.dev/version", "RESEARCH source url real");
    assertEqual(r2.degraded, false, "RESEARCH not degraded on success");

    // Provider failure -> graceful empty degraded (fails open).
    globalThis.fetch = (() =>
      Promise.reject(new TypeError("Failed to fetch")) as unknown as Promise<Response>) as unknown as typeof fetch;
    const r3 = await researchWeb("What is the latest version of React?");
    assertEqual(r3.sources.length, 0, "RESEARCH failure -> no sources (fail open)");
    assertEqual(r3.degraded, true, "RESEARCH failure -> degraded true");

    globalThis.fetch = originalFetch;
  }

  // =========================================================================
  section("RESULTS");
  // =========================================================================
  if (failed === 0) {
    console.log(`\nPhase 7C results: ${passed} passed, 0 failed`);
  } else {
    console.log(`\nPhase 7C results: ${passed} passed, ${failed} failed`);
  }
  process.exit(failed === 0 ? 0 : 1);
});
