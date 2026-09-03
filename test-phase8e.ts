// ---------------------------------------------------------------------------
// Phase 8E — Research Agent: A–R automated tests.
// Run with: npx tsx test-phase8e.ts
//
// Mocks only, no network / no Tavily / no Gemini. Phase 8E is a pure,
// network-free ORCHESTRATION layer that ANALYSES the single already-executed
// Phase 7C web result. It must NEVER issue its own search. Sections:
//   A — research depth classification (NONE/QUICK/STANDARD/DEEP)
//   B — research need classification (freshness/dedicated/route)
//   C — source trust-tier classification (primary/secondary/tertiary)
//   D — source metadata build (indexes + relevance mapping)
//   E — authoritative-source detection
//   F — evidence ranking (tier-first, length-tiebreak, never drops passages)
//   G — research quality / confidence assessment
//   H — quality warnings (degraded / single-source / non-authoritative)
//   I — web-vs-web conflict detection (found / absent / bounded / no-false)
//   J — full orchestrateResearch pipeline (populated / empty / degraded)
//   K — synthesis block builder (fenced, additive, never fabricated URLs)
//   L — plan ceilings (bounded, mirror the 7C caps)
//   M — purity guarantee (synchronous, side-effect-free, network-free)
//   N — degradation honesty (low confidence + warning on failed search)
//   O — citation integrity (ranked evidence preserves source attribution)
//   P — safety boundary (untrusted-data fence + no memory auto-store)
//   Q — ResearchInput tolerance (success / degraded / empty shapes)
//   R — regression surface (barrel exports present)
// ---------------------------------------------------------------------------

import {
  orchestrateResearch,
  buildResearchSynthesisBlock,
  classifyResearchDepth,
  classifyResearchNeed,
  classifySourceTier,
  buildSourceMeta,
  hasAuthoritativeSource,
  rankEvidence,
  evaluateResearchQuality,
  buildQualityWarnings,
  detectResearchConflicts,
  MAX_RESEARCH_CONFLICTS,
} from "./src/lib/agent/research";
import type {
  ResearchContext,
  ResearchDepth,
  ResearchInput,
  ResearchSourceMeta,
  ResearchSourceTier,
} from "./src/lib/agent/research";
import type { WebEvidenceItem, WebResearchResult } from "./src/lib/web-research/types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function assertEqual<T>(actual: T, expected: T, name: string) {
  assert(
    actual === expected,
    name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function assertTrue(actual: boolean, name: string, detail?: string) {
  assert(actual === true, name, detail);
}

function assertFalse(actual: boolean, name: string, detail?: string) {
  assert(actual === false, name, detail);
}

function evidence(
  index: number,
  title: string,
  url: string,
  passage: string,
  publishedAt: string | null = null
): WebEvidenceItem {
  return { sourceIndex: index, sourceTitle: title, url, passage, publishedAt };
}

function okResult(
  sources: Array<{ title: string; url: string; index: number }>,
  ev: WebEvidenceItem[],
  degraded = false,
  status = "ok"
): WebResearchResult {
  return {
    sources: sources.map((s) => ({
      index: s.index,
      title: s.title,
      url: s.url,
      domain: new URL(s.url).hostname.replace(/^www\./, ""),
      publishedAt: null,
    })),
    evidence: ev,
    degraded,
    status,
    images: [],
  };
}

function emptyResult(): WebResearchResult {
  return { sources: [], evidence: [], degraded: false, status: "no-research-needed", images: [] };
}

// ---------------------------------------------------------------------------
// A — Research depth classification
// ---------------------------------------------------------------------------

function testA() {
  // No freshness, static/mixed route -> NONE.
  assertEqual(
    classifyResearchDepth(false, "What is binary search?", "CHAT") as ResearchDepth,
    "NONE",
    "A1 no-fresh static route -> NONE"
  );
  assertEqual(
    classifyResearchDepth(false, "Explain inheritance in Java.", "DOCUMENT_RAG") as ResearchDepth,
    "NONE",
    "A2 no-fresh document route -> NONE"
  );

  // No freshness but research-dedicated route -> QUICK (shallow layer only).
  assertEqual(
    classifyResearchDepth(false, "latest npm images", "WEB_RESEARCH") as ResearchDepth,
    "QUICK",
    "A3 dedicated route w/o fresh -> QUICK"
  );

  // Fresh signal + light topic -> STANDARD.
  assertEqual(
    classifyResearchDepth(true, "What is the latest React version?", "WEB_RESEARCH") as ResearchDepth,
    "STANDARD",
    "A4 fresh + fresh-topic -> STANDARD"
  );

  // Fresh/compare/deep topic -> DEEP.
  assertEqual(
    classifyResearchDepth(true, "Compare the latest React vs Vue performance impact on large apps.", "HYBRID") as ResearchDepth,
    "DEEP",
    "A5 fresh compound/compare -> DEEP"
  );
  assertEqual(
    classifyResearchDepth(true, "What is the difference between the new Gemini models?", "WEB_RESEARCH") as ResearchDepth,
    "DEEP",
    "A6 fresh difference/between -> DEEP"
  );

  // Fresh signal but no topic-fresh word -> QUICK.
  assertEqual(
    classifyResearchDepth(true, "please tell me anything about this water well problem", "WEB_RESEARCH") as ResearchDepth,
    "QUICK",
    "A7 fresh generic -> QUICK"
  );

  // Dedicated route with compare wording stays QUICK (no fresh depth scaling).
  assertEqual(
    classifyResearchDepth(false, "compare two things", "WEB_RESEARCH") as ResearchDepth,
    "QUICK",
    "A8 dedicated compare no-fresh -> QUICK"
  );
}

// ---------------------------------------------------------------------------
// B — Research need classification
// ---------------------------------------------------------------------------

function testB() {
  // Freshness drives need regardless of route.
  assertTrue(
    classifyResearchNeed(true, false, "CHAT"),
    "B1 freshness alone -> need"
  );
  // Dedicated drives need.
  assertTrue(
    classifyResearchNeed(false, true, "CHAT"),
    "B2 dedicated alone -> need"
  );
  // No fresh, no dedicated, non-research route -> no need.
  assertFalse(
    classifyResearchNeed(false, false, "CHAT"),
    "B3 nothing -> no need"
  );
  // No fresh, no dedicated, but research route -> need (route-driven).
  assertTrue(
    classifyResearchNeed(false, false, "WEB_RESEARCH"),
    "B4 route-driven -> need"
  );
  assertTrue(
    classifyResearchNeed(false, false, "HYBRID_RAG_WEB"),
    "B5 hybrid route -> need"
  );
  // Document route alone does not imply web need unless fresh/dedicated.
  assertFalse(
    classifyResearchNeed(false, false, "DOCUMENT_RAG"),
    "B6 document route w/o signal -> no need"
  );
}

// ---------------------------------------------------------------------------
// C — Source trust-tier classification
// ---------------------------------------------------------------------------

function testC() {
  // Official origin / gov -> primary.
  assertEqual(
    classifySourceTier("cdc.gov", "CDC Home", "https://www.cdc.gov/flu/index.html") as ResearchSourceTier,
    "primary",
    "C1 gov -> primary"
  );
  assertEqual(
    classifySourceTier("react.dev", "React Documentation", "https://react.dev/") as ResearchSourceTier,
    "primary",
    "C2 official brand -> primary"
  );
  assertEqual(
    classifySourceTier("en.wikipedia.org", "Gemini (language model)", "https://en.wikipedia.org/wiki/Gemini_(language_model)") as ResearchSourceTier,
    "secondary",
    "C3 wikipedia -> secondary (reference)"
  );
  assertEqual(
    classifySourceTier("reuters.com", "Reuters World News", "https://www.reuters.com/world/") as ResearchSourceTier,
    "secondary",
    "C4 reputable reference -> secondary"
  );
  assertEqual(
    classifySourceTier("www.reddit.com", "r-programming", "https://www.reddit.com/r/programming/") as ResearchSourceTier,
    "tertiary",
    "C5 social/forum -> tertiary"
  );
  assertEqual(
    classifySourceTier("unknown-blog.example.com", "A random guide", "https://unknown-blog.example.com/guide") as ResearchSourceTier,
    "tertiary",
    "C6 unrecognized -> tertiary"
  );
  assertEqual(
    classifySourceTier("notgov.com", "not a gov", "https://notgov.com/x") as ResearchSourceTier,
    "tertiary",
    "C7 lookalike gov TLD -> tertiary (boundary-aware)"
  );
  // edu -> primary.
  assertEqual(
    classifySourceTier("stanford.edu", "Stanford Research", "https://cs.stanford.edu/") as ResearchSourceTier,
    "primary",
    "C8 edu -> primary"
  );
}

// ---------------------------------------------------------------------------
// D — Source metadata build
// ---------------------------------------------------------------------------

function testD() {
  const sources = okResult(
    [
      { title: "CDC", url: "https://www.cdc.gov/flu/", index: 1 },
      { title: "Random Blog", url: "https://random.example/guide", index: 2 },
    ],
    [
      evidence(1, "CDC", "https://www.cdc.gov/flu/", "CDC guidance on flu vaccination."),
      evidence(2, "Random Blog", "https://random.example/guide", "A guide about flu."),
    ]
  );
  const meta = buildSourceMeta(sources.sources, sources.evidence);
  assertEqual(meta.length, 2, "D1 one meta per source");
  assertEqual(meta[0].index, 1, "D2 index preserved");
  assertEqual(meta[0].tier, "primary", "D3 cdc -> primary in meta");
  assertEqual(meta[1].tier, "tertiary", "D4 unknown -> tertiary in meta");
  assertEqual(meta[0].relevance, 0.7, "D5 relevance from evidence set");
  assertEqual(meta[0].domain, "cdc.gov", "D6 clean domain assigned");
}

// ---------------------------------------------------------------------------
// E — Authoritative-source detection
// ---------------------------------------------------------------------------

function testE() {
  const withAuth: ResearchSourceMeta[] = [
    { index: 1, title: "CDC", url: "https://cdc.gov", domain: "cdc.gov", tier: "primary", relevance: 0.7 },
  ];
  const noAuth: ResearchSourceMeta[] = [
    { index: 1, title: "A Blog", url: "https://a.example/", domain: "a.example", tier: "tertiary", relevance: 0.5 },
  ];
  assertTrue(hasAuthoritativeSource(withAuth), "E1 primary present -> authoritative");
  assertFalse(hasAuthoritativeSource(noAuth), "E2 no primary -> not authoritative");
  assertFalse(hasAuthoritativeSource([]), "E3 empty -> not authoritative");
}

// ---------------------------------------------------------------------------
// F — Evidence ranking
// ---------------------------------------------------------------------------

function testF() {
  const meta: ResearchSourceMeta[] = [
    { index: 1, title: "Tier3", url: "https://a.example/1", domain: "a.example", tier: "tertiary", relevance: 0.5 },
    { index: 2, title: "Primary", url: "https://gov.example/2", domain: "gov.example", tier: "primary", relevance: 0.7 },
    { index: 3, title: "Tier3s", url: "https://b.example/3", domain: "b.example", tier: "tertiary", relevance: 0.5 },
  ];
  const ev = [
    evidence(1, "Tier3", "https://a.example/1", "short"),
    evidence(2, "Primary", "https://gov.example/2", "long primary passage here"),
    evidence(3, "Tier3s", "https://b.example/3", "medium passage"),
  ];
  const ranked = rankEvidence(ev, meta);
  // Primary must be first.
  assertEqual(ranked[0].sourceIndex, 2, "F1 primary evidence ranked first");
  // Never drops a passage — length preserved.
  assertEqual(ranked.length, 3, "F2 no passage dropped");
  // Same-tier ties broken by length desc.
  assertEqual(ranked[1].sourceIndex, 3, "F3 same-tier length tiebreak");
  // Citation integrity: original index/title/url preserved on the reordered item.
  const primary = ranked.find((e) => e.sourceIndex === 2)!;
  assertEqual(primary.sourceTitle, "Primary", "F4 attribution preserved");
  assertEqual(primary.url, "https://gov.example/2", "F5 url preserved");
}

// ---------------------------------------------------------------------------
// G — Research quality / confidence
// ---------------------------------------------------------------------------

function testG() {
  const multi = okResult(
    [
      { title: "A", url: "https://www.cdc.gov/a", index: 1 },
      { title: "B", url: "https://b.example/b", index: 2 },
    ],
    [
      evidence(1, "A", "https://www.cdc.gov/a", "long authoritative passage"),
      evidence(2, "B", "https://b.example/b", "another passage"),
    ]
  );
  // buildSourceMeta computes tiers; cdc-style gov -> primary; b.example -> tertiary.
  const meta = buildSourceMeta(multi.sources, multi.evidence);
  const q = evaluateResearchQuality(multi, meta);
  assertTrue(q.multiSource, "G1 multi-source flagged");
  assertTrue(q.hasAuthoritative, "G2 authoritative flagged");
  assertEqual(q.evidenceCount, 2, "G3 evidence count");
  assertFalse(q.degraded, "G4 not degraded");
  assertTrue(q.confidence > 0.5, "G5 strong confidence", `got ${q.confidence}`);

  // Single source, no authority, degraded -> low confidence.
  const single = okResult(
    [{ title: "A", url: "https://a.example/a", index: 1 }],
    [evidence(1, "A", "https://a.example/a", "a snippet")],
    true,
    "snippets-only"
  );
  const meta2 = buildSourceMeta(single.sources, single.evidence);
  const q2 = evaluateResearchQuality(single, meta2);
  assertFalse(q2.multiSource, "G6 single source not multi");
  assertFalse(q2.hasAuthoritative, "G7 no authority");
  assertTrue(q2.degraded, "G8 degraded detected");
  assertTrue(q2.confidence < 0.5, "G9 low confidence on degraded/single", `got ${q2.confidence}`);

  // Empty result -> zero confidence.
  const qEmpty = evaluateResearchQuality(emptyResult(), []);
  assertEqual(qEmpty.confidence, 0, "G10 empty -> zero confidence");

  // Confidence clamps to [0,1].
  const many = okResult(
    [
      { title: "A", url: "https://www.cdc.gov/a", index: 1 },
      { title: "B", url: "https://www.cdc.gov/b", index: 2 },
      { title: "C", url: "https://c.example/c", index: 3 },
    ],
    [
      evidence(1, "A", "https://gov.example/a", "passage one"),
      evidence(2, "B", "https://gov.example/b", "passage two"),
      evidence(3, "C", "https://c.example/c", "passage three"),
    ]
  );
  const meta3 = buildSourceMeta(many.sources, many.evidence);
  const qMany = evaluateResearchQuality(many, meta3);
  assertTrue(qMany.confidence <= 1, "G11 confidence clamped <= 1", `got ${qMany.confidence}`);
  assertTrue(qMany.confidence >= 0, "G12 confidence clamped >= 0", `got ${qMany.confidence}`);
}

// ---------------------------------------------------------------------------
// H — Quality warnings
// ---------------------------------------------------------------------------

function testH() {
  const deg = buildQualityWarnings({ confidence: 0.3, evidenceCount: 1, degraded: true, hasAuthoritative: false, multiSource: false });
  assertTrue(deg.some((w) => /degraded/i.test(w)), "H1 degraded warning present");
  assertTrue(deg.some((w) => /single source/i.test(w)), "H2 single-source warning present");
  assertTrue(deg.some((w) => /authoritative/i.test(w)), "H3 non-authoritative warning present");

  const healthy = buildQualityWarnings({ confidence: 0.8, evidenceCount: 3, degraded: false, hasAuthoritative: true, multiSource: true });
  assertEqual(healthy.length, 0, "H4 healthy -> no warnings");
}

// ---------------------------------------------------------------------------
// I — Web-vs-web conflict detection
// ---------------------------------------------------------------------------

function testI() {
  // A real conflict (same topic, differing "is X" values).
  const conflict = detectResearchConflicts([
    evidence(1, "A", "https://a.example/1", "The latest React version is 19 point two and it ships stable async server components for the new API."),
    evidence(2, "B", "https://b.example/2", "The current React version is 18 point three and it ships stable async server components for the new API."),
  ]);
  assertEqual(conflict.length, 1, "I1 real conflict detected");
  if (conflict.length) {
    assertTrue(typeof conflict[0].topic === "string" && conflict[0].topic.length > 0, "I2 conflict topic non-empty");
    assertEqual(conflict[0].sides.length, 2, "I3 conflict has two sides");
    assertEqual(conflict[0].sides[0].sourceIndex, 1, "I4 first side pinned to source 1");
    assertEqual(conflict[0].sides[1].sourceIndex, 2, "I5 second side pinned to source 2");
  }

  // Fewer than 2 sources -> no conflicts.
  assertEqual(detectResearchConflicts([evidence(1, "A", "https://a.example/1", "only one source passage here")]).length, 0, "I6 single source -> no conflict");

  // Unrelated passages -> no conflict.
  assertEqual(
    detectResearchConflicts([
      evidence(1, "A", "https://a.example/1", "Quantum computers use qubits to perform many computations at once."),
      evidence(2, "B", "https://b.example/2", "The economy grew by two percent this quarter across the region."),
    ]).length,
    0,
    "I7 unrelated -> no conflict"
  );

  // Near-identical passages (no different value) -> no conflict.
  assertEqual(
    detectResearchConflicts([
      evidence(1, "A", "https://a.example/1", "The React version is 19.2 stable."),
      evidence(2, "B", "https://b.example/2", "The React version is 19.2 stable."),
    ]).length,
    0,
    "I8 near-identical -> no false conflict"
  );

  // Bounded output.
  const many = Array.from({ length: 6 }, (_, i) =>
    evidence(i + 1, `S${i + 1}`, `https://s${i + 1}.example/${i + 1}`, `The top speed is ${10 + i * 5} mph and it is very fast on the highway today.`)
  );
  const manyConflicts = detectResearchConflicts(many);
  assertTrue(manyConflicts.length <= MAX_RESEARCH_CONFLICTS, "I9 conflicts bounded by cap", `got ${manyConflicts.length}`);
  assertEqual(MAX_RESEARCH_CONFLICTS, 3, "I10 cap constant is 3");
}

// ---------------------------------------------------------------------------
// J — Full orchestrateResearch pipeline
// ---------------------------------------------------------------------------

function testJ() {
  // Populated result -> full, typed context.
  const res = okResult(
    [
      { title: "CDC", url: "https://www.cdc.gov/flu/", index: 1 },
      { title: "Blog", url: "https://a.example/blog", index: 2 },
    ],
    [
      evidence(1, "CDC", "https://www.cdc.gov/flu/", "Guidance on the current flu season vaccination for the 2026 season."),
      evidence(2, "Blog", "https://a.example/blog", "A blog claims the flu vaccine is not effective this season for most people."),
    ]
  );
  const ctx: ResearchContext = orchestrateResearch({
    research: res,
    message: "What is the latest flu vaccine guidance?",
    primaryRoute: "WEB_RESEARCH",
  });
  assertEqual(ctx.sources.length, 2, "J1 sources populated");
  assertEqual(ctx.evidence.length, 2, "J2 evidence populated");
  assertEqual(ctx.plan.depth, "STANDARD", "J3 guidance fresh -> STANDARD");
  assertTrue(ctx.need.selected, "J4 need selected");
  assertTrue(ctx.quality.evidenceCount >= 1, "J5 quality evidence counted");
  // The vaccine + season overlap + differing "is/claims" value may or may not
  // trip the conflict heuristic; just assert conflicts is always an array.
  assert(Array.isArray(ctx.conflicts), "J6 conflicts is array");

  // Empty result -> no sources/evidence, depth NONE, zero confidence.
  const emptyCtx: ResearchContext = orchestrateResearch({
    research: emptyResult(),
    message: "hello there",
    primaryRoute: "CHAT",
  });
  assertEqual(emptyCtx.sources.length, 0, "J7 empty sources");
  assertEqual(emptyCtx.evidence.length, 0, "J8 empty evidence");
  assertEqual(emptyCtx.plan.depth, "NONE", "J9 empty depth NONE");
  assertEqual(emptyCtx.quality.confidence, 0, "J10 empty confidence zero");

  // Degraded result -> depth still typed when content present + degraded flag.
  const degRes = okResult(
    [{ title: "A", url: "https://a.example/a", index: 1 }],
    [evidence(1, "A", "https://a.example/a", "short snippet only")],
    true,
    "snippets-only"
  );
  const degCtx = orchestrateResearch({ research: degRes, message: "what is the latest price", primaryRoute: "WEB_RESEARCH" });
  assertTrue(degCtx.quality.degraded, "J11 degraded propagated");
  assertEqual(degCtx.plan.depth, "STANDARD", "J12 degraded still typed when content present");
}

// ---------------------------------------------------------------------------
// K — Synthesis block builder
// ---------------------------------------------------------------------------

function testK() {
  const res = okResult(
    [
      { title: "CDC", url: "https://www.cdc.gov/flu/", index: 1 },
      { title: "Blog", url: "https://a.example/blog", index: 2 },
    ],
    [
      evidence(1, "CDC", "https://www.cdc.gov/flu/", "Guidance for the current flu season says vaccination is recommended for the 2026 season."),
      evidence(2, "Blog", "https://a.example/blog", "A blog says the flu vaccine is not effective this season for most people worldwide."),
    ]
  );
  const ctx = orchestrateResearch({ research: res, message: "latest flu guidance", primaryRoute: "WEB_RESEARCH" });
  const block = buildResearchSynthesisBlock(ctx);

  assertTrue(block.length > 0, "K1 block produced for content");
  assertTrue(/RESEARCH ASSESSMENT/.test(block), "K2 header note present");
  assertTrue(/Source tiers/.test(block), "K3 tier section present");
  assertTrue(/primary/.test(block), "K4 primary tier rendered");
  assertTrue(/untrusted DATA/.test(block), "K5 untrusted-data fence reaffirmed");
  assertTrue(/Confidence in retrieved evidence: \d+%/.test(block), "K6 confidence rendered");

  // Empty context -> empty block.
  const emptyCtx = orchestrateResearch({ research: emptyResult(), message: "hi", primaryRoute: "CHAT" });
  assertEqual(buildResearchSynthesisBlock(emptyCtx), "", "K7 empty -> empty block");

  // Never fabricates URLs: every url in the block must come from the real sources.
  const urlsInBlock = block.match(/https:\/\/[^\s\)]+/g) ?? [];
  for (const u of urlsInBlock) {
    assertTrue(
      res.sources.some((s) => s.url === u),
      "K8 no fabricated url",
      `found ${u}`
    );
  }
}

