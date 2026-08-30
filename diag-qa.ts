import { buildTextbookDataset } from "./src/lib/evaluation/dataset";
import { analyzeQuery, extractStructuralMarkers } from "./src/lib/retrieval";

const { docs, cases } = buildTextbookDataset();
const doc = docs[0];

function buildCtxMap(chunks: { chunk_index: number; content: string }[]) {
  const map = new Map<number, Record<string, string | null>>();
  const cur: Record<string, string | null> = { unit: null, module: null, chapter: null, section: null, subsection: null, part: null };
  // Mirror of STRUCTURAL_DEPTH in scoring.ts — a shallower container resets any
  // deeper parent scope inherited from earlier content.
  const SCOPE_DEPTH: Record<string, number> = {
    unit: 0, module: 1, chapter: 2, section: 3, subsection: 4, part: 5,
  };
  for (const c of chunks) {
    for (const m of extractStructuralMarkers(c.content.toLowerCase())) {
      if (m.type in cur) {
        for (const k of Object.keys(cur)) {
          if ((SCOPE_DEPTH[k] ?? 50) > (SCOPE_DEPTH[m.type] ?? 50) && cur[k] != null) cur[k] = null;
        }
        cur[m.type] = m.number;
      }
    }
    map.set(c.chunk_index, { ...cur });
  }
  return map;
}

for (const q of [
  "Unit 4 Question 5",
  "Unit 2 Question 5",
  "Unit 1 Question 5",
  "Question 5",
  "Question No. 5",
  "Q5",
  "5th question",
]) {
  const a = analyzeQuery(q);
  const markers = a.entities.structuralPath;
  console.log("====", q);
  console.log("  questionNumber=", a.entities.questionNumber, "pathLen=", markers.length, "scope=", a.scopeQuery, "path=", JSON.stringify(markers));
  const ctx = buildCtxMap(doc.chunks);
  // find chunks matching target question
  const qn = a.entities.questionNumber;
  if (qn) {
    const req: Record<string, string> = {};
    for (const m of markers) {
      if (m.type === "question") continue;
      if (m.type in req) continue;
      req[m.type] = m.number;
    }
    const re = new RegExp(`\\b(?:question|q\\.?)\\s*(?:no\\.?\\s*)?${qn}\\b`, "i");
    const hits = doc.chunks
      .map((c, i) => ({ c, i, req, ctx: ctx.get(c.chunk_index)! }))
      .filter(({ c }) => re.test(c.content));
    console.log("  chunks mentioning Q" + qn + ":", hits.map((h) => `idx=${h.i} unit=${h.ctx.unit} part=${h.ctx.part} :: "${h.c.content.split("\n")[0]}"`));
  }
}
