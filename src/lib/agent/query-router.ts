// ---------------------------------------------------------------------------
// Phase 6B — Central Query Router
//
// A deterministic decision layer that sits ABOVE every existing Spidey Bot
// capability (Phases 1–6A). It inspects the current turn — message, attached
// sources, and prior conversation — and decides WHICH existing capability or
// capabilities handle the request, with a confidence heuristic and a bounded
// execution plan. It never answers questions itself and never rebuilds the
// engines below it; the chat route executes the returned plan through the
// existing retrieval / visual / real-time / Gemini pipelines.
//
// Composition (all reused, never duplicated):
//   - 5A   routeDecision      → sources attached ⇒ RAG is always eligible
//   - 5C   analyzeQuery       → structural markers, question numbers, scope
//   - 5D   classifySourceIntent → compare / multi-source / summary strategies
//   - 5E-2 detectVisualIntent → VISUAL / MULTIMODAL references
//   - 6A   detectRealtimeIntent → date/time/weather/currency/calculation
//   - 6B†  detectDomainIntent   → AGRICULTURE / MARINE / AVIATION /
//                                 SMART_CITY / TRAVEL / OUTDOOR advisory
//   - 6C†  resolveImageGenerationIntent → IMAGE_GENERATION (text→image)
//   - 6D†  detectImageEditIntent → IMAGE_EDIT (source image + instruction)
//   - 6E†  resolveDocumentVisualIntent → DOCUMENT_VISUAL_GENERATION
//         (document-grounded visual: explicit document reference + visual ask)
//
// Priority (strongest first):
//   1. Semantic definition guard       ("What is weather?" → GENERAL, not a query)
//   2. STRONG real-time/domain + explicit doc reference (with sources) → HYBRID
//   3. STRONG real-time + visual reference (with sources)        → HYBRID
//   4. Image EDITING (Phase 6D)        → IMAGE_EDIT — requires conversation
//                                       image context (metadata the client
//                                       sends) or an uploaded image; a
//                                       selected non-existent/multiple
//                                       reference resolves to a clarification
//                                       (SAFE_EDIT_* messages, NO provider
//                                       call). Places ABOVE image generation:
//                                       "make the sky sunset" after a
//                                       generated image must EDIT, not
//                                       regenerate from text.
//   4b. Document → Visual (Phase 6E)   → DOCUMENT_VISUAL_GENERATION — an
//                                       explicit document reference + visual
//                                       ask ("Create an infographic from my
//                                       PDF"). Grounding is THE gate: sources
//                                       attached ⇒ DOCUMENT_RAG evidence runs
//                                       first; no sources ⇒ refusal path.
//                                       "Edit the diagram from my PDF" stays
//                                       an EDIT (branch 4 wins).
//   4c. Image generation (Phase 6C)    → IMAGE_GENERATION — pure, or doc-
//                                       grounded when the turn asks to draw
//                                       from the attached document (a diagram/
//                                       chart noun or an explicit "from my
//                                       notes/PDF"); a doc reference with no
//                                       source attached still routes here but
//                                       must satisfy the RAG-grounded gate.
//   5. Document reference guard        (6A stand-down preserved — even when a
//                                       real-time signal hides behind a doc
//                                       reference, hybrid needs attached
//                                       sources to ground the document branch)
//   6. Follow-up context resolution    (before single real-time, because a bare
//                                       temporal like "what about tomorrow?" is
//                                       itself a 6A DATE_QUERY; full real-time
//                                       intents bypass this and stay direct)
//   6b. Task + Planning (Phase 6G)     → TASK_MANAGEMENT / TASK_QUERY /
//                                       PLAN_GENERATION — deterministic
//                                       bootstrap-verb detection that sits
//                                       BELOW image (4–4c), document (5) and
//                                       follow-up (6) but ABOVE domain (7) and
//                                       single real-time (8), so image/doc
//                                       routes and follow-ups never lose a
//                                       turn, while "remind me to call mom at
//                                       9pm" becomes a task instead of a date.
//   7. Domain advisory (†)             → DOMAIN_REALTIME (domain beats generic
//                                       weather; document refs already skipped)
//   8. Single real-time intent         → REALTIME_* / CALCULATION (direct answer)
//   9. Visual reference with sources   → VISUAL / MULTIMODAL
//  10. Sources attached                → DOCUMENT_RAG
//  11. GENERAL (Gemini), with CLARIFICATION flag for ambiguous deictics
//
// Trusted-answer invariant: REALTIME_DATE / REALTIME_TIME / CALCULATION and
// every successful weather/currency tool result are authoritative and are
// returned directly or fused verbatim (see buildRealtimeSystemInstruction).
// The router never exposes its `reason`/confidence to the client.
// ---------------------------------------------------------------------------

import type { RealtimeDecision, RealtimeIntent } from "@/lib/realtime/types";
import { detectRealtimeIntent, extractCalculation, referencesDocument } from "@/lib/realtime";
import { detectCurrency, detectDateTime, detectWeather } from "@/lib/realtime/intent";
import { detectDomainIntent, extractQueryLocation, resolveDomainContext, type DomainDecision } from "@/lib/realtime/domain";
import { detectVisualIntent, type VisualQueryIntent } from "./visual-intent";
import { analyzeQuery, type QueryAnalysis } from "@/lib/retrieval";
import { classifySourceIntent, type MultiSourceIntent } from "./source-intent";
import {
  resolveImageGenerationIntent,
  grantsGrounding,
  type ImageGenerationIntent,
} from "@/lib/image-generation/intent";
import {
  detectImageEditIntent,
  type ImageEditIntent,
} from "@/lib/image-generation/edit-intent";
import {
  resolveDocumentVisualIntent,
  type DocumentVisualIntent,
} from "@/lib/image-generation/document-visual-intent";
import type { ImageContextRef } from "@/lib/image-generation";
import {
  detectTaskCommand,
  detectPlanCommand,
  type TaskIntentResult,
  type PlanIntentResult,
} from "@/lib/tasks";

// ---------------------------------------------------------------------------
// Route taxonomy (future tools are declared, never activated)
// ---------------------------------------------------------------------------

export type QueryRoute =
  | "GENERAL"
  | "DOCUMENT_RAG"
  | "VISUAL"
  | "MULTIMODAL"
  | "REALTIME_DATE"
  | "REALTIME_TIME"
  | "REALTIME_WEATHER"
  | "REALTIME_CURRENCY"
  | "CALCULATION"
  | "DOMAIN_REALTIME"
  | "HYBRID"
  | "CLARIFICATION"
  | "IMAGE_GENERATION"
  | "IMAGE_EDIT"
  | "DOCUMENT_VISUAL_GENERATION"
  | "TASK_MANAGEMENT"
  | "TASK_QUERY"
  | "PLAN_GENERATION";

/**
 * Future capability slots. Declared for forward compatibility of the route
 * taxonomy but intentionally NOT implemented — the router must not route to
 * a capability that does not exist yet.
 */
export const EXTENSION_POINTS = {
  IMAGE_GENERATION: true,
  IMAGE_EDITING: true,
  DOCUMENT_VISUAL_GENERATION: true,
  WEB_SEARCH: false,
  VOICE: false,
  TASK: true,
  MEMORY: false,
} as const satisfies Record<string, boolean>;