// ---------------------------------------------------------------------------
// L — Plan ceilings
// ---------------------------------------------------------------------------

function testL() {
  const res = okResult(
    [
      { title: "A", url: "https://a.example/a", index: 1 },
      { title: "B", url: "https://b.example/b", index: 2 },
      { title: "C", url: "https://c.example/c", index: 3 },
      { title: "D", url: "https://d.example/d", index: 4 },
      { title: "E", url: "https://e.example/e", index: 5 },
    ],
    [evidence(1, "A", "https://a.example/a", "p"), evidence(2, "B", "https://b.example/b", "p")]
  );
  const ctx = orchestrateResearch({ research: res, message: "what is the latest x", primaryRoute: "WEB_RESEARCH" });
  assertEqual(ctx.plan.maxSources, 5, "L1 maxSources 5 (7C cap)");
  assertEqual(ctx.plan.maxQueries, 2, "L2 maxQueries 2 (7C budget)");
  assertEqual(ctx.plan.maxEvidence, 5, "L3 maxEvidence 5 (7C cap)");
}

// ---------------------------------------------------------------------------
// M — Purity guarantee (network-free, synchronous)
// ---------------------------------------------------------------------------

function testM() {
  // orchestrateResearch is a synchronous, pure function (returns context, no
  // Promise). Assert it completes synchronously and returns a typed object
  // with no async handles. We structurally assert there is no `then` and no
  // network-only fields leaking into the context.
  const res = okResult([{ title: "A", url: "https://a.example/a", index: 1 }], [evidence(1, "A", "https://a.example/a", "p")]);
  const ctx = orchestrateResearch({ research: res, message: "latest", primaryRoute: "WEB_RESEARCH" });
  assertFalse(typeof (ctx as unknown as { then?: unknown }).then === "function", "M1 synchronous (no Promise)");
  assert(typeof ctx === "object" && ctx !== null, "M2 returns object");
  assert(Array.isArray(ctx.sources), "M3 context.sources array");
  // No API key / secret fields on the context (serializable-safe).
  const json = JSON.stringify(ctx);
  assertFalse(/(api[_-]?key|secret|token)/i.test(json), "M4 no secret material serialized");
}

