// ---------------------------------------------------------------------------
// Phase 5G — RAG Evaluation module barrel
//
// Export everything needed to build and run the generic RAG evaluation suite.
// This module is OBSERVATIONAL: it drives the existing production retrieval
// functions and scores output. It never modifies production code.
// ---------------------------------------------------------------------------

export * from "./evaluation-types";
export * from "./document-builder";
export * from "./retrieval-evaluator";
export * from "./metrics";
export * from "./structural-evaluator";
export * from "./classifier";
export * from "./source-evaluator";