export type ConfidenceLabel = "high" | "medium" | "low";

export interface ExecutionStep {
  id: string;
  kind: "realtime" | "rag" | "visual" | "gemini" | "image";
  /** Step ids this step depends on (a cycle here is a router bug). */
  dependsOn: string[];
  /** Upper bound on external calls for this step. */
  maxCalls: number;
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
  /** Upper bound on total external (network/DB) calls for the request. */
  maxExternalCalls: number;
  /** Router never re-enters itself; recursion depth is always 1. */
  maxDepth: 1;
  /** Independent branches may run concurrently. */
  parallelizable: boolean;
}

export interface QueryRouteDecision {
  primaryRoute: QueryRoute;
  /** Every capability that will actually run (HYBRID reports its parts). */
  routes: QueryRoute[];
  /** Heuristic 0..1. Guidance only — never presented as authoritative. */
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  requiresDocuments: boolean;
  requiresRealtime: boolean;
  requiresVisualEvidence: boolean;
  /** True when the final answer is produced by the Gemini pipeline. */
  requiresGeneralReasoning: boolean;
  /** True when the turn is ambiguous and a concise clarification is wise. */
  requiresClarification: boolean;
  /** Debug-only rationale. MUST never be exposed to the client. */
  reason: string;
  realtimeDecision?: RealtimeDecision;
  /** Phase 6B Extended: the resolved domain advisory decision (sub-route of real-time). */
  domainDecision?: DomainDecision;
  visualIntent?: VisualQueryIntent;
  /** Phase 6C: the detected text→image request (or refinement). */
  imageIntent?: ImageGenerationIntent;
  /** Phase 6D: the detected reference-image edit/regeneration request. */
  imageEditIntent?: ImageEditIntent;
  /** Phase 6E: the detected document→visual generation request. */
  documentVisualIntent?: DocumentVisualIntent;
  /** Phase 6G: the detected task-management command (create/list/complete…). */
  taskIntent?: TaskIntentResult;
  /** Phase 6G: the detected plan intent (create/list). */
  planIntent?: PlanIntentResult;
  queryAnalysis?: QueryAnalysis;
  multiSourceIntent?: MultiSourceIntent;
  executionPlan?: ExecutionPlan;
}

export interface QueryRoutingInput {
  userId: string;
  message: string;
  mode?: string;
  /** True when the turn has attached/selected document sources. */
  hasSources: boolean;
  /** Number of attached sources (for multi-document strategies). */
  sourceCount?: number;
  /** Prior conversation turns (excluding the current message). */
  priorTurns?: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * Phase 6D — images present in the current conversation (metadata only; the
   * chat route sends bytes for the selected source separately). Used by the
   * IMAGE_EDIT branch to decide edits versus generation versus clarification.
   */
  images?: ImageContextRef[];
  subjectId?: string;
  topicId?: string;
}

// ---------------------------------------------------------------------------
// Semantic definition guard
// ---------------------------------------------------------------------------

const REALTIME_CONCEPT_TERMS =
  /\b(?:weather|forecast|temperature|humidity|wind|rain|snow|thunder|storm|currency|exchange\s+rate|time\s+zone|timezone)\b/i;

const REALTIME_CONCEPT_KEEPERS =
  /\b(?:today|tomorrow|now|like|current|right\s+now|this\s+week|this\s+weekend|in\s+|for\s+|at\s+|to\s+)\b/i;

/**
 * True when the message is a DEFINITION question about a real-time concept
 * ("What is weather?", "Define exchange rate", "Explain what temperature
 * means"). Bare keyword matching would hijack these into the weather/
 * currency tools, so the router diverts them to GENERAL.
 *
 * Deliberately does NOT catch data requests: "What is the weather?",
 * "What is the forecast for tomorrow?", "How hot is Chennai?" all stay real-time.
 */