// ---------------------------------------------------------------------------
// N — Degradation honesty
// ---------------------------------------------------------------------------

function testN() {
  const deg = okResult(
    [{ title: "A", url: "https://a.example/a", index: 1 }],
    [evidence(1, "A", "https://a.example/a", "thin")],
    true,
    "search-failed"
  );
  const ctx = orchestrateResearch({ research: deg, message: "what is the latest x", primaryRoute: "WEB_RESEARCH" });
  assertTrue(ctx.quality.degraded, "N1 degraded flagged");
  assertTrue(ctx.warnings.some((w) => /degraded/i.test(w)), "N2 degraded warning surfaced");
  const block = buildResearchSynthesisBlock(ctx);
  assertTrue(/Evidence quality notes/.test(block), "N3 quality notes rendered on degraded");
}

// ---------------------------------------------------------------------------
// O — Citation integrity
// ---------------------------------------------------------------------------

function testO() {
  const res = okResult(
    [
      { title: "A", url: "https://a.example/a", index: 1 },
      { title: "B", url: "https://gov.example/b", index: 2 },
    ],
    [
      evidence(1, "A", "https://a.example/a", "a passage from source A that is a bit longer to rank"),
      evidence(2, "B", "https://gov.example/b", "official passage"),
    ]
  );
  const ctx = orchestrateResearch({ research: res, message: "latest x", primaryRoute: "WEB_RESEARCH" });
  // Ranked evidence preserves ORIGINAL sourceIndex/title/url even after reordering.
  for (const e of ctx.evidence) {
    const src = res.sources.find((s) => s.index === e.sourceIndex);
    assertTrue(!!src, "O1 ranked evidence index matches a real source");
    if (src) {
      assertEqual(e.sourceTitle, src.title, "O2 title attributed correctly");
      assertEqual(e.url, src.url, "O3 url attributed correctly");
    }
  }
  // Source meta indexes align with citations.
  for (const s of ctx.sources) {
    assertTrue(res.sources.some((r) => r.index === s.index && r.url === s.url), "O4 meta index/url aligned");
  }
}

