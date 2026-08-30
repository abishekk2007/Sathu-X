# Spidey Bot — RAG Pipeline Map (Phase 5G Audit)

This document maps the complete existing RAG pipeline, stage by stage, to the
files and functions that implement it. It was created during Phase 5G Step 1
(architecture audit) and does NOT change any production code.

Legend: `L1` = request-local, `L2` = per-instance LRU cache.

---

## End-to-End Pipeline

```
USER QUERY
  ↓
QUERY NORMALIZATION            → normalizeQuery()  (query-analyzer.ts)
  ↓
QUERY ANALYSIS                 → analyzeQuery()    (query-analyzer.ts)
  ↓
INTENT DETECTION               → detectIntent()    (query-analyzer.ts)
  ↓
STRUCTURAL MARKER EXTRACTION   → extractStructuralMarkers() (query-analyzer.ts)
  ↓
SOURCE SELECTION               → selectSources() / classifySourceIntent() (agent/)
  ↓
DOCUMENT RETRIEVAL             → retrieveAgentContext() (context.ts)
  ↓
SEMANTIC RETRIEVAL             → scoreChunk() / scoreTokenOverlap() (scoring.ts)
  ↓
STRUCTURAL RETRIEVAL           → scoreHierarchicalStructural() / exact-lookup path (document-retrieval.ts)
  ↓
RERANKING                      → promoteStructuralMatches() / expandAdjacentChunks() (reranker.ts)
  ↓
MULTI-SOURCE FUSION            → orchestrateMultiSourceRetrieval() (multi-source.ts)
  ↓
VISUAL EVIDENCE                → getVisualAssets() / detectVisualAugmentation() (context.ts) + loadVisualEvidence() (visual-evidence.ts)
  ↓
CONTEXT BUDGETING              → boundContext() / applyMultiSourceBudget() (context.ts, multi-source.ts)
  ↓
GROUNDING POLICY               → buildGroundingInstruction() / explainRetrievalFailure() (policy.ts, retrieval/index.ts)
  ↓
GEMINI                         → streaming route (route.ts)
  ↓
FINAL ANSWER
  ↓
SOURCE ATTRIBUTION             → formatAgentRetrievalContext() (context.ts) preserves source/name/page
```

---

## Stage-by-Stage Map

| Stage | File | Function | Input | Output | Failure Mode |
|-------|------|----------|-------|--------|--------------|
| Query normalization | `src/lib/retrieval/query-analyzer.ts` | `normalizeQuery()` | raw user query | normalized string | Unicode/number stripping loses meaning (rare) |
| Query analysis | `src/lib/retrieval/query-analyzer.ts` | `analyzeQuery()` | query | `QueryAnalysis` | wrong intent / missing entity |
| Intent detection | `src/lib/retrieval/query-analyzer.ts` | `detectIntent()` | query + entities | `QueryIntent` | misclassified as semantic vs structural |
| Marker extraction | `src/lib/retrieval/query-analyzer.ts` | `extractStructuralMarkers()` | text | `StructuralMarker[]` | marker missed → structural retrieval offline |
| Scope detection | `src/lib/retrieval/query-analyzer.ts` | `detectScopeQuery()` | query + entities | boolean | scope misses parent → falls through to scoring |
| Source intent | `src/lib/agent/source-intent.ts` | `classifySourceIntent()` | query + sources | `SourceIntentAnalysis` | wrong strategy → wrong sources |
| Source selection | `src/lib/agent/source-selector.ts` | `selectSources()` | sources + strategy | `SourceSelection[]` | wrong source chosen / source dropped |
| Orchestrator | `src/lib/agent/context.ts` | `retrieveAgentContext()` | request + userId | `RetrievalResult[]` | per-source retrieval failure swallowed |
| Doc retrieval | `src/lib/document-retrieval.ts` | `retrieveDocumentChunks()` | docId + query | `RetrievalResult` | confidence misjudged |
| Exact question lookup | `src/lib/document-retrieval.ts` | exact-lookup path (lines 256–343) | question + path | core chunks | wrongly structured doc → no match |
| Scope retrieval | `src/lib/document-retrieval.ts` | `retrieveScopeChunks()` | scope + contextMap | scope chunks | non-standard question formatting |
| Semantic scoring | `src/lib/retrieval/scoring.ts` | `scoreChunk()` | chunk + analysis | `ScoredChunk` | tokens too generic → weak ranking |
| Token overlap | `src/lib/retrieval/scoring.ts` | `scoreTokenOverlap()` | tokens + chunk | score | synonyms not matched (no embeddings) |
| Hierarchical scoring | `src/lib/retrieval/scoring.ts` | `scoreHierarchicalStructural()` | markers + content | score | path validation too strict → correct chunk scored 0 |
| Path validation | `src/lib/retrieval/scoring.ts` | `validateStructuralPath()` | query+content markers | boolean | wrong-region markers combine → false positive |
| Rerank structural | `src/lib/retrieval/reranker.ts` | `promoteStructuralMatches()` | candidates + markers | re-ranked | boost masks true semantic candidate |
| Adjacent expansion | `src/lib/retrieval/reranker.ts` | `expandAdjacentChunks()` | selected + all | expanded | crosses structural boundary |
| Diversity filter | `src/lib/retrieval/reranker.ts` | `filterDuplicates()` | chunks | deduped | Jaccard 0.7 too aggressive |
| Context bounding | `src/lib/retrieval/reranker.ts` | `boundContext()` | chunks | bounded | truncates relevant tail |
| Multi-source orchestration | `src/lib/agent/multi-source.ts` | `orchestrateMultiSourceRetrieval()` | query + sources | `MultiSourceResult` | source budget starvation |
| Conflict detection | `src/lib/agent/conflict-detector.ts` | `detectConflicts()` | results | conflicts | unresolved contradictions |
| Evidence consolidation | `src/lib/agent/conflict-detector.ts` | `consolidateEvidence()` | results | deduped | cross-source near-dup drops |
| Visual asset lookup | `src/lib/agent/context.ts` | `getVisualAssets()` | doc+user | assets | DB error → empty (silent) |
| Visual augmentation | `src/lib/agent/context.ts` | `detectVisualAugmentation()` | query + assets | augment | wrong asset type matched |
| Visual intent | `src/lib/agent/visual-intent.ts` | `detectVisualIntent()` | query | `VisualQueryIntent` | misclassifies visual→text |
| Visual evidence load | `src/lib/agent/visual-evidence.ts` | `loadVisualEvidence()` | intent + sources | visuals | storage failure → partial failure |
| Grounding instruction | `src/lib/agent/policy.ts` | `buildGroundingInstruction()` | context | prompt text | — |
| Failure explanation | `src/lib/retrieval/index.ts` | `explainRetrievalFailure()` / `classifyRetrievalState()` | state | message | — |
| Context formatting | `src/lib/agent/context.ts` | `formatAgentRetrievalContext()` | results | prompt string | attribution lost |
| Source attribution | `src/lib/agent/context.ts` | formatting (lines 698–732) | results | grouped source labels | — |
| Chat route | `src/app/api/chat/route.ts` | `POST()` | request | streaming answer | — |
| LRU cache | `src/lib/cache.ts` | `LRU` | k/v + ttl | cached | TTL stale |
| Query analysis cache | `src/lib/cache.ts` | `queryAnalysisCache` | query | analysis | — |
| Visual asset cache | `src/lib/cache.ts` | `visualAssetCache` | user:doc | assets | stale for 2min |
| In-flight dedup | `src/lib/cache.ts` | `dedupeInFlight()` | key+fn | promise | — |

---

## Failure-Mode-to-Stage Cross-Reference (Phase 5G Step 8/11)

| Observation | Likely Stage | 5G Classification |
|---|---|---|
| Right document, right location, wrong answer | Post-retrieval generation | `GENERATION_FAILURE` or `GROUNDING_FAILURE` |
| Right documents chosen but wrong location retrieved | Semantic/structural retrieval or reranking | `SEMANTIC_RETRIEVAL_FAILURE` / `STRUCTURAL_RETRIEVAL_FAILURE` / `RERANKING_FAILURE` |
| Requested source excluded from results | Source selection | `SOURCE_SELECTION_FAILURE` |
| Multi-source question missing one source | Multi-source fusion/budget | `MULTI_SOURCE_FAILURE` |
| Visual query returns no visual evidence | Visual retrieval | `VISUAL_RETRIEVAL_FAILURE` |
| Document text missing (chunks empty/wrong) | Extraction/ingestion | `INGESTION_FAILURE` or `CHUNKING_FAILURE` |
| Structural number lost during extraction | Extraction/ingestion | `INGESTION_FAILURE` |
| No retrieval attempt / source not attached | Orchestrator/router | `SOURCE_SELECTION_FAILURE` |

---

## Evaluation Boundary (What 5G observes)

The 5G evaluation framework is **observational**: it drives the EXISTING pure
retrieval functions (`analyzeQuery`, `scoreChunk`, `scoreHierarchicalStructural`,
`validateStructuralPath`, `promoteStructuralMatches`, `validateStructuralMatch`,
`filterDuplicates`, `boundContext`, source selection / multi-source), builds
synthetic arbitrary documents, and scores whether the correct evidence is
retrieved. It does not re-implement retrieval.

Live database + Gemini + browser end-to-end evaluation requires credentials and
a dev server → marked **MANUAL REQUIRED** in the report where inapplicable.