export function isRealtimeConceptDefinition(message: string): boolean {
  const text = message
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[?!.]+$/, "")
    .toLowerCase();
  if (!REALTIME_CONCEPT_TERMS.test(text)) return false;

  // "…definition/meaning of X", "define X", "what does X mean?"
  if (
    /^(?:what|explain)\s+(?:is\s+)?(?:the\s+)?(?:definition|meaning)\s+of\s+/.test(text) ||
    /^define\s+(?:the\s+)?/.test(text) ||
    (/^what\s+does\s+/.test(text) && /\s+mean\s*$/.test(text))
  ) {
    const rest = text
      .replace(/^(?:what|explain)\s+(?:is\s+)?(?:the\s+)?(?:definition|meaning)\s+of\s+/, "")
      .replace(/^define\s+(?:the\s+)?/, "")
      .replace(/^what\s+does\s+(?:the\s+)?/, "")
      .replace(/\s+mean\s*$/, "")
      .replace(/^(?:a\s+|an\s+|the\s+)/, "");
    return REALTIME_CONCEPT_TERMS.test(rest) && !REALTIME_CONCEPT_KEEPERS.test(rest);
  }

  // "explain what X means" / "explain the concept of X"
  if (/^explain\s+(?:what\s+|the\s+concept\s+of\s+)?/.test(text)) {
    const rest = text
      .replace(/^explain\s+(?:what\s+|the\s+concept\s+of\s+)?/, "")
      .replace(/\s+(?:means?|is\s+about)\s*$/, "");
    return REALTIME_CONCEPT_TERMS.test(rest) && !REALTIME_CONCEPT_KEEPERS.test(rest);
  }

  // "what is weather?" / "what is a forecast?" — a bare or article-prefixed
  // term with no data-request continuation is a definition question.
  // Rejects "what is THE weather?" (data request) via the leading-article rule,
  // and "what is weather in Chennai?" via the continuation (in/for/at/like) rule.
  if (/^what(?:'s|s|\s+is|\s+are|\s+does)\s+/.test(text)) {
    const rest = text.replace(/^what(?:'s|s|\s+is|\s+are|\s+does)\s+/, "");
    if (/^the\s+/.test(rest)) return false;
    const term = rest.replace(/^(?:a\s+|an\s+|the\s+concept\s+of\s+)/, "");
    return (
      REALTIME_CONCEPT_TERMS.test(term) &&
      !REALTIME_CONCEPT_KEEPERS.test(term) &&
      term.split(/\s+/).length <= 3
    );
  }

  return false;
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

/** Strong real-time intents carry a self-contained, groundable value. */
function isStrongRealtime(rt: RealtimeDecision | undefined): boolean {
  if (!rt?.handled) return false;
  switch (rt.intent) {
    case "CALCULATION":
      return true;
    case "CURRENCY_CONVERSION":
    case "EXCHANGE_RATE":
      // Guard case (unparseable pair) has an empty params object — not strong.
      return Boolean(rt.params?.from && rt.params?.to);
    case "WEATHER_CURRENT":
    case "WEATHER_FORECAST":
      return Boolean(rt.params?.location);
    default:
      return false;
  }
}

/**
 * Common English prose words that never appear in a real place name. 6A's
 * "<City> weather" lead pattern can read a whole sentence as a "city"
 * ("Tell me a story about weather" → location "Tell me a story about"); the
 * router must never pass that to a geocoder. Empty location stays allowed —
 * that is 6A's "which location?" prompt path.
 */
const WEATHER_PROSE_WORDS =
  /\b(?:me|a|an|and|about|of|for|the|to|your|my|some|one|this|that|it|is|like|story|stories|please|tell)\b/i;

function isCredibleWeatherLocation(params: RealtimeDecision["params"]): boolean {
  if (!params?.location) return true;
  return !WEATHER_PROSE_WORDS.test(params.location);
}

const REALTIME_ROUTE_BY_INTENT: Record<Exclude<RealtimeIntent, "NONE">, QueryRoute> = {
  CALCULATION: "CALCULATION",
  CURRENT_DATE: "REALTIME_DATE",
  DATE_QUERY: "REALTIME_DATE",
  CURRENT_TIME: "REALTIME_TIME",
  WEATHER_CURRENT: "REALTIME_WEATHER",
  WEATHER_FORECAST: "REALTIME_WEATHER",
  CURRENCY_CONVERSION: "REALTIME_CURRENCY",
  EXCHANGE_RATE: "REALTIME_CURRENCY",
};

function routeForRealtime(intent: RealtimeIntent): QueryRoute | null {
  return intent === "NONE" ? null : (REALTIME_ROUTE_BY_INTENT[intent] ?? null);
}

/**
 * Real-time probe that ignores the 6A document-priority guard.
 *
 * `detectRealtimeIntent` stands down for ANY explicit document reference — by
 * design, a HYBRID turn must still discover whether a strong, groundable
 * real-time signal hides behind that reference so both branches can run. The
 * probe mirrors `detectRealtimeIntent`'s precedence exactly
 * (CALCULATION > CURRENCY > WEATHER > DATE/TIME) without the document guard.
 *
 * It is informative for routing only; actual tool execution always goes
 * through `detectRealtimeIntent` / `executeRealtimeTool`.
 */
function probeRealtimeIntent(message: string): RealtimeDecision {
  const unguarded = detectRealtimeIntent({ message });
  if (unguarded.handled) return unguarded;

  const expression = extractCalculation(message);
  if (expression !== null) {
    return {
      intent: "CALCULATION",
      handled: true,
      reason: "Pure arithmetic expression (doc-agnostic probe)",
      params: { expression },
    };
  }

  const currency = detectCurrency(message);
  if (currency) {
    return {
      intent: currency.intent,
      handled: true,
      reason: "Currency query (doc-agnostic probe)",
      params: currency.params,
    };
  }

  const weather = detectWeather(message);
  if (weather) {
    return {
      intent: weather.intent,
      handled: true,
      reason: "Weather query (doc-agnostic probe)",
      params: weather.params,
    };
  }

  const dateTime = detectDateTime(message);
  if (dateTime) {
    return {
      intent: dateTime.intent,
      handled: true,
      reason: "Current date / current time / date-math query (doc-agnostic probe)",
      params: dateTime.params,
    };
  }

  return { intent: "NONE", handled: false, reason: "No real-time intent detected" };
}

function labelFor(confidence: number): ConfidenceLabel {
  if (confidence >= 0.9) return "high";
  if (confidence >= 0.7) return "medium";
  return "low";
}

// A doc-attached weather COMPARISON ("Compare today's Delhi weather with my
// PDF.") is a HYBRID signal even though 6A's weather probe needs a
// preposition-tail location ("Delhi weather" has none — the 6B extractor's
// city-adjacency rule finds it). Comparison wording + a weather noun + a
// credible location make the hybrid explicit; plain "what does my PDF say
// about X weather?" stays DOCUMENT_RAG because it has no comparison word.
const WEATHER_COMPARE_WORD = /\b(?:compare|comparing|comparison|versus|vs\.?\b|differen[ct])\b/i;
const WEATHER_NOUN_HINT = /\b(?:weather|forecast|conditions?)\b/i;

function extractWeatherComparisonLocation(message: string): string | null {
  if (!WEATHER_COMPARE_WORD.test(message)) return null;
  if (!WEATHER_NOUN_HINT.test(message)) return null;
  return extractQueryLocation(message);
}

// ---------------------------------------------------------------------------
// Follow-up context resolution
// ---------------------------------------------------------------------------

const BARE_TEMPORAL_TOKENS = /\b(?:what\s+about|how\s+about|and|what|the|day|after|before|tomorrow|tonight|today|this|next|weekend|week|on|for|in|it|is|then)\b/gi;
const BARE_TEMPORAL_ANCHOR = /\b(?:tomorrow|tonight|today|weekend|this\s+week|next\s+week|day\s+after\s+tomorrow)\b/i;
const PLACE_TAIL_RE = /\b(?:in|for|at)\s+([A-Za-z\u00C0-\u017F][A-Za-z\u00C0-\u017F .'’-]{1,39})\s*\??$/i;

function isBareTemporalFollowUp(message: string): boolean {
  const text = message.replace(/[?!.]/g, " ").toLowerCase().trim();
  const stripped = text.replace(BARE_TEMPORAL_TOKENS, " ").replace(/\s+/g, " ").trim();
  return stripped === "" && BARE_TEMPORAL_ANCHOR.test(text);
}

function extractPlaceTail(message: string): string | null {
  const m = message.replace(/[?!.]*$/, "").match(PLACE_TAIL_RE);
  if (!m) return null;
  const place = m[1].trim();
  if (!place || BARE_TEMPORAL_ANCHOR.test(place)) return null;
  return place;
}

const DOC_FOLLOW_UP_RE =
  /^(?:explain|elaborate|go\s+on|continue|tell\s+me\s+more|more\s+detail|what\s+about|give\s+(?:me\s+)?an?\s+example|expand)\b/i;
const DEICTIC_RE = /^(?:what\s+about|how\s+about|and|and\s+then|then)\s+(?:that|it|this|him|her|them|here|there)\s*\??$/i;

interface ResolvedFollowUp {
  realtimeDecision: RealtimeDecision | null;
  route: QueryRoute | null;
  confidence: number;
  reason: string;
}

function lastUserPriorTurn(input: QueryRoutingInput): string | null {
  const prior = input.priorTurns ?? [];
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    if (prior[i].role === "user") return prior[i].content;
  }
  return null;
}

/**
 * Resolves bare follow-ups ("what about tomorrow?", "and in Delhi?",
 * "and in rupees?", "explain that more") against the previous turn.
 * Only ever relies on concrete anchors from the previous turn; when no anchor
 * resolves, it returns null and the caller falls through to normal routing
 * (preserving the pre-6B behaviour for context-less turns).
 */
function resolveFollowUp(input: QueryRoutingInput): ResolvedFollowUp | null {
  const priorUser = lastUserPriorTurn(input);
  if (!priorUser) return null;
  const message = input.message.trim();

  const priorRt = detectRealtimeIntent({ message: priorUser });
  const docFollowUp =
    !priorRt.handled &&
    (referencesDocument(priorUser) ||
      analyzeQuery(priorUser).entities.structuralPath.length > 0) &&
    DOC_FOLLOW_UP_RE.test(message) &&
    message.split(/\s+/).length <= 10;

  if (docFollowUp) {
    if (input.hasSources) {
      return {
        realtimeDecision: null,
        route: "DOCUMENT_RAG",
        confidence: 0.9,
        reason: "Follow-up references the previous document-answered turn.",
      };
    }
    return {
      realtimeDecision: null,
      route: "GENERAL",
      confidence: 0.9,
      reason: "Follow-up to a previous document turn — nothing attached to retrieve from.",
    };
  }

  if (!priorRt.handled) return null;

  const place = extractPlaceTail(message);
  const isBareTemporal = isBareTemporalFollowUp(message);

  switch (priorRt.intent) {
    case "WEATHER_CURRENT":
    case "WEATHER_FORECAST": {
      const priorLocation = priorRt.params?.location;
      if (place) {
        // "and in Delhi?" — a new city, same weather intent.
        const d = detectRealtimeIntent({ message: `what is the weather in ${place}` });
        if (d.handled) {
          return {
            realtimeDecision: d,
            route: routeForRealtime(d.intent),
            confidence: 0.75,
            reason: `Weather follow-up with new location "${place}".`,
          };
        }
        return null;
      }
      if (isBareTemporal && priorLocation) {
        const d = detectRealtimeIntent({
          message: `what is the weather ${message} in ${priorLocation}`,
        });
        if (d.handled) {
          return {
            realtimeDecision: d,
            route: routeForRealtime(d.intent),
            confidence: 0.9,
            reason: `Weather follow-up anchored to previous location "${priorLocation}".`,
          };
        }
      }
      return null;
    }

    case "CURRENT_TIME": {
      if (place) {
        const d = detectRealtimeIntent({ message: `what time is it in ${place}` });
        if (d.handled) {
          return {
            realtimeDecision: d,
            route: routeForRealtime(d.intent),
            confidence: 0.75,
            reason: `Time follow-up with new location "${place}".`,
          };
        }
      }
      return null;
    }

    case "CURRENCY_CONVERSION":
    case "EXCHANGE_RATE": {
      const from = priorRt.params?.from;
      if (!from) return null;
      // English currency names → ISO codes ("euros" → EUR) plus any bare
      // 3-letter codes in the message. Scanning only 3-letter tokens would
      // wrongly pick words like "and"/"the", so every candidate is validated
      // through detectRealtimeIntent and must yield a real from/to pair.
      const NAMES_TO_CODE: Record<string, string> = {
        dollars: "USD", dollar: "USD", usd: "USD",
        euros: "EUR", euro: "EUR", eur: "EUR",
        pounds: "GBP", pound: "GBP", gbp: "GBP",
        yen: "JPY", jpy: "JPY",
        rupees: "INR", rupee: "INR", inr: "INR",
        yuan: "CNY", cny: "CNY",
      };
      const candidates: string[] = [];
      for (const [name, code] of Object.entries(NAMES_TO_CODE)) {
        if (name.length > 3 && new RegExp(`\\b${name}\\b`, "i").test(message) && !candidates.includes(code)) {
          candidates.push(code);
        }
      }
      for (const m of message.matchAll(/\b([a-z]{3})\b/gi)) {
        const code = m[1].toUpperCase();
        if (code !== from && !candidates.includes(code)) candidates.push(code);
      }
      for (const code of candidates) {
        if (code === from) continue;
        const d = detectRealtimeIntent({ message: `convert 1 ${from} to ${code}` });
        if (d.handled && d.params?.from === from && d.params?.to === code) {
          return {
            realtimeDecision: d,
            route: routeForRealtime(d.intent),
            confidence: 0.75,
            reason: `Currency follow-up to "${code}".`,
          };
        }
      }
      return null;
    }

    case "DATE_QUERY":
    case "CURRENT_DATE": {
      if (isBareTemporal) {
        const d = detectRealtimeIntent({ message });
        if (d.handled && d.intent === "DATE_QUERY") {
          return {
            realtimeDecision: d,
            route: routeForRealtime(d.intent),
            confidence: 0.9,
            reason: "Temporal follow-up continuing the previous date intent.",
          };
        }
      }
      return null;
    }

    default:
      return null;
  }
}

function isAmbiguousDeictic(message: string, input: QueryRoutingInput): boolean {
  return Boolean(
    (input.priorTurns?.length ?? 0) > 0 &&
      DEICTIC_RE.test(message.trim()) &&
      !resolveFollowUp(input)
  );
}

// ---------------------------------------------------------------------------
// Bounded execution plan
// ---------------------------------------------------------------------------

function buildPlan(d: {
  primaryRoute: QueryRoute;
  requiresRealtime: boolean;
  requiresDocuments: boolean;
  requiresVisualEvidence: boolean;
}): ExecutionPlan {
  const steps: ExecutionStep[] = [];
  let index = 0;

  const isHybrid = d.primaryRoute === "HYBRID";
  const isImage =
    d.primaryRoute === "IMAGE_GENERATION" ||
    d.primaryRoute === "IMAGE_EDIT" ||
    d.primaryRoute === "DOCUMENT_VISUAL_GENERATION";

  if (d.requiresRealtime) {
    steps.push({ id: `step-${index}`, kind: "realtime", dependsOn: [], maxCalls: 1 });
    index += 1;
  }
  if (d.requiresDocuments || d.requiresVisualEvidence) {
    steps.push({
      id: `step-${index}`,
      kind: d.requiresVisualEvidence ? "visual" : "rag",
      dependsOn: [],
      maxCalls: d.requiresVisualEvidence ? 2 : 3,
    });
    index += 1;
  }
  if (isImage) {
    // Every image request = ONE image call (the service may internally try
    // providers in server-controlled order, counted inside its own budget).
    steps.push({
      id: `step-${index}`,
      kind: "image",
      dependsOn: steps.map((s) => s.id),
      maxCalls: 1,
    });
    index += 1;
  }

  // The Gemini step fuses the evidence (hybrid) or explains (single routes).
  steps.push({
    id: `step-${index}`,
    kind: "gemini",
    dependsOn: isHybrid ? steps.map((s) => s.id) : [],
    maxCalls: 1,
  });

  const realtimeSteps = steps.filter((s) => s.kind === "realtime").length;
  const retrievalSteps = steps.filter((s) => s.kind === "rag" || s.kind === "visual").length;
  // Every plan ends in one Gemini step; the bound covers total external calls
  // (geocode/rate/DB retrieval + the LLM call) and stays well under the cap.
  // Image turns: retrieval (+ ≤2 provider calls inside the service) + image call.
  const imageBudgetCap = isImage ? Math.min(realtimeSteps + retrievalSteps + 2, 4) : 0;
  const totalExternal = isImage
    ? imageBudgetCap
    : Math.min(realtimeSteps + retrievalSteps + 1, 4);

  return {
    steps,
    maxExternalCalls: totalExternal,
    maxDepth: 1 as const,
    parallelizable: isHybrid && realtimeSteps > 0 && retrievalSteps > 0,
  };
}

// ---------------------------------------------------------------------------
// Decision factory
// ---------------------------------------------------------------------------

interface DecisionParts {
  primaryRoute: QueryRoute;
  routes: QueryRoute[];
  confidence: number;
  requiresDocuments: boolean;
  requiresRealtime: boolean;
  requiresVisualEvidence: boolean;
  requiresGeneralReasoning: boolean;
  requiresClarification: boolean;
  reason: string;
  realtimeDecision?: RealtimeDecision;
  domainDecision?: DomainDecision;
  visualIntent?: VisualQueryIntent;
  /** Phase 6C: the detected text→image request (or refinement). */
  imageIntent?: ImageGenerationIntent;
  /** Phase 6D: the detected reference-image edit/regeneration request. */
  imageEditIntent?: ImageEditIntent;
  /** Phase 6E: the detected document→visual generation request. */
  documentVisualIntent?: DocumentVisualIntent;
  /** Phase 6G: the detected task-management command (create/list/complete…). */
  taskIntent?: TaskIntentResult;
  /** Phase 6G: the detected plan intent (create/list). */
  planIntent?: PlanIntentResult;
  queryAnalysis?: QueryAnalysis;
  multiSourceIntent?: MultiSourceIntent;
}

function makeDecision(parts: DecisionParts): QueryRouteDecision {
  const plan = buildPlan(parts);
  const decision: QueryRouteDecision = {
    primaryRoute: parts.primaryRoute,
    routes: [...new Set(parts.routes)],
    confidence: parts.confidence,
    confidenceLabel: labelFor(parts.confidence),
    requiresDocuments: parts.requiresDocuments,
    requiresRealtime: parts.requiresRealtime,
    requiresVisualEvidence: parts.requiresVisualEvidence,
    requiresGeneralReasoning: parts.requiresGeneralReasoning,
    requiresClarification: parts.requiresClarification,
    reason: parts.reason,
    executionPlan: plan,
  };
  if (parts.realtimeDecision) decision.realtimeDecision = parts.realtimeDecision;
  if (parts.domainDecision) decision.domainDecision = parts.domainDecision;
  if (parts.visualIntent) decision.visualIntent = parts.visualIntent;
  if (parts.imageIntent) decision.imageIntent = parts.imageIntent;
  if (parts.imageEditIntent) decision.imageEditIntent = parts.imageEditIntent;
  if (parts.documentVisualIntent) {
    decision.documentVisualIntent = parts.documentVisualIntent;
  }
  if (parts.queryAnalysis) decision.queryAnalysis = parts.queryAnalysis;
  if (parts.multiSourceIntent) decision.multiSourceIntent = parts.multiSourceIntent;
  if (parts.taskIntent) decision.taskIntent = parts.taskIntent;
  if (parts.planIntent) decision.planIntent = parts.planIntent;
  return decision;
}

// ---------------------------------------------------------------------------
// Central router
// ---------------------------------------------------------------------------

/**
 * Decides the route(s) for the current chat turn. Pure and deterministic —
 * no LLM calls, no network I/O — so it is exhaustively unit-testable.
 */
export function routeQuery(input: QueryRoutingInput): QueryRouteDecision {
  const { message, hasSources, sourceCount = 0, mode } = input;
  const analysis = analyzeQuery(message);
  const visual = detectVisualIntent(message);
  const rt = detectRealtimeIntent({ message, hasSources });
  const docReferenced = referencesDocument(message);

  // Phase 6C: text→image intent. Direct generation verbs first, then a
  // refinement of the PREVIOUS image turn ("draw a castle" → "make it at
  // night"). Pure and deterministic — never an LLM call.
  const imageIntent = resolveImageGenerationIntent(message, lastUserPriorTurn(input));

  // Phase 6D: reference-image EDIT intent, evaluated against the conversation
  // image metadata the client attached (or an uploaded image). Requires an
  // actual image reference; otherwise it is a clarification, never a call.
  const imageEdit = detectImageEditIntent(message, input.images ?? []);

  // Phase 6E: document→visual intent. Requires an explicit document reference
  // AND a visual-generation signal — memory can never substitute for an
  // attached document. Direct asks first, then a presentation refinement of
  // the previous document-visual turn. Pure and deterministic.
  const documentVisual = resolveDocumentVisualIntent(message, lastUserPriorTurn(input));

  // 6A's document-priority guard stands real-time down for ANY document
  // reference. For HYBRID routing we re-probe without the guard so a strong,
  // groundable real-time signal behind a doc reference can still be fused —
  // but only when sources are attached (branch 2/3 below). Without sources the
  // guard's stand-down is preserved: the doc branch cannot run, so nothing
  // overrides the document pipeline.
  const rtProbe = docReferenced ? probeRealtimeIntent(message) : rt;

  const sources =
    hasSources && sourceCount > 0
      ? Array.from({ length: sourceCount }, (_, i) => ({
          id: `src-${i}`,
          type: "document" as const,
          name: `document-${i + 1}`,
        }))
      : [];
  const multiSourceIntent =
    hasSources && sourceCount > 1 ? classifySourceIntent(message, sources).strategy : undefined;

  const structural = analysis.entities.structuralPath.length > 0;
  const questionNumber = analysis.entities.questionNumber != null;
  const realtimeRoute = routeForRealtime(rt.intent);
  const probeRoute = routeForRealtime(rtProbe.intent);
  const rtStrong = isStrongRealtime(rt);
  const probeStrong = isStrongRealtime(rtProbe);
  const probeWeatherStrong =
    probeStrong &&
    ((rtProbe.intent !== "WEATHER_CURRENT" && rtProbe.intent !== "WEATHER_FORECAST") ||
      isCredibleWeatherLocation(rtProbe.params));
  const definition = rt.handled && isRealtimeConceptDefinition(message);

  // Phase 6B Extended — domain advisory probe (sub-route of real-time).
  // Pure rule-based detection (detectDomainIntent) resolved against prior
  // turns (resolveDomainContext). It is a router SIGNAL only; the chat route
  // executes the domain tool. Document priority is preserved below: a
  // document reference without attached sources stands domain down (HYBRID
  // needs sources to ground the document branch).
  const initialDomain = detectDomainIntent(message);
  const domainProbe =
    initialDomain.handled && !docReferenced
      ? resolveDomainContext(initialDomain, input.priorTurns)
      : initialDomain.handled && docReferenced && hasSources
        ? resolveDomainContext(initialDomain, input.priorTurns)
        : undefined;

  // Doc-attached weather COMPARISON probe (see extractWeatherComparisonLocation).
  const weatherComparisonLocation =
    docReferenced && hasSources ? extractWeatherComparisonLocation(message) : null;

  // -- 1. Semantic definition guard -----------------------------------------
  if (definition) {
    return makeDecision({
      primaryRoute: "GENERAL",
      routes: ["GENERAL"],
      confidence: 0.95,
      requiresDocuments: false,
      requiresRealtime: false,
      requiresVisualEvidence: false,
      requiresGeneralReasoning: true,
      requiresClarification: false,
      reason: `Definition question about a real-time concept — routed to general knowledge (${rt.reason}).`,
      queryAnalysis: analysis,
    });
  }

  // -- 2. STRONG real-time + explicit document reference (with sources) -----
  if (docReferenced && hasSources && (rtProbe.handled && probeWeatherStrong || domainProbe?.handled || weatherComparisonLocation)) {
    // A comparison turn synthesizes a weather decision so the real-time branch
    // of the HYBRID runs (executeRealtimeTool geocodes the extracted place).
    const comparisonRt: RealtimeDecision | null =
      weatherComparisonLocation
        ? {
            intent: "WEATHER_CURRENT",
            handled: true,
            reason: "Weather comparison against the attached document (6B hybrid probe)",
            params: { location: weatherComparisonLocation, weatherKind: "current" },
          }
        : null;
    const effectiveRt = domainProbe?.handled ? null : rtProbe.handled && probeWeatherStrong ? rtProbe : comparisonRt;
    const routes: QueryRoute[] = ["DOCUMENT_RAG"];
    if (visual.type !== "none") routes.push(visual.hasTextualAnalysis ? "MULTIMODAL" : "VISUAL");
    if (domainProbe?.handled) {
      routes.push("DOMAIN_REALTIME");
    } else if (effectiveRt) {
      routes.push(routeForRealtime(effectiveRt.intent)!);
    }
    return makeDecision({
      primaryRoute: "HYBRID",
      routes,
      confidence: 0.9,
      requiresDocuments: true,
      requiresRealtime: true,
      requiresVisualEvidence: visual.type !== "none",
      requiresGeneralReasoning: true,
      requiresClarification: false,
      reason:
        `Hybrid turn: explicit document reference + ${
          domainProbe?.handled
            ? `domain advisory (${domainProbe.domain})`
            : effectiveRt
              ? `strong real-time intent (${effectiveRt.intent})`
              : "no groundable real-time signal"
        } with sources attached. Document retrieval runs in parallel and Gemini fuses the evidence.`,
      realtimeDecision: domainProbe?.handled ? undefined : effectiveRt ?? undefined,
      domainDecision: domainProbe?.handled ? domainProbe : undefined,
      visualIntent: visual.type !== "none" ? visual : undefined,
      queryAnalysis: analysis,
      multiSourceIntent,
    });
  }

  // -- 3. STRONG real-time + visual reference (with sources) ----------------
  if (rtProbe.handled && probeWeatherStrong && visual.type !== "none" && hasSources) {
    const visualRoute = visual.hasTextualAnalysis ? "MULTIMODAL" : "VISUAL";
    return makeDecision({
      primaryRoute: "HYBRID",
      routes: [visualRoute, probeRoute!],
      confidence: 0.88,
      requiresDocuments: false,
      requiresRealtime: true,
      requiresVisualEvidence: true,
      requiresGeneralReasoning: true,
      requiresClarification: false,
      reason: `Hybrid turn: visual reference + strong real-time intent (${rtProbe.intent}).`,
      realtimeDecision: rtProbe,
      visualIntent: visual,
      queryAnalysis: analysis,
      multiSourceIntent,
    });
  }

  // -- 4. Image EDITING (Phase 6D) --------------------------------------
  // An explicit edit of a conversation image (metadata the client sent) or an
  // uploaded image, evaluated against image EDIT intent detection. Ranks ABOVE
  // image generation so "make the sky sunset" right after a generated mountain
  // genuinely edits that image's bytes instead of drawing from text. Key rules:
  //   - requires explicit edit/regenerate phrasing against an actual image.
  //   - a request that cannot resolve a source (no image, multiple images,
  //     ordinal beyond count) routes here as a CLARIFICATION — the chat route
  //     answers with a SAFE_EDIT_* copy and NEVER calls an image provider.
  //   - RAG grounding mirrors IMAGE_GENERATION (sources ⇒ document branch;
  //     without sources a doc-referenced edit is refused by the service).
  //   - visual UNDERSTANDING turns and fresh generation ("draw a castle")
  //     never fire this intent.
  if (imageEdit.detected) {
    if (imageEdit.requiresClarification || !imageEdit.selectionKey) {
      return makeDecision({
        primaryRoute: "IMAGE_EDIT",
        routes: ["IMAGE_EDIT"],
        confidence: 0.8,
        requiresDocuments: false,
        requiresRealtime: false,
        requiresVisualEvidence: false,
        requiresGeneralReasoning: false,
        requiresClarification: true,
        reason: `Image edit requested but the source is unresolvable (${imageEdit.reason}).`,
        imageEditIntent: imageEdit,
        queryAnalysis: analysis,
      });
    }
    const grounded = hasSources && (docReferenced || grantsGrounding(message));
    const docRefWithoutSource = docReferenced && !hasSources;
    if (docRefWithoutSource) {
      return makeDecision({
        primaryRoute: "IMAGE_EDIT",
        routes: ["IMAGE_EDIT"],
        confidence: Math.min(imageEdit.confidence + 0.05, 0.97),
        requiresDocuments: true,
        requiresRealtime: false,
        requiresVisualEvidence: false,
        requiresGeneralReasoning: false,
        requiresClarification: false,
        reason:
          `Image edit references a document but none is attached — grounded ` +
          `editing has nothing to draw on (${imageEdit.reason}).`,
        imageEditIntent: imageEdit,
        queryAnalysis: analysis,
      });
    }
    if (grounded) {
      return makeDecision({
        primaryRoute: "IMAGE_EDIT",
        routes: ["IMAGE_EDIT", "DOCUMENT_RAG"],
        confidence: Math.min(imageEdit.confidence + 0.05, 0.97),
        requiresDocuments: true,
        requiresRealtime: false,
        requiresVisualEvidence: false,
        requiresGeneralReasoning: false,
        requiresClarification: false,
        reason: `Doc-grounded image edit request (${imageEdit.reason}).`,
        imageEditIntent: imageEdit,
        queryAnalysis: analysis,
      });
    }
    return makeDecision({
      primaryRoute: "IMAGE_EDIT",
      routes: ["IMAGE_EDIT"],
      confidence: imageEdit.confidence,
      requiresDocuments: false,
      requiresRealtime: false,
      requiresVisualEvidence: false,
      requiresGeneralReasoning: false,
      requiresClarification: false,
      reason: `Reference-image edit request (${imageEdit.reason}).`,
      imageEditIntent: imageEdit,
      queryAnalysis: analysis,
    });
  }

  // -- 4b. Document → Visual generation (Phase 6E) --------------------------
  // A document-grounded visual ask ("Create an infographic from my PDF")
  // wins over plain text→image generation (branch 4c) but NEVER over image
  // editing (branch 4) — "edit the diagram from my PDF" stays an edit — and
  // never over strong real-time hybrids (branches 2/3). Grounding is THE gate:
  //   - sources attached → DOCUMENT_VISUAL_GENERATION + DOCUMENT_RAG (the
  //     chat route retrieves evidence BEFORE generating), and
  //   - no sources → still marked requiresDocuments so the route refuses with
  //     the safe no-document copy — memory can never substitute for an
  //     attached document.
  // Visual UNDERSTANDING turns and pure generation without a document
  // reference ("diagram of photosynthesis") never fire this intent.
  if (documentVisual.detected) {
    if (!hasSources) {
      return makeDecision({
        primaryRoute: "DOCUMENT_VISUAL_GENERATION",
        routes: ["DOCUMENT_VISUAL_GENERATION"],
        confidence: Math.min(documentVisual.confidence + 0.05, 0.97),
        requiresDocuments: true,
        requiresRealtime: false,
        requiresVisualEvidence: false,
        requiresGeneralReasoning: false,
        requiresClarification: false,
        reason:
          `Document visual requested but no source is attached — grounded ` +
          `generation has nothing to draw on (${documentVisual.reason}).`,
        documentVisualIntent: documentVisual,
        queryAnalysis: analysis,
      });
    }
    return makeDecision({
      primaryRoute: "DOCUMENT_VISUAL_GENERATION",
      routes: ["DOCUMENT_VISUAL_GENERATION", "DOCUMENT_RAG"],
      confidence: Math.min(documentVisual.confidence + 0.05, 0.97),
      requiresDocuments: true,
      requiresRealtime: false,
      requiresVisualEvidence: false,
      requiresGeneralReasoning: false,
      requiresClarification: false,
      reason: `Document-grounded visual generation request (${documentVisual.reason}).`,
      documentVisualIntent: documentVisual,
      queryAnalysis: analysis,
    });
  }

  // -- 4c. Image generation (Phase 6C) --------------------------------------
  // A text→image request — pure ("draw a castle"), a refinement of the
  // previous image ("make it at night"), or doc-grounded ("diagram from my
  // PDF", a diagram/chart noun with sources attached) — routes here. Strong
  // groundable turns above (definition, HYBRID real-time+doc, HYBRID
  // real-time+visual) always win, and visual UNDERSTANDING turns never fire
  // this intent. The chat route runs the image service (Gemini primary, HF
  // fallback); RAG-grounded turns MUST produce retrieval evidence or the
  // service refuses to fabricate an image.
  if (imageIntent.detected) {
    const grounded = hasSources && (docReferenced || grantsGrounding(message));
    const docRefWithoutSource = docReferenced && !hasSources;
    if (docRefWithoutSource) {
      return makeDecision({
        primaryRoute: "IMAGE_GENERATION",
        routes: ["IMAGE_GENERATION"],
        confidence: Math.min(imageIntent.confidence + 0.05, 0.97),
        requiresDocuments: true,
        requiresRealtime: false,
        requiresVisualEvidence: false,
        requiresGeneralReasoning: false,
        requiresClarification: false,
        reason:
          `Image request references a document but none is attached — grounded ` +
          `generation has nothing to draw on (${imageIntent.reason}).`,
        imageIntent,
        queryAnalysis: analysis,
      });
    }
    if (grounded) {
      return makeDecision({
        primaryRoute: "IMAGE_GENERATION",
        routes: ["IMAGE_GENERATION", "DOCUMENT_RAG"],
        confidence: Math.min(imageIntent.confidence + 0.05, 0.97),
        requiresDocuments: true,
        requiresRealtime: false,
        requiresVisualEvidence: false,
        requiresGeneralReasoning: false,
        requiresClarification: false,
        reason: `Doc-grounded image request (${imageIntent.reason}).`,
        imageIntent,
        queryAnalysis: analysis,
      });
    }
    return makeDecision({
      primaryRoute: "IMAGE_GENERATION",
      routes: ["IMAGE_GENERATION"],
      confidence: imageIntent.confidence,
      requiresDocuments: false,
      requiresRealtime: false,
      requiresVisualEvidence: false,
      requiresGeneralReasoning: false,
      requiresClarification: false,
      reason: `Pure image generation request (${imageIntent.reason}).`,
      imageIntent,
      queryAnalysis: analysis,
    });
  }

  // -- 5. Document reference guard -----------------------------------------
  if (docReferenced) {
    if (!hasSources) {
      return makeDecision({
        primaryRoute: "GENERAL",
        routes: ["GENERAL"],
        confidence: 0.9,
        requiresDocuments: false,
        requiresRealtime: false,
        requiresVisualEvidence: false,
        requiresGeneralReasoning: true,
        requiresClarification: false,
        reason:
          docReferenced && rtProbe.handled
            ? "Message references a document with a real-time signal behind it but no sources " +
              "are attached — the 6A guard stands down and Gemini answers generally."
            : "Message references a document but none is attached — general answer.",
        queryAnalysis: analysis,
      });
    }
    const visualRoute = visual.type === "none" ? null : (visual.hasTextualAnalysis ? "MULTIMODAL" : "VISUAL");
    return makeDecision({
      primaryRoute: visualRoute ?? "DOCUMENT_RAG",
      routes: visualRoute ? [visualRoute, "DOCUMENT_RAG"] : ["DOCUMENT_RAG"],
      confidence: structural || questionNumber ? 0.97 : 0.92,
      requiresDocuments: true,
      requiresRealtime: false,
      requiresVisualEvidence: visual.type !== "none",
      requiresGeneralReasoning: true,
      requiresClarification: false,
      reason:
        `Document reference wins over real-time: ${
          rtProbe.handled ? `${rtProbe.intent} stands down (guard)` : "no real-time intent"
        }.`,
      visualIntent: visual.type !== "none" ? visual : undefined,
      queryAnalysis: analysis,
      multiSourceIntent,
    });
  }

  // -- 6. Follow-up context resolution (before single real-time) -----------
  // A bare temporal continuation ("what about tomorrow?") is itself detected
  // as a real-time DATE_QUERY by 6A, so follow-up resolution MUST run first —
  // otherwise the prior weather/location anchor is never consulted. Full,
  // self-contained real-time intents (located weather, currency pairs,
  // current date/time wording) are NOT bare follow-ups and fall straight
  // through to the direct single real-time branch below (6A behaviour saved).
  const followUpEligible =
    !rt.handled || (rt.intent === "DATE_QUERY" && isBareTemporalFollowUp(message));
  if (followUpEligible) {
    const followUp = resolveFollowUp(input);
    if (followUp?.route) {
      const followUpRt = followUp.realtimeDecision;
      return makeDecision({
        primaryRoute: followUp.route,
        routes: [followUp.route],
        confidence: followUp.confidence,
        requiresDocuments: followUp.route === "DOCUMENT_RAG",
        requiresRealtime: followUp.route !== "DOCUMENT_RAG" && followUp.route !== "GENERAL",
        requiresVisualEvidence: false,
        requiresGeneralReasoning: followUp.route === "DOCUMENT_RAG" || followUp.route === "GENERAL",
        requiresClarification: false,
        reason: followUp.reason,
        realtimeDecision: followUpRt ?? undefined,
        queryAnalysis: analysis,
      });
    }
  }

  // -- 6b. Task + Planning management (Phase 6G) --------------------------
  // A deterministic task/planning command layer (BOOTSTRAP verbs + explicit
  // task/reminder/plan nouns — see src/lib/tasks/intent.ts). It sits BELOW the
  // document guard (branch 5) and image/visual routes (branches 4–4c), so
  // "generate an image of my study plan" and "according to my PDF, create a
  // study plan" keep their original routes; and BELOW follow-up resolution
  // (branch 6) so "what about tomorrow?" still inherits the prior turn. It
  // sits ABOVE the domain and single real-time branches because "remind me to
  // water the plants at 9pm" is a task record, not a DATE_QUERY. Ordinary
  // statements — "I have an exam tomorrow", "I should study more" — carry no
  // bootstrap verb + noun and fall straight through to GENERIC chat.
  //   TASK_MANAGEMENT   → create/update/complete/cancel/delete/reschedule
  //   TASK_QUERY        → "show my tasks / what's due?"
  //   PLAN_GENERATION   → "create a study plan for …" or "plan my week"
  const taskCommand = detectTaskCommand(message);
  const planCommand = detectPlanCommand(message);
  if (taskCommand.intent !== "TASK_NONE" || planCommand.intent !== "PLAN_NONE") {
    const isPlan = planCommand.intent === "PLAN_CREATE";
    const primaryRoute: QueryRoute = isPlan
      ? "PLAN_GENERATION"
      : taskCommand.intent === "TASK_LIST"
        ? "TASK_QUERY"
        : "TASK_MANAGEMENT";
    return makeDecision({
      primaryRoute,
      routes: [primaryRoute],
      confidence: 0.92,
      requiresDocuments: false,
      requiresRealtime: false,
      requiresVisualEvidence: false,
      requiresGeneralReasoning: false,
      requiresClarification: false,
      reason: isPlan
        ? `Plan request: ${planCommand.reason}`
        : `Task command: ${taskCommand.reason}`,
      taskIntent: taskCommand.intent !== "TASK_NONE" ? taskCommand : undefined,
      planIntent: planCommand.intent !== "PLAN_NONE" ? planCommand : undefined,
      queryAnalysis: analysis,
    });
  }

  // -- 7. Domain advisory (Phase 6B Extended) -----------------------------
  // A sub-route of real-time: a domain-specific question (agriculture/
  // marine/aviation/smart-city/travel/outdoor) produces a deterministic live
  // advisory. It sits ABOVE the single real-time branch so "Is heavy rainfall
  // expected tonight?" routes SMART_CITY rather than generic weather, and
  // bare "what about <domain>" follow-ups (which 6A does not detect) resolve
  // here with context inheritance. Document references never reach this
  // branch (guards 2/4 above); the user is asked for a location when none
  // can be resolved.
  if (domainProbe?.handled) {
    return makeDecision({
      primaryRoute: "DOMAIN_REALTIME",
      routes: ["DOMAIN_REALTIME"],
      confidence: domainProbe.confidence,
      requiresDocuments: false,
      requiresRealtime: true,
      requiresVisualEvidence: false,
      requiresGeneralReasoning: false,
      requiresClarification: false,
      reason: `Domain advisory ${domainProbe.domain} (${domainProbe.reason}).`,
      domainDecision: domainProbe,
      queryAnalysis: analysis,
    });
  }

  // -- 8. Single real-time intent ------------------------------------------
  if (rt.handled) {
    const isWeather = rt.intent === "WEATHER_CURRENT" || rt.intent === "WEATHER_FORECAST";
    if (!(isWeather && !isCredibleWeatherLocation(rt.params))) {
      const isLocationPrompt = rt.intent === "WEATHER_CURRENT" && !rt.params?.location;
      const confidence =
        rtStrong || realtimeRoute === "CALCULATION" ? 0.96
          : isLocationPrompt ? 0.8
          : 0.9;
      return makeDecision({
        primaryRoute: realtimeRoute!,
        routes: [realtimeRoute!],
        confidence,
        requiresDocuments: false,
        requiresRealtime: true,
        requiresVisualEvidence: false,
        requiresGeneralReasoning: false,
        requiresClarification: false,
        reason: `Single real-time intent ${rt.intent} (${rt.reason}).`,
        realtimeDecision: rt,
        queryAnalysis: analysis,
      });
    }
    // 6A read a whole sentence as a "city" ("Tell me a story about weather" →
    // location "Tell me a story about"). Never send prose to the geocoder;
    // fall through so the request is handled as ordinary chat instead.
  }

  // -- 9. Visual reference with sources ------------------------------------
  if (hasSources && visual.type !== "none") {
    const visualRoute = visual.hasTextualAnalysis ? "MULTIMODAL" : "VISUAL";
    return makeDecision({
      primaryRoute: visualRoute,
      routes: [visualRoute, "DOCUMENT_RAG"],
      confidence: 0.92,
      requiresDocuments: true,
      requiresRealtime: false,
      requiresVisualEvidence: true,
      requiresGeneralReasoning: true,
      requiresClarification: false,
      reason: `Visual reference (${visual.type}) over attached sources.`,
      visualIntent: visual,
      queryAnalysis: analysis,
      multiSourceIntent,
    });
  }

  // -- 10. Sources attached → document RAG ---------------------------------
  if (hasSources) {
    return makeDecision({
      primaryRoute: "DOCUMENT_RAG",
      routes: ["DOCUMENT_RAG"],
      confidence: structural || questionNumber ? 0.97 : 0.9,
      requiresDocuments: true,
      requiresRealtime: false,
      requiresVisualEvidence: false,
      requiresGeneralReasoning: true,
      requiresClarification: false,
      reason: `Attached ${sourceCount} source(s); RAG retrieval is active.`,
      queryAnalysis: analysis,
      multiSourceIntent,
    });
  }

  // -- 11. Ambiguous deictic with prior context → clarification (Gemini still answers) --
  if (isAmbiguousDeictic(message, input)) {
    return makeDecision({
      primaryRoute: "CLARIFICATION",
      routes: ["CLARIFICATION", "GENERAL"],
      confidence: 0.55,
      requiresDocuments: false,
      requiresRealtime: false,
      requiresVisualEvidence: false,
      requiresGeneralReasoning: true,
      requiresClarification: true,
      reason: "Bare deictic follow-up with no resolvable anchor — ask a concise clarification.",
      queryAnalysis: analysis,
    });
  }

  // -- Default → GENERAL ---------------------------------------------------
  return makeDecision({
    primaryRoute: "GENERAL",
    routes: ["GENERAL"],
    confidence: 0.95,
    requiresDocuments: false,
    requiresRealtime: false,
    requiresVisualEvidence: false,
    requiresGeneralReasoning: true,
    requiresClarification: false,
    reason: `No document/visual/real-time/prior anchor detected (mode=${mode ?? "general"}).`,
    queryAnalysis: analysis,
  });
}

// ---------------------------------------------------------------------------
// Debug helper (never exposed to the client)
// ---------------------------------------------------------------------------

/** Compact one-line description for server-side logs only. */
export function describeQueryRoute(d: QueryRouteDecision): string {
  return [
    `route=${d.primaryRoute}`,
    `routes=${d.routes.join("+")}`,
    `conf=${d.confidence.toFixed(2)}`,
    `rt=${d.requiresRealtime}`,
    `doc=${d.requiresDocuments}`,
    `vis=${d.requiresVisualEvidence}`,
    `img=${d.imageIntent ? "1" : "0"}`,
    `imgedit=${d.imageEditIntent ? "1" : "0"}`,
    `dv=${d.documentVisualIntent ? "1" : "0"}`,
    `task=${d.taskIntent ? d.taskIntent.intent : "0"}`,
    `plan=${d.planIntent ? d.planIntent.intent : "0"}`,
  ].join(" ");
}