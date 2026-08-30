// ---------------------------------------------------------------------------
// Phase 5G — Regression + evaluation suite runner
//
// Runs the generic RAG evaluation over synthetic arbitrary documents, computes
// metrics, classifies failures, and returns a structured report. Entry point is
// the standalone `test-phase5g.ts` at the repo root (consistent with the other
// phase test files).
//
// This is OBSERVATIONAL: it only drives production functions and scores them.
// It never modifies production code. Any genuine defect is surfaced in the
// report for human approval before a fix.
// ---------------------------------------------------------------------------

import {
  evaluateCaseAgainstDoc,
  evaluateRetrieval,
  pathMatchLevel,
  expectedMarkers,
} from "./retrieval-evaluator";
import {
  summarizeMetrics,
  aggregateMetrics,
} from "./metrics";
import {
  evaluateStructuralPath,
  type PathEvalCase,
} from "./structural-evaluator";
import { classifyFailure } from "./classifier";
import { verifyAttribution } from "./source-evaluator";
import { analyzeQuery, extractStructuralMarkers } from "@/lib/retrieval";
import type {
  EvaluationCase,
  EvaluationReport,
  FailureClassification,
  MetricsReport,
  SyntheticDocument,
  TestResult,
} from "./evaluation-types";

// ---------------------------------------------------------------------------
// Structural path test bank (Step 6)
// ---------------------------------------------------------------------------

function buildPathCases(): PathEvalCase[] {
  return [
    // Unit 4 Part B Question 5 must NOT match Unit 3 Part B Question 5
    {
      id: "path-wrong-unit",
      queryMarkers: [
        { type: "unit", number: "4" },
        { type: "part", number: "b" },
        { type: "question", number: "5" },
      ],
      content: "unit 3\npart b\nquestion 5\nsome body",
      precedingContent: "",
      expected: "no_match",
      description: "wrong unit must not match even with same part/question",
    },
    {
      id: "path-correct-unit",
      queryMarkers: [
        { type: "unit", number: "4" },
        { type: "part", number: "b" },
        { type: "question", number: "5" },
      ],
      content: "unit 4\npart b\nquestion 5\nbody",
      precedingContent: "",
      expected: "match",
      description: "correct unit/part/question path matches",
    },
    {
      id: "path-wrong-part",
      queryMarkers: [
        { type: "unit", number: "4" },
        { type: "part", number: "a" },
        { type: "question", number: "5" },
      ],
      content: "unit 4\npart b\nquestion 5",
      precedingContent: "",
      expected: "no_match",
      description: "wrong part must not match",
    },
    {
      id: "path-preceding-parent",
      queryMarkers: [
        { type: "chapter", number: "3" },
        { type: "section", number: "2" },
      ],
      content: "section 2\ntext here",
      precedingContent: "chapter 3",
      expected: "match",
      description: "parent in preceding content completes the path",
    },
    {
      id: "path-single-marker",
      queryMarkers: [{ type: "question", number: "7" }],
      content: "question 7 exists here",
      precedingContent: "",
      expected: "match",
      description: "single marker matches when present",
    },
    {
      id: "path-exercise-notchapter",
      queryMarkers: [
        { type: "module", number: "2" },
        { type: "exercise", number: "3" },
      ],
      content: "module 3\nexercise 3\nbody",
      precedingContent: "",
      expected: "no_match",
      description: "conflicting module number blocks the path",
    },
  ];
}

// ---------------------------------------------------------------------------
// Pure walking: run a category list through production analyzeQuery to add
// coverage of query analysis behavior (observational checks)
// ---------------------------------------------------------------------------

function queryAnalysisChecks(): TestResult[] {
  const checks: TestResult[] = [];
  const add = (
    id: string,
    category: string,
    pass: boolean,
    note?: string
  ) =>
    checks.push({
      id,
      category,
      query: id,
      relevant: pass,
      foundEvidence: [],
      missingEvidence: pass ? [] : [],
      status: pass ? "pass" : "fail",
      structuralMatch: "n/a",
      note,
    });

  const q1 = analyzeQuery("Unit 4 Part B Question 5");
  add("qa-1", "query_analysis", q1.entities.questionNumber === "5", "extracts question 5 (not 4)");
  add("qa-2", "query_analysis", q1.entities.unitNumber === "4", "extracts unit 4");
  const pathPart = q1.entities.structuralPath.find((m) => m.type === "part");
  add("qa-3", "query_analysis", pathPart?.number === "b", "structural path part='b' normalized");

  const q2 = analyzeQuery("list all questions in Unit 4 Part B");
  add("qa-4", "query_analysis", q2.scopeQuery === true, "scope query detected");

  const q3 = analyzeQuery("What is normalization?");
  add("qa-5", "query_analysis", q3.scopeQuery === false, "semantic query not a scope query");

  const q4 = analyzeQuery("Page 8");
  add("qa-6", "query_analysis", q4.entities.pageNumber === "8", "page entity extracted");

  const q5 = analyzeQuery("Figure 2");
  add("qa-7", "query_analysis", q5.entities.figureNumber === "2", "figure entity extracted");

  const q6 = analyzeQuery("5th question");
  add("qa-8", "query_analysis", q6.entities.questionNumber === "5", "ordinal question extracted");

  const q7 = analyzeQuery("Chapter III");
  const ch = q7.entities.chapterNumber;
  add("qa-9", "query_analysis", ch === "3", "roman numeral chapter → 3");

  const q8 = analyzeQuery("Section 3.4");
  add("qa-10", "query_analysis", q8.entities.sectionNumber === "3.4", "section with subsection number");

  const q9 = analyzeQuery("Unit 4 Question 999");
  add("qa-11", "query_analysis", q9.entities.questionNumber === "999", "large question number extracted (enables negative)");

  const q10 = analyzeQuery("Unit IV Question 5");
  add("qa-12", "query_analysis", q10.entities.unitNumber === "4" && q10.entities.questionNumber === "5", "roman unit + question normalized to arabic");

  const q11 = analyzeQuery("Unit 2 fifth question");
  add("qa-13", "query_analysis", q11.entities.questionNumber === "5", "word-ordinal question extracted");

  const q12 = analyzeQuery("Chapter IV Question 5");
  add("qa-14", "query_analysis", q12.entities.chapterNumber === "4" && q12.entities.questionNumber === "5", "roman chapter + question in structural path");

  return checks;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export interface RunnerConfig {
  /** Recall depth for evidence checking. */
  recallDepth?: number;
}

export function runEvaluationSuite(
  docs: SyntheticDocument[],
  cases: EvaluationCase[],
  config: RunnerConfig = {}
): EvaluationReport {
  const recallDepth = config.recallDepth ?? 8;
  const results: TestResult[] = [];

  // Lookup docs by display name for expected-source cases
  const docByName = new Map<string, SyntheticDocument>();
  for (const d of docs) docByName.set(d.displayName, d);
  for (const d of docs) docByName.set(d.name, d);

  const counter = { failCount: 0 };

  for (const c of cases) {
    const result = runOneCase(c, docs, docByName, recallDepth, counter);
    results.push(result);
  }

  // Add structural path checks
  const pathResults = buildPathCases().map((p) => {
    const o = evaluateStructuralPath(p);
    return {
      id: p.id,
      category: "structural_path",
      query: p.description,
      relevant: o.pass,
      foundEvidence: [],
      missingEvidence: o.pass ? [] : [],
      status: (o.pass ? "pass" : "fail") as TestResult["status"],
      structuralMatch: o.pass ? "exact" : "none",
      note: o.explain,
    } as TestResult;
  });
  results.push(...pathResults);

  // Add query analysis checks
  results.push(...queryAnalysisChecks());

  // Group by category for metrics
  const byCategory = new Map<string, TestResult[]>();
  for (const r of results) {
    const arr = byCategory.get(r.category) ?? [];
    arr.push(r);
    byCategory.set(r.category, arr);
  }

  const metricsByCategory: MetricsReport[] = [];
  for (const [cat, list] of byCategory) {
    metricsByCategory.push(summarizeMetrics(cat, list, recallDepth));
  }

  const overall = aggregateMetrics(metricsByCategory, results.length);

  return {
    cases: results,
    metricsByCategory,
    overall,
    before: 0,
    after: results.length,
  };
}

function runOneCase(
  c: EvaluationCase,
  docs: SyntheticDocument[],
  docByName: Map<string, SyntheticDocument>,
  recallDepth: number,
  counter: { failCount: number }
): TestResult {
  // General chat / follow-up / pure negative without a specific doc
  // → treat as retrieval-observation over the full corpus set (n/a evidence).
  // These are scored at the "did it refuse / not fabricate" level.
  const targetedDoc = pickTargetedDoc(c, docByName, docs, recallDepth);

  let observation: Omit<TestResult, "status">;

  if (c.multiSource && targetedDoc) {
    // multi-source: run against all docs, verify coverage per expected sources
    const multiResults = docs.map((d) => evaluateRetrieval(d, c.query, { maxChunks: recallDepth }));
    const markers = expectedMarkers(c.expectedLocation);
    const topContentAcross = multiResults
      .filter((r) => r.chunks.length > 0)
      .flatMap((r) => r.chunks.map((ch) => ch.text));
    const pathLevel = pathMatchLevel(topContentAcross.map((t) => ({ content: t })), markers);

    const expectedSources = c.expectedSources ?? [];
    const covered = new Set<string>();
    for (const m of multiResults) {
      const src = m.chunks.length > 0 ? docs[multiResults.indexOf(m)].displayName : null;
      if (src) covered.add(src);
    }
    const allExpectedCovered =
      expectedSources.length === 0 || expectedSources.every((s) => covered.has(s));
    const noContamination =
      expectedSources.length === 0 ||
      [...covered].every((s) => expectedSources.includes(s) || expectedSources.includes(resolveName(docByName, s)));

    const relevant =
      allExpectedCovered &&
      (markers.length === 0 || pathLevel === "exact") &&
      (c.expectedAnswerEvidence?.length === 0 ||
        topContentAcross.some((t) =>
          c.expectedAnswerEvidence!.some((n) => t.toLowerCase().includes(n.toLowerCase()))
        ));

    observation = {
      id: c.id,
      category: c.category,
      query: c.query,
      relevant,
      foundEvidence: c.expectedAnswerEvidence ?? [],
      missingEvidence: relevant ? [] : c.expectedAnswerEvidence ?? [],
      structuralMatch: pathLevel,
      note: `sources covered=${[...covered].join(",")} contamination=${noContamination}`,
    };
  } else if (targetedDoc) {
    observation = evaluateCaseAgainstDoc(targetedDoc, c, { recallDepth });
    // record pageCorrect if the case expected a page and we have page info
    if (c.expectedLocation?.page != null) {
      const ranked = evaluateRetrieval(targetedDoc, c.query, { maxChunks: recallDepth });
      observation.pageCorrect = ranked.chunks.some(
        (ch) => ch.pageNumber === c.expectedLocation!.page
      );
    }
  } else {
    // No targeted doc — general chat / standalone refuse checks
    observation = {
      id: c.id,
      category: c.category,
      query: c.query,
      relevant: true,
      foundEvidence: [],
      missingEvidence: [],
      structuralMatch: "n/a",
      note: "no document attached — normal chat path (generation only)",
    };
  }

  // Status determination
  let status: TestResult["status"];
  const relevant = observation.relevant;

  if (c.shouldRefuse) {
    // Refusal case: passes when it does NOT fabricate requested evidence.
    // relevant is already computed as "did not fabricate".
    status = relevant ? "pass" : "fail";
  } else if (c.shouldRetrieve === false && !c.shouldRefuse) {
    // Non-retrieval case (general chat): always pass as observation
    status = "pass";
  } else {
    // Normal case: pass when relevant evidence retrieved
    status = relevant ? "pass" : "fail";
  }

  const base: TestResult = {
    ...observation,
    status,
  };

  // Classify failures
  if (status === "fail") {
    counter.failCount++;
    const rankedContent =
      targetedDoc
        ? evaluateRetrieval(targetedDoc, c.query, { maxChunks: recallDepth }).chunks.map((ch) => ch.text)
        : [];
    const cls = classifyFailure({ testCase: c, doc: targetedDoc, rankedContent });
    base.classification = cls.classification;
    base.pipelineStage = cls.pipelineStage;
    base.location = cls.location;
    base.reproduction = `Run evaluateRetrieval("${c.query}") over ${targetedDoc?.displayName ?? "no doc"}.`;
  }

  return base;
}

function resolveName(docByName: Map<string, SyntheticDocument>, s: string): string {
  return s;
}

function pickTargetedDoc(
  c: EvaluationCase,
  docByName: Map<string, SyntheticDocument>,
  docs: SyntheticDocument[],
  recallDepth: number
): SyntheticDocument | null {
  // If expectedSources specify a doc, target that one (single-source case).
  if (c.multiSource) return null; // handled by multi-branch
  if (c.expectedSources && c.expectedSources.length === 1) {
    const byName = docByName.get(c.expectedSources[0]);
    if (byName) return byName;
    const match = docs.find((d) => d.displayName === c.expectedSources![0]);
    if (match) return match;
  }
  if (c.expectedSources && c.expectedSources.length > 1) return null; // multi

  // Otherwise score every candidate doc with the SAME production scoring used
  // by multi-source orchestration and pick the best-ranked one. Defaulting to
  // docs[0] would evaluate every question against whatever synthetic doc happens
  // to be first (e.g. the textbook) and report bogus failures.
  let best: SyntheticDocument | null = null;
  let bestScore = 0;
  for (const d of docs) {
    const ranked = evaluateRetrieval(d, c.query, { maxChunks: recallDepth });
    const top = ranked.chunks[0]?.score ?? 0;
    if (top > bestScore) {
      bestScore = top;
      best = d;
    }
  }
  return best;
}

export type { FailureClassification };
