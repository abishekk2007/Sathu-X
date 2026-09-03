// ---------------------------------------------------------------------------
// Phase 8A — Agent Controller
//
// A deterministic, server-safe classification layer that sits ABOVE the Phase
// 6B central query router. It answers ONE question — "what kind of task is
// this?" — by classifying an incoming request into a small set of high-level
// capability routes (CHAT, DOCUMENT_RAG, WEB_RESEARCH, HYBRID_RAG_WEB, …).
//
// It does NOT execute anything. It never answers questions, never runs tools,
// never builds a task graph, never talks to a model, and never exposes its
// internal reasoning to the client. 8A is routing only; execution stays
// exactly where it is today (the /api/chat pipeline driven by the underlying
// Phase 6B decision).
//
// Composition — everything is REUSED, never duplicated:
//   - routeQuery (Phase 6B)      → fine-grained capability decision + plan
//   - derivePlaceQuery (Phase 8) → near-me place noun for MAPS classification
//   - nearMePhrase (Phase 7F)    → near-me phrasing for LOCATION classification
//
// The controller adds precisely the three signals routeQuery was never asked
// to see: deliberate voice input (inputModality), a shared coarse location,
// and a "find X near me" map request. Everything else is the existing router's
// decision, remapped to the high-level taxonomy.
//
// Low-confidence / ambiguous input falls back to CHAT (the existing Gemini
// pipeline) — the controller must never invent a capability.
// ---------------------------------------------------------------------------

import {
  routeQuery,
  type QueryRouteDecision,
  type QueryRoutingInput,
} from "./query-router";
import { nearMePhrase, type SharedLocation } from "@/lib/location";
import { derivePlaceQuery } from "@/lib/map-utils";

/** How the turn physically arrived: typed text or speech-to-text. */
export type InputModality = "text" | "voice";

/**
 * High-level capability routes (Phase 8A taxonomy).
 *
 * The full required set is covered (CHAT, DOCUMENT_RAG, WEB_RESEARCH,
 * HYBRID_RAG_WEB, IMAGE_UNDERSTANDING, IMAGE_GENERATION, VOICE, LOCATION,
 * MAPS, MULTIMODAL, UNKNOWN). Four faithful extras are also surfaced because
 * they map to capabilities that already exist and run today — folding them
 * into a sibling category would mislabel real behavior:
 *   - REALTIME          → 6A real-time / calculation / domain-advisory turns
 *   - HYBRID            → 6B real-time + document/visual fusion turns
 *   - TASK_MANAGEMENT   → 6G task/plan commands
 *   - CLARIFICATION     → ambiguous-deictic turns (kept separate from CHAT)
 */
export type AgentRoute =
  | "CHAT"
  | "DOCUMENT_RAG"
  | "WEB_RESEARCH"
  | "HYBRID_RAG_WEB"
  | "HYBRID"
  | "IMAGE_UNDERSTANDING"
  | "IMAGE_GENERATION"
  | "VOICE"
  | "LOCATION"
  | "MAPS"
  | "MULTIMODAL"
  | "REALTIME"
  | "TASK_MANAGEMENT"
  | "CLARIFICATION"
  | "UNKNOWN";

/** The specific image operation behind an IMAGE_GENERATION high-level route. */
export type ImageOperation = "generate" | "edit" | "document_visual";

/**
 * Structured, client-safe metadata for a classification. No secrets, no raw
 * coordinates, no internals — only facts the existing app already surfaces.
 */
export interface AgentRouteMetadata {
  /** Modality the turn arrived under (when known). */
  inputModality?: InputModality;
  /** Sanitized shared location (Phase 7F) — already coarsened, never raw. */
  location?: SharedLocation;
  /** Derived near-me place noun for a MAPS turn (null when not MAPS). */
  mapQuery?: string | null;
  /** Image operation for an IMAGE_GENERATION turn. */
  imageOperation?: ImageOperation;
  /** Phase 7C — whether the underlying decision triggers web research. */
  requiresWeb?: boolean;
  /** Underlying 6A real-time intent for REALTIME / HYBRID turns. */
  realtimeIntent?: string;
  /** Underlying 6G task/plan intent for TASK_MANAGEMENT turns. */
  taskKind?: string;
  /** True when fresh image bytes rode along with this turn (camera/upload). */
  hasFreshUploadedImage?: boolean;
}

export interface AgentRouteResult {
  /** The high-level capability that should answer this request. */
  route: AgentRoute;
  /** Heuristic 0..1 — guidance only, never presented as authoritative. */
  confidence: number;
  confidenceLabel: "high" | "medium" | "low";
  /** Server-only signals that led to this classification. */
  signals: string[];
  /** Server-only one-line rationale. MUST never reach the client. */
  reason: string;
  /** Structured, safe metadata for the consuming pipeline. */
  metadata: AgentRouteMetadata;
  /**
   * The exact Phase 6B decision. The chat route executes THIS unchanged — 8A
   * classifies on top of it, it never replaces or rewrites the execution plan.
   */
  underlying: QueryRouteDecision;
}

/**
 * Inputs to the controller: the full Phase 6B router input plus the three
 * Phase 7F/8 signals the router was never asked to see.
 */
export interface AgentRouteRequest extends QueryRoutingInput {
  /** "voice" when the turn arrived via speech-to-text ("text" by default). */
  inputModality?: InputModality;
  /** The already-sanitized shared location (Phase 7F), if any. */
  location?: SharedLocation | null;
  /** True when fresh image BYTES arrived with this turn (camera/upload). */
  freshUploadedImage?: boolean;
}

/** Real-time-flavoured nouns derivePlaceQuery would leave as a "place noun". */
const REALTIME_PLACE_BLOCKERS =
  /\b(?:weather|forecast|temperature|humidity|rain|snow|wind|thunder|storm|currency|exchange\s+rate|time\s+zone|timezone|date|news|price|prices)\b/i;

/** Question fragments that are never a map place noun. */
const QUESTION_FRAGMENT = /^(?:what|how|when|where|why|who)[\s'’-]/;

/** Explicit "where am I / my location" phrasing (beyond nearMePhrase). */
const EXPLICIT_LOCATION_ASK = /\b(?:my\s+location|where\s+am\s+i)\b/i;

/**
 * The derived near-me place noun is credible only when it is not a real-time
 * noun and not a trailing question fragment ("what is weather" → reject, the
 * turn stays CHAT/REALTIME instead of fabricating a map). "find hospitals near
 * me" → "hospitals" → credible.
 */
export function credibleMapQuery(noun: string | null | undefined): boolean {
  if (!noun) return false;
  const text = noun.trim();
  if (text.length < 2) return false;
  if (QUESTION_FRAGMENT.test(text)) return false;
  if (REALTIME_PLACE_BLOCKERS.test(text)) return false;
  return true;
}

interface BaseClassification {
  route: AgentRoute;
  reason: string;
  imageOperation?: ImageOperation;
}

function classificationFor(underlying: QueryRouteDecision): BaseClassification {
  switch (underlying.primaryRoute) {
    case "GENERAL":
      return { route: "CHAT", reason: "plain conversational turn" };
    case "CLARIFICATION":
      return { route: "CLARIFICATION", reason: "ambiguous deictic turn" };
    case "DOCUMENT_RAG":
      return underlying.routes.includes("WEB_RESEARCH")
        ? { route: "HYBRID_RAG_WEB", reason: "document sources plus web research" }
        : { route: "DOCUMENT_RAG", reason: "document sources attached" };
    case "WEB_RESEARCH":
      return { route: "WEB_RESEARCH", reason: "freshness or web request" };
    case "VISUAL":
      return { route: "IMAGE_UNDERSTANDING", reason: "visual reference over sources" };
    case "MULTIMODAL":
      return { route: "MULTIMODAL", reason: "visual reference plus textual analysis" };
    case "REALTIME_DATE":
    case "REALTIME_TIME":
    case "REALTIME_WEATHER":
    case "REALTIME_CURRENCY":
    case "CALCULATION":
    case "DOMAIN_REALTIME":
      return { route: "REALTIME", reason: "real-time / calculation / domain intent" };
    case "HYBRID":
      return { route: "HYBRID", reason: "real-time intent fused with document or visual evidence" };
    case "IMAGE_GENERATION":
      return { route: "IMAGE_GENERATION", reason: "text-to-image request", imageOperation: "generate" };
    case "IMAGE_EDIT":
      return { route: "IMAGE_GENERATION", reason: "reference-image edit", imageOperation: "edit" };
    case "DOCUMENT_VISUAL_GENERATION":
      return { route: "IMAGE_GENERATION", reason: "document-to-visual generation", imageOperation: "document_visual" };
    case "TASK_MANAGEMENT":
    case "TASK_QUERY":
    case "PLAN_GENERATION":
      return { route: "TASK_MANAGEMENT", reason: "task or plan command" };
    default:
      return { route: "UNKNOWN", reason: `unmapped router route ${underlying.primaryRoute}` };
  }
}

function result(
  route: AgentRoute,
  confidence: number,
  signals: string[],
  reason: string,
  metadata: AgentRouteMetadata,
  underlying: QueryRouteDecision
): AgentRouteResult {
  return {
    route,
    confidence,
    confidenceLabel: confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low",
    signals,
    reason,
    metadata,
    underlying,
  };
}

/**
 * The images the controller forwards to routeQuery. A fresh upload is mirrored
 * into the router's image-context as the canonical `upload` entry (the /api/chat
 * route does the same) so the underlying decision is identical no matter how the
 * caller supplied the flag — determinism is guaranteed by construction.
 */
function withRouterImages(request: AgentRouteRequest): Array<{ key: string }> {
  const refs = [...(request.images ?? [])];
  if (request.freshUploadedImage && !refs.some((ref) => ref.key === "upload")) {
    refs.push({ key: "upload" });
  }
  return refs;
}

/**
 * Classifies a normalized request into a high-level AgentRoute.
 *
 * Order of precedence:
 *   1. Empty/invalid message            → UNKNOWN (low confidence)
 *   2. MAPS  — shared location + credible near-me place noun (over plain chat)
 *   3. LOCATION — shared location + near-me / "where am I" phrasing (no map noun)
 *   4. Fresh image on a plain chat turn → IMAGE_UNDERSTANDING
 *      Fresh image on a web-research turn → MULTIMODAL (image + web fuse)
 *   5. VOICE — speech modality over a plain chat turn (no fresh image)
 *   6. Everything else → the underlying Phase 6B decision remapped to the
 *      high-level taxonomy (specialist capabilities ALWAYS win over generic
 *      overrides — "describe the weather near me" stays real-time, not MAPS).
 */
export function classifyAgentRoute(request: AgentRouteRequest): AgentRouteResult {
  const message = (request.message ?? "").trim();
  const signals: string[] = [];
  const metadata: AgentRouteMetadata = {
    ...(request.inputModality ? { inputModality: request.inputModality } : {}),
    ...(request.location ? { location: request.location } : {}),
    ...(request.freshUploadedImage ? { hasFreshUploadedImage: true } : {}),
  };

  if (!message) {
    const underlying = routeQuery({ ...request, images: withRouterImages(request) });
    return result(
      "UNKNOWN",
      0.2,
      ["empty-message"],
      "empty or whitespace-only message",
      metadata,
      underlying
    );
  }

  // RouteQuery is the single source of truth for every existing capability.
  // A fresh upload is mirrored into the image-context it sees (see
  // withRouterImages) so the underlying decision can never drift from /api/chat.
  const underlying = routeQuery({ ...request, images: withRouterImages(request) });
  if (underlying.requiresWeb) metadata.requiresWeb = true;
  if (underlying.realtimeDecision) metadata.realtimeIntent = underlying.realtimeDecision.intent;
  if (underlying.taskIntent) metadata.taskKind = underlying.taskIntent.intent;
  if (underlying.planIntent) metadata.taskKind = underlying.planIntent.intent;

  const base = classificationFor(underlying);
  if (base.imageOperation) metadata.imageOperation = base.imageOperation;

  const hasLocation = Boolean(request.location);
  const freshImage = Boolean(request.freshUploadedImage);

  // 2. MAPS — a shared location plus a credible place noun is the only shape
  // that must render the existing Leaflet/Nominatim pipeline. Overrides plain
  // chat only; specialist routes below always win.
  if (hasLocation && base.route === "CHAT") {
    const mapQuery = derivePlaceQuery(message);
    if (credibleMapQuery(mapQuery)) {
      metadata.mapQuery = mapQuery;
      signals.push("map-query", "shared-location");
      return result(
        "MAPS",
        0.85,
        signals,
        `near-me place search "${mapQuery}" with a shared location`,
        metadata,
        underlying
      );
    }
  }

  // 3. LOCATION — the turn actively needs the shared location but has no map
  // noun ("what's around here", "where am I").
  if (hasLocation && base.route === "CHAT" && (nearMePhrase(message) || EXPLICIT_LOCATION_ASK.test(message))) {
    signals.push("location-ask", "shared-location");
    return result(
      "LOCATION",
      0.78,
      signals,
      "location-referential turn with a shared location",
      metadata,
      underlying
    );
  }

  // 4. Fresh image rides along — the vision pipeline runs in every case today.
  if (freshImage) {
    if (base.route === "WEB_RESEARCH") {
      signals.push("fresh-image", "web-research");
      return result(
        "MULTIMODAL",
        0.8,
        signals,
        "fresh image plus a web-research ask (image + text)",
        metadata,
        underlying
      );
    }
    if (base.route === "CHAT" || base.route === "CLARIFICATION") {
      signals.push("fresh-image");
      return result(
        "IMAGE_UNDERSTANDING",
        0.85,
        signals,
        "fresh image on a plain turn (identify / describe / inspect)",
        metadata,
        underlying
      );
    }
  }

  // 5. Voice modality over a plain turn — speech-to-text, no image to ride.
  if (request.inputModality === "voice" && base.route === "CHAT") {
    signals.push("voice-input");
    return result(
      "VOICE",
      0.75,
      signals,
      "spoken turn over the general chat pipeline",
      metadata,
      underlying
    );
  }

  // 6. Specialist / everything else — remapped 6B decision, confidence, signals.
  signals.push("router-primary", underlying.primaryRoute);
  return result(base.route, underlying.confidence, signals, base.reason, metadata, underlying);
}

/** Human-readable description for server logs (never sent to the client). */
export function describeAgentRoute(decision: AgentRouteResult): string {
  return decision.route;
}