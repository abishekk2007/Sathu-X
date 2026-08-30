// ---------------------------------------------------------------------------
// Phase 5G — Generic evaluation dataset generator (Steps 3, 7)
//
// Produces a set of ARBITRARY synthetic documents and associated evaluation
// cases. Nothing is hard-coded to a specific filename/unit/page. The generator
// accepts a seed/topic vocabulary and builds generic content, so it works for
// "a random technical PDF", "a resume", "a research paper", "a textbook",
// "a PPTX dump", "a DOCX dump", etc.
// ---------------------------------------------------------------------------

import type { EvaluationCase, SyntheticDocument } from "./evaluation-types";
import {
  buildDocument,
  buildQuestionBankDoc,
  buildProseDocument,
  buildLongDocument,
  buildConfusionDocument,
  buildExactQuestionBankDoc,
  type SyntheticChunkSpec,
  type ExactBankUnit,
} from "./document-builder";

// ---------------------------------------------------------------------------
// Reusable generic topic vocabulary (namespaced to avoid cross-doc collisions)
// ---------------------------------------------------------------------------

export interface Dataset {
  docs: SyntheticDocument[];
  cases: EvaluationCase[];
}

/**
 * Tag every case with the document it is about (its display name). This mirrors
 * real usage — a user attaches a document and asks about it — and lets the
 * runner target the correct doc deterministically instead of guessing.
 */
function withSource<C extends EvaluationCase>(cases: C[], displayName: string): C[] {
  return cases.map((c) =>
    c.expectedSources && c.expectedSources.length > 0 ? c : { ...c, expectedSources: [displayName] }
  );
}

// ---------------------------------------------------------------------------
// A) Question-bank document — generic unit/part/question grammar
// ---------------------------------------------------------------------------

export function buildTextbookDataset(): Dataset {
  // Each unit 1..5 carries its OWN Question 1 and Question 5 with distinct
  // evidence tokens. Units 2, 3 and 4 additionally nest Part A / Part B
  // questions so the part-aware exact lookup is exercised across MULTIPLE
  // units (not just one), including a NOT-FOUND part case. Nothing is
  // hard-coded to a unit or question number inside the evaluator — the cases
  // below just state what the synthetic doc happens to contain.
  const baseQuestions = (n: number): ExactBankUnit["questions"] => [
    {
      number: 1,
      text: `Unit ${n} Question 1 text u${n}q1needle`,
      answerEvidence: [`u${n}q1 unique evidence needle`],
    },
    {
      number: 5,
      text: `Unit ${n} Question 5 text u${n}q5needle`,
      answerEvidence: [`u${n}q5 unique evidence needle`],
    },
  ];
  const partBank = (n: number): ExactBankUnit["parts"] => [
    {
      label: "a",
      questions: [
        { number: 5, text: `Part A Question 5 text u${n}paq5needle`, answerEvidence: [`u${n} part-a q5 unique needle`] },
        { number: 6, text: `Part A Question 6 u${n}paq6needle`, answerEvidence: [`u${n} part-a q6 needle`] },
      ],
    },
    {
      label: "b",
      questions: [
        { number: 5, text: `Part B Question 5 text u${n}pbq5needle`, answerEvidence: [`u${n} part-b q5 unique needle`] },
      ],
    },
  ];

  // The exact builder emits bare questions before parts, so a bare
  // "Unit N Question 5" resolves to the unit-level Q5, while "Part A/B"
  // lookups resolve to the nested blocks.
  const builtUnits: ExactBankUnit[] = [
    { number: 1, questions: baseQuestions(1) },
    { number: 2, questions: baseQuestions(2), parts: partBank(2) },
    { number: 3, questions: baseQuestions(3), parts: partBank(3) },
    { number: 4, questions: baseQuestions(4), parts: partBank(4) },
    { number: 5, questions: baseQuestions(5) },
  ];

  const doc = buildExactQuestionBankDoc(
    "Textbook CB.txt",
    "Database Textbook",
    builtUnits,
    { fillerPerHeading: 2, pagePerParent: 3 }
  );

  const cases: EvaluationCase[] = [
    // -- Exact question retrieval: each unit's Question 5 must resolve to ITS unit --
    ...builtUnits.map((u) => ({
      id: `g-eq-unit-${u.number}-q5`,
      category: "exact_question",
      query: `Unit ${u.number} Question 5`,
      expectedLocation: { unit: String(u.number), question: "5" },
      expectedAnswerEvidence: [`u${u.number}q5 unique evidence needle`],
    } as EvaluationCase)),
    // Unit 3's bare Question 5 resolves to its unit-level Q5 (pre-part).
    { id: "g-eq-u3-q5-bare", category: "exact_question", query: "Unit 3 Question 5", expectedLocation: { unit: "3", question: "5" }, expectedAnswerEvidence: ["u3q5 unique evidence needle"] },
    // -- Question number formats (with a unit prefix so exact lookup is deterministic) --
    { id: "g-eq-fmt-qno", category: "exact_question", query: "Unit 2 Question No. 5", expectedLocation: { unit: "2", question: "5" }, expectedAnswerEvidence: ["u2q5 unique evidence needle"] },
    { id: "g-eq-fmt-qn", category: "exact_question", query: "Unit 2 Question number 5", expectedLocation: { unit: "2", question: "5" }, expectedAnswerEvidence: ["u2q5 unique evidence needle"] },
    { id: "g-eq-fmt-q5", category: "exact_question", query: "Unit 2 Q5", expectedLocation: { unit: "2", question: "5" }, expectedAnswerEvidence: ["u2q5 unique evidence needle"] },
    { id: "g-eq-fmt-qdot5", category: "exact_question", query: "Unit 2 Q.5", expectedLocation: { unit: "2", question: "5" }, expectedAnswerEvidence: ["u2q5 unique evidence needle"] },
    { id: "g-eq-fmt-5th", category: "exact_question", query: "Unit 2 5th question", expectedLocation: { unit: "2", question: "5" }, expectedAnswerEvidence: ["u2q5 unique evidence needle"] },
    { id: "g-eq-fmt-word", category: "exact_question", query: "Unit 2 fifth question", expectedLocation: { unit: "2", question: "5" }, expectedAnswerEvidence: ["u2q5 unique evidence needle"] },
    { id: "g-eq-fmt-roman-unit", category: "exact_question", query: "Unit IV Question 5", expectedLocation: { unit: "4", question: "5" }, expectedAnswerEvidence: ["u4q5 unique evidence needle"] },
    { id: "g-eq-fmt-q1", category: "exact_question", query: "Unit 4 Question 1", expectedLocation: { unit: "4", question: "1" }, expectedAnswerEvidence: ["u4q1 unique evidence needle"] },
    // -- Part-aware under units 2/3/4 --
    { id: "g-eq-part-a", category: "exact_question", query: "Unit 3 Part A Question 5", expectedLocation: { unit: "3", part: "a", question: "5" }, expectedAnswerEvidence: ["u3 part-a q5 unique needle"] },
    { id: "g-eq-part-b", category: "exact_question", query: "Unit 3 Part B Question 5", expectedLocation: { unit: "3", part: "b", question: "5" }, expectedAnswerEvidence: ["u3 part-b q5 unique needle"] },
    { id: "g-eq-u2-part-a", category: "exact_question", query: "Unit 2 Part A Question 5", expectedLocation: { unit: "2", part: "a", question: "5" }, expectedAnswerEvidence: ["u2 part-a q5 unique needle"] },
    { id: "g-eq-u2-part-b", category: "exact_question", query: "Unit 2 Part B Question 5", expectedLocation: { unit: "2", part: "b", question: "5" }, expectedAnswerEvidence: ["u2 part-b q5 unique needle"] },
    { id: "g-eq-u4-part-a", category: "exact_question", query: "Unit 4 Part A Question 5", expectedLocation: { unit: "4", part: "a", question: "5" }, expectedAnswerEvidence: ["u4 part-a q5 unique needle"], forbiddenEvidence: ["u4 part-b q5 unique needle"] },
    { id: "g-eq-u4-part-b", category: "exact_question", query: "Unit 4 Part B Question 5", expectedLocation: { unit: "4", part: "b", question: "5" }, expectedAnswerEvidence: ["u4 part-b q5 unique needle"], forbiddenEvidence: ["u4 part-a q5 unique needle"] },
    // -- NOT FOUND --
    { id: "g-eq-notfound-999", category: "exact_question_negative", query: "Unit 2 Question 999", shouldRetrieve: false, shouldRefuse: true, expectedLocation: { unit: "2", question: "999" }, expectedAnswerEvidence: [], forbiddenEvidence: ["u2q5 unique evidence needle"] },
    { id: "g-eq-notfound-part", category: "exact_question_negative", query: "Unit 5 Part A Question 5", shouldRetrieve: false, shouldRefuse: true, expectedLocation: { unit: "5", part: "a", question: "5" }, expectedAnswerEvidence: [], forbiddenEvidence: ["u2 part-a q5 unique needle", "u3 part-a q5 unique needle", "u4 part-a q5 unique needle"] },
    // -- Structural negatives --
    { id: "g-sneg-1", category: "structural_negative", query: "Unit 99", shouldRetrieve: false, shouldRefuse: true, expectedLocation: { unit: "99" } },
    { id: "g-sneg-2", category: "structural_negative", query: "Question 999", shouldRetrieve: false, shouldRefuse: true, expectedLocation: { question: "999" } },
    { id: "g-sneg-3", category: "structural_negative", query: "Page 999", shouldRetrieve: false, shouldRefuse: true, expectedLocation: { page: 999 } },
    // -- Unit / Part scope queries --
    { id: "g-unit-1", category: "unit", query: "What is covered in Unit 4?", expectedLocation: { unit: "4" }, expectedAnswerEvidence: ["u4q5 unique evidence needle"] },
    { id: "g-part-1", category: "part", query: "List topics in Unit 3 Part A.", expectedLocation: { unit: "3", part: "a" }, expectedAnswerEvidence: ["u3 part-a q5 unique needle"] },
    // -- Semantic question body (no duplicate across units) --
    { id: "g-eq-sem-q1", category: "exact_question", query: "Unit 1 Question 1", expectedLocation: { unit: "1", question: "1" }, expectedAnswerEvidence: ["u1q1 unique evidence needle"] },
  ];

  return { docs: [doc], cases: withSource(cases, "Database Textbook") };
}

// ---------------------------------------------------------------------------
// B) Prose / research-paper style document with sections
// ---------------------------------------------------------------------------

export function buildProseDataset(): Dataset {
  const doc = buildProseDocument(
    "Research Paper R1.pdf",
    "Research Paper R1",
    "pdf",
    [
      { heading: "Introduction", paragraphs: ["This paper studies retrieval reliability."], page: 1 },
      { heading: "Background", marker: { type: "section", number: "2" }, paragraphs: ["Information retrieval systems rank passages."], page: 2 },
      { heading: "Methodology", marker: { type: "section", number: "3" }, paragraphs: ["We use exact phrase and structural signals."], page: 3 },
      { heading: "Results", marker: { type: "section", number: "4" }, paragraphs: ["Retrieval accuracy exceeds 90 percent."], page: 4 },
      { heading: "Conclusion", paragraphs: ["The pipeline is reliable for arbitrary documents."], page: 5 },
    ]
  );

  const cases: EvaluationCase[] = [
    { id: "g-prose-sec-1", category: "section", query: "What does the introduction say?", expectedLocation: { page: 1 }, expectedAnswerEvidence: ["studies retrieval reliability"] },
    { id: "g-prose-sec-2", category: "section", query: "Explain section 3.", expectedLocation: { section: "3" }, expectedAnswerEvidence: ["exact phrase and structural signals"] },
    { id: "g-prose-sec-3", category: "section", query: "What is discussed in section 4?", expectedLocation: { section: "4" }, expectedAnswerEvidence: ["Retrieval accuracy exceeds 90"] },
    { id: "g-prose-page-1", category: "page", query: "What is on page 2?", expectedLocation: { page: 2 }, expectedAnswerEvidence: ["Information retrieval systems rank passages"] },
    { id: "g-prose-sem-1", category: "semantic", query: "What is the main purpose of this document?", expectedAnswerEvidence: ["reliability"] },
    { id: "g-prose-topic-1", category: "topic", query: "What does the methodology discuss?", expectedAnswerEvidence: ["exact phrase and structural signals"] },
    { id: "g-prose-neg-1", category: "negative", query: "What color is the fictional unicorn in section 5?", shouldRefuse: true },
  ];

  return { docs: [doc], cases: withSource(cases, "Research Paper R1") };
}
// ---------------------------------------------------------------------------

export function buildResumeDataset(): Dataset {
  const doc = buildProseDocument(
    "Resume CV.txt",
    "Resume CV",
    "txt",
    [
      { heading: "Summary", paragraphs: ["Software engineer with 8 years experience."], page: 1 },
      { heading: "Experience", paragraphs: ["Led the search ranking team at Acme Corp."], page: 1 },
      { heading: "Skills", paragraphs: ["TypeScript, Retrieval, Machine Learning."], page: 1 },
      { heading: "Education", paragraphs: ["M.S. in Computer Science from State University."], page: 1 },
    ]
  );
  const cases: EvaluationCase[] = [
    { id: "g-resume-topic-1", category: "topic", query: "Where did the candidate study?", expectedAnswerEvidence: ["M.S. in Computer Science from State University"] },
    { id: "g-resume-topic-2", category: "topic", query: "What company did the candidate lead a team at?", expectedAnswerEvidence: ["Acme Corp"] },
    { id: "g-resume-neg-1", category: "negative", query: "What is the candidate's phone number?", shouldRefuse: true },
  ];
  return { docs: [doc], cases: withSource(cases, "Resume CV") };
}

// ---------------------------------------------------------------------------
// D) Long document (Step J) — verifies no beginning bias
// ---------------------------------------------------------------------------

export function buildLongDataset(): Dataset {
  const pages: Record<number, string[]> = {};
  const total = 24;
  for (let p = 1; p <= total; p++) {
    pages[p] = [
      `Page ${p} evidence marker page${p}content.`,
    ];
  }
  // Inject unique needles at several depths
  pages[1] = ["First page introductory content page1needle."];
  pages[5] = ["Chapter five material page5needle."];
  pages[10] = ["Tenth page retrieval content page10needle."];
  pages[20] = ["Near the end twentieth page page20needle."];
  pages[24] = ["Final page concluding material page24needle."];

  const doc = buildLongDocument("Long Textbook L.pdf", "Long Textbook L", total, pages);

  const cases: EvaluationCase[] = [
    { id: "g-long-1", category: "long_document", query: "What is on page 1?", expectedLocation: { page: 1 }, expectedAnswerEvidence: ["page1needle"] },
    { id: "g-long-2", category: "long_document", query: "What is on page 5?", expectedLocation: { page: 5 }, expectedAnswerEvidence: ["page5needle"] },
    { id: "g-long-3", category: "long_document", query: "What is on page 10?", expectedLocation: { page: 10 }, expectedAnswerEvidence: ["page10needle"] },
    { id: "g-long-4", category: "long_document", query: "What is on page 20?", expectedLocation: { page: 20 }, expectedAnswerEvidence: ["page20needle"] },
    { id: "g-long-5", category: "long_document", query: "What is on the final page?", expectedLocation: { page: 24 }, expectedAnswerEvidence: ["page24needle"] },
    { id: "g-long-neg", category: "long_document", query: "What is on page 300?", shouldRetrieve: false, shouldRefuse: true, expectedLocation: { page: 300 } },
  ];
  return { docs: [doc], cases: withSource(cases, "Long Textbook L") };
}

// ---------------------------------------------------------------------------
// E) Similar-content confusion (Step M)
// ---------------------------------------------------------------------------

export function buildConfusionDataset(): Dataset {
  const doc = buildConfusionDocument(
    "Confusion Doc.pdf",
    "Confusion Doc",
    [
      {
        marker: { type: "question", number: "3" },
        heading: "Question 3 explanation",
        body: ["Semantically similar shared wording about caching."],
        page: 3,
        uniqueToken: "q3unique",
      },
      {
        marker: { type: "question", number: "8" },
        heading: "Question 8 explanation",
        body: ["Semantically similar shared wording about caching."],
        page: 8,
        uniqueToken: "q8unique",
      },
      {
        marker: { type: "unit", number: "2" },
        heading: "Unit 2 topic overview",
        body: ["Overlapping vocabulary unit two."],
        page: 2,
        uniqueToken: "unit2unique",
      },
      {
        marker: { type: "unit", number: "5" },
        heading: "Unit 5 topic overview",
        body: ["Overlapping vocabulary unit two."],
        page: 5,
        uniqueToken: "unit5unique",
      },
    ]
  );
  const cases: EvaluationCase[] = [
    { id: "g-conf-1", category: "similar_content", query: "Question 3", expectedLocation: { question: "3" }, expectedAnswerEvidence: ["q3unique"] },
    { id: "g-conf-2", category: "similar_content", query: "Question 8", expectedLocation: { question: "8" }, expectedAnswerEvidence: ["q8unique"] },
    { id: "g-conf-3", category: "similar_content", query: "Unit 2", expectedLocation: { unit: "2" }, expectedAnswerEvidence: ["unit2unique"] },
    { id: "g-conf-4", category: "similar_content", query: "Unit 5", expectedLocation: { unit: "5" }, expectedAnswerEvidence: ["unit5unique"] },
  ];
  return { docs: [doc], cases: withSource(cases, "Confusion Doc") };
}

// ---------------------------------------------------------------------------
// F) Cross-chunk retrieval (Step I): heading in one chunk, answer in another
// ---------------------------------------------------------------------------

export function buildCrossChunkDataset(): Dataset {
  const chunks: SyntheticChunkSpec[] = [
    { parts: ["CHAPTER 7", "CHAPTER 7 heading about transactions."], page: 7 },
    { parts: ["The full explanation of transactions is split across chunks."], page: 7 },
    { parts: ["Transactional isolation levels crossneedit."], page: 7 },
  ];
  const doc = buildDocument({
    name: "CrossChunk.pdf",
    displayName: "CrossChunk",
    type: "pdf",
    chunks,
  });
  const cases: EvaluationCase[] = [
    { id: "g-cross-1", category: "cross_chunk", query: "What is in chapter 7 about transactions?", expectedLocation: { chapter: "7" }, expectedAnswerEvidence: ["crossneedit"] },
  ];
  return { docs: [doc], cases: withSource(cases, "CrossChunk") };
}

// ---------------------------------------------------------------------------
// G) Arbitrary location retrieval (Step H): pick a mid-document needle
// ---------------------------------------------------------------------------

export function buildArbitraryDataset(): Dataset {
  const chunks: SyntheticChunkSpec[] = [];
  for (let i = 1; i <= 20; i++) {
    chunks.push({ parts: [`Topic block ${i} with content structureblock${i}.`], page: i });
  }
  chunks[11] = { parts: ["DEEP LOCATION deepneedle marker here."], page: 12 };

  const doc = buildDocument({ name: "Arbitrary.pdf", displayName: "Arbitrary", type: "pdf", chunks });
  const cases: EvaluationCase[] = [
    { id: "g-arb-1", category: "arbitrary_location", query: "deepneedle", expectedAnswerEvidence: ["deepneedle"] },
    { id: "g-arb-2", category: "arbitrary_location", query: "structureblock20", expectedAnswerEvidence: ["structureblock20"] },
    { id: "g-arb-3", category: "arbitrary_location", query: "structureblock1", expectedAnswerEvidence: ["structureblock1"] },
  ];
  return { docs: [doc], cases: withSource(cases, "Arbitrary") };
}

// ---------------------------------------------------------------------------
// H) Multi-document (Steps N/O)
// ---------------------------------------------------------------------------

export function buildMultiDataset(): Dataset {
  const docA = buildProseDocument(
    "Health Guide A.pdf",
    "Health Guide A",
    "pdf",
    [{ heading: "A", paragraphs: ["Omega-3 fats reduce inflammation biomarker alphaklue."], page: 1 }]
  );
  const docB = buildProseDocument(
    "Health Guide B.pdf",
    "Health Guide B",
    "pdf",
    [{ heading: "B", paragraphs: ["Vitamin D supports bone density alphabeta."], page: 1 }]
  );
  const docC = buildProseDocument(
    "Health Guide C.pdf",
    "Health Guide C",
    "pdf",
    [{ heading: "C", paragraphs: ["Keto diet metabolic findings gammapoint."], page: 1 }]
  );

  const cases: EvaluationCase[] = [
    { id: "g-multi-1", category: "multi_document", query: "Omega-3", expectedSources: ["Health Guide A"], expectedAnswerEvidence: ["alphaklue"] },
    { id: "g-multi-2", category: "multi_document", query: "Vitamin D", expectedSources: ["Health Guide B"], expectedAnswerEvidence: ["alphabeta"] },
    { id: "g-multi-3", category: "multi_document_negative", query: "Keto diet", expectedSources: ["Health Guide C"], expectedAnswerEvidence: ["gammapoint"] },
    // O) multi-doc negative: ask A-specific info while A+B selected — C must not leak
    { id: "g-multi-docneg-1", category: "multi_document_negative", query: "Omega-3 only in A", expectedSources: ["Health Guide A"], forbiddenEvidence: ["gammapoint"] },
  ];
  return { docs: [docA, docB, docC], cases };
}

// ---------------------------------------------------------------------------
// I) Visual retrieval + text/visual fusion (Steps P/Q) — observational
// Uses detectVisualIntent from the real agent so we verify intent detection.
// ---------------------------------------------------------------------------

export function buildVisualDataset(): Dataset {
  // Text document that discusses a figure but has no real image assets
  const doc = buildProseDocument(
    "Visual Notes.pdf",
    "Visual Notes",
    "mixed",
    [
      { heading: "Figure 2", paragraphs: ["This chart shows quarterly revenue growth spurvertrend."], page: 2 },
      { heading: "Table 1", paragraphs: ["The table lists experiment data tabulatedblob."], page: 1 },
    ]
  );
  const cases: EvaluationCase[] = [
    { id: "g-vis-1", category: "visual", query: "What does figure 2 show?", expectedAnswerEvidence: ["spurvertrend"] },
    { id: "g-vis-2", category: "visual", query: "What does the chart show?", expectedAnswerEvidence: ["spurvertrend"] },
    { id: "g-vis-3", category: "visual", query: "What is in table 1?", expectedAnswerEvidence: ["tabulatedblob"] },
  ];
  return { docs: [doc], cases: withSource(cases, "Visual Notes") };
}

// ---------------------------------------------------------------------------
// J) General chat regression (Step T): no document → normal path
// ---------------------------------------------------------------------------

export function buildGeneralChatCases(): EvaluationCase[] {
  return [
    { id: "g-gen-1", category: "general_chat", query: "Hello", shouldRetrieve: false, shouldRefuse: false, note: "no document — normal chat" },
    { id: "g-gen-2", category: "general_chat", query: "What can you do?", shouldRetrieve: false, shouldRefuse: false, note: "no document — normal chat" },
    { id: "g-gen-3", category: "general_chat", query: "Thanks", shouldRetrieve: false, shouldRefuse: false, note: "no document — normal chat" },
  ];
}

// ---------------------------------------------------------------------------
// K) Follow-up (Step S): grounded follow-ups
// ---------------------------------------------------------------------------

export function buildFollowUpCases(): EvaluationCase[] {
  return [
    { id: "g-fu-1", category: "follow_up", query: "What is normalization?", expectedAnswerEvidence: [] },
    { id: "g-fu-2", category: "follow_up", query: "Explain that in more detail.", note: "follow-up — context continues" },
    { id: "g-fu-3", category: "follow_up", query: "Where is this discussed?", note: "follow-up — should stay grounded" },
  ];
}

// ---------------------------------------------------------------------------
// C2) Roman-numeral chapter document — exercises roman/ordinal support in the
//     exact-question path across a different structural parent (chapter), plus
//     a NOT-FOUND chapter case inside the same document.
// ---------------------------------------------------------------------------

const ROMAN_LITERALS = ["I", "II", "III", "IV", "V"];

export function buildChapterDataset(): Dataset {
  const chunks: SyntheticChunkSpec[] = [];
  let page = 1;
  for (let n = 1; n <= 5; n++) {
    const roman = ROMAN_LITERALS[n - 1];
    chunks.push({ parts: [`CHAPTER ${roman}`, `Chapter ${roman} covers chapter topics here.`], page });
    page += 1;
    for (const q of [1, 2, 5]) {
      chunks.push({ parts: [`Question ${q}`, `Chapter ${roman} Question ${q} text rb${n}q${q}needle`], page });
      page += 1;
      chunks.push({ parts: [`rb${n}q${q} unique evidence needle`], page });
      page += 1;
    }
    if (n === 3) {
      chunks.push({ parts: ["Exercise 1", "Chapter III Exercise 1 problem statement."], page });
      page += 1;
      chunks.push({ parts: ["rb3ex1 unique evidence needle"], page });
      page += 1;
      chunks.push({ parts: ["Exercise 2", "Chapter III Exercise 2 problem statement."], page });
      page += 1;
      chunks.push({ parts: ["rb3ex2 unique evidence needle"], page });
      page += 1;
    }
  }

  const doc = buildDocument({
    name: "Reference Book RB.pdf",
    displayName: "Reference Book RB",
    type: "pdf",
    chunks,
  });

  const cases: EvaluationCase[] = [
    { id: "g-rb-ch1", category: "exact_question", query: "Chapter I Question 1", expectedLocation: { chapter: "1", question: "1" }, expectedAnswerEvidence: ["rb1q1 unique evidence needle"] },
    { id: "g-rb-ch3-q2", category: "exact_question", query: "Chapter III Question 2", expectedLocation: { chapter: "3", question: "2" }, expectedAnswerEvidence: ["rb3q2 unique evidence needle"] },
    { id: "g-rb-ch4", category: "exact_question", query: "Chapter IV Question 5", expectedLocation: { chapter: "4", question: "5" }, expectedAnswerEvidence: ["rb4q5 unique evidence needle"] },
    { id: "g-rb-ch5", category: "exact_question", query: "Chapter V Question 5", expectedLocation: { chapter: "5", question: "5" }, expectedAnswerEvidence: ["rb5q5 unique evidence needle"] },
    { id: "g-rb-neg", category: "exact_question_negative", query: "Chapter IX Question 999", shouldRetrieve: false, shouldRefuse: true, expectedLocation: { chapter: "9", question: "999" }, expectedAnswerEvidence: [], forbiddenEvidence: ["rb1q1 unique evidence needle", "rb4q5 unique evidence needle"] },
  ];

  return { docs: [doc], cases: withSource(cases, "Reference Book RB") };
}

// ---------------------------------------------------------------------------
// C3) Plain semantic prose — verifies that the normal semantic RAG path still
//     pulls long-tail topical answers (not just structured question lookups).
// ---------------------------------------------------------------------------

export function buildSemanticDataset(): Dataset {
  const doc = buildProseDocument(
    "Databases.pdf",
    "Databases",
    "pdf",
    [
      { heading: "Normalization", paragraphs: ["Normalization reduces data redundancy and improves integrity."], page: 1 },
      { heading: "ACID Properties", paragraphs: ["Atomicity, consistency, isolation and durability guarantee transactions."], page: 2 },
      { heading: "Indexing", paragraphs: ["Indexes speed up read queries at the cost of storage."], page: 3 },
    ]
  );
  const cases: EvaluationCase[] = [
    { id: "g-sem-norm", category: "semantic", query: "What is normalization?", expectedAnswerEvidence: ["Normalization reduces data redundancy"] },
    { id: "g-sem-acid", category: "semantic", query: "Explain ACID properties", expectedAnswerEvidence: ["guarantee transactions"] },
    { id: "g-sem-index", category: "semantic", query: "Summarize how indexing works", expectedAnswerEvidence: ["Indexes speed up read queries"] },
  ];
  return { docs: [doc], cases: withSource(cases, "Databases") };
}

// ---------------------------------------------------------------------------
// Combine everything into one dataset
// ---------------------------------------------------------------------------

export function buildFullDataset(): Dataset {
  const sets = [
    buildTextbookDataset(),
    buildProseDataset(),
    buildResumeDataset(),
    buildLongDataset(),
    buildConfusionDataset(),
    buildCrossChunkDataset(),
    buildArbitraryDataset(),
    buildMultiDataset(),
    buildVisualDataset(),
    buildChapterDataset(),
    buildSemanticDataset(),
  ];

  const docs = sets.flatMap((s) => s.docs);
  const cases = [
    ...sets.flatMap((s) => s.cases),
    ...buildGeneralChatCases(),
    ...buildFollowUpCases(),
  ];

  return { docs, cases };
}