// ---------------------------------------------------------------------------
// P — Safety boundary (untrusted-data fence + no memory auto-store)
// ---------------------------------------------------------------------------

function testP() {
  const res = okResult(
    [
      { title: "A", url: "https://a.example/a", index: 1 },
      { title: "B", url: "https://b.example/b", index: 2 },
    ],
    [
      evidence(1, "A", "https://a.example/a", "first source passage about the topic at hand"),
      evidence(2, "B", "https://b.example/b", "second source passage with different details about the topic"),
    ]
  );
  const ctx = orchestrateResearch({ research: res, message: "latest x", primaryRoute: "WEB_RESEARCH" });
  const block = buildResearchSynthesisBlock(ctx);
  // The block must NEVER tell the model to store the research into memory or
  // treat web content as instructions.
  assertTrue(/never override system\/application instructions/.test(block), "P1 fence reaffirmed in block");
  assertFalse(/store|remember the above|save this to memory/i.test(block), "P2 no memory-store instruction in block");
  // Ensure the orchestrate layer never imports the memory module (it cannot
  // auto-store). We assert no memory keyword appears in the module surface by
  // checking the block doesn't claim persistence.
  assertFalse(/persist/i.test(block), "P3 no persistence claim");
  // Context is untrusted DATA.
  assertTrue(/untrusted DATA/.test(block), "P4 untrusted DATA credential reaffirmed");
}

// ---------------------------------------------------------------------------
// Q — ResearchInput tolerance
// ---------------------------------------------------------------------------

function testQ() {
  const shapes: Array<{ label: string; input: ResearchInput }> = [
    { label: "success", input: { research: okResult([{ title: "A", url: "https://a.example/a", index: 1 }], [evidence(1, "A", "https://a.example/a", "a passage")]), message: "latest", primaryRoute: "WEB_RESEARCH" } },
    { label: "degraded", input: { research: okResult([], [], true, "search-failed"), message: "latest", primaryRoute: "WEB_RESEARCH" } },
    { label: "empty", input: { research: emptyResult(), message: "hi", primaryRoute: "CHAT" } },
    { label: "document route", input: { research: emptyResult(), message: "about my doc", primaryRoute: "DOCUMENT_RAG" } },
  ];
  for (const { label, input } of shapes) {
    let ok = true;
    try {
      const ctx = orchestrateResearch(input);
      if (!ctx || typeof ctx !== "object") ok = false;
    } catch {
      ok = false;
    }
    assertTrue(ok, `Q1 ${label} tolerated without throwing`);
  }
}

// ---------------------------------------------------------------------------
// R — Regression surface (barrel exports)
// ---------------------------------------------------------------------------

function testR() {
  const surface = {
    orchestrateResearch,
    buildResearchSynthesisBlock,
    classifyResearchDepth,
    classifyResearchNeed,
    classifySourceTier,
    buildSourceMeta,
    hasAuthoritativeSource,
    rankEvidence,
    evaluateResearchQuality,
    buildQualityWarnings,
    detectResearchConflicts,
    MAX_RESEARCH_CONFLICTS,
  };
  for (const [k, v] of Object.entries(surface)) {
    assert(v !== undefined, `R1 export present: ${k}`);
  }
  assert(typeof MAX_RESEARCH_CONFLICTS === "number", "R2 MAX_RESEARCH_CONFLICTS numeric");
  assertEqual(MAX_RESEARCH_CONFLICTS, 3, "R3 MAX_RESEARCH_CONFLICTS value");
}

// ---------------------------------------------------------------------------

(async () => {
  testA();
  testB();
  testC();
  testD();
  testE();
  testF();
  testG();
  testH();
  testI();
  testJ();
  testK();
  testL();
  testM();
  testN();
  testO();
  testP();
  testQ();
  testR();

  console.log("\n============================================================");
  console.log(`Phase 8E tests: ${passed} passed, ${failed} failed`);
  console.log("============================================================");

  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("ALL PHASE 8E TESTS PASSED");
})();
