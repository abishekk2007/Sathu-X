// ---------------------------------------------------------------------------
// Phase 6E — Document → Visual generation: visual-type taxonomy
//
// A CONTROLLED, closed vocabulary for the visual artifacts a document-grounded
// visual turn may produce. Keeping the set closed lets the deterministic
// intent detector, the visual spec layer, and the per-type anti-hallucination
// prompt instructions all agree on one vocabulary. Types not in this list are
// never emitted; when the user's wording is ambiguous the spec carries
// `visualType: null` and generation falls back to a generic grounded
// instruction instead of guessing and contradicting the request.
// ---------------------------------------------------------------------------

/** Closed taxonomy of document-grounded visual types. */
export type DocumentVisualType =
  | "infographic"
  | "educational_diagram"
  | "flowchart"
  | "timeline"
  | "concept_map"
  | "process_diagram"
  | "comparison_visual"
  | "chart"
  | "visual_summary"
  | "illustration";

/** Every valid type, in priority order for deterministic type inference. */
export const DOCUMENT_VISUAL_TYPES: readonly DocumentVisualType[] = [
  "infographic",
  "educational_diagram",
  "flowchart",
  "timeline",
  "concept_map",
  "process_diagram",
  "comparison_visual",
  "chart",
  "visual_summary",
  "illustration",
] as const;

/** Friendly singular label used inside composed prompts. */
export const DOCUMENT_VISUAL_LABELS: Record<DocumentVisualType, string> = {
  infographic: "infographic",
  educational_diagram: "educational diagram",
  flowchart: "flowchart",
  timeline: "timeline",
  concept_map: "concept map",
  process_diagram: "process diagram",
  comparison_visual: "comparison visual",
  chart: "data chart",
  visual_summary: "visual summary",
  illustration: "clear illustration",
};

/** True when a type is part of the closed taxonomy. */
export function isDocumentVisualType(value: unknown): value is DocumentVisualType {
  return DOCUMENT_VISUAL_TYPES.includes(value as DocumentVisualType);
}