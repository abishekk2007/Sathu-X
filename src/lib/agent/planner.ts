// ---------------------------------------------------------------------------
// Phase 8B — Agentic Planning
//
// 8A answers "what kind of task is this?"; 8B answers "what steps are required
// to complete this task?" as a structured, deterministic AgentPlan that a
// future 8C tool-calling layer can execute.
//
// THE PLANNER IS PURE. It never:
//   - executes tools, searches the web, queries RAG, calls Gemini/maps,
//     writes memory, accesses secrets, or mutates state
// It only consumes the Phase 8A AgentRouteResult and emits a plan. Every step
// is created in status PLANNED — 8B never pretends an action happened.
//
// Determinism: step IDs are stable (step-1..step-N), ordering is fixed, and
// complexity is a pure function of the route, request text, and 8A metadata.
// No timestamps, no random IDs, no model calls.
//
// Safety: execution types form a CLOSED set describing only existing
// capabilities. User text never becomes a tool identifier; no secrets or
// credentials ever enter a plan.
// ---------------------------------------------------------------------------

import type { AgentRoute, AgentRouteMetadata, AgentRouteResult } from "./controller";

/** The execution types 8C will later understand. Closed — existing only. */
export type PlanExecutionType =
  | "INTERNAL_REASONING"
  | "RESPONSE_SYNTHESIS"
  | "DOCUMENT_RETRIEVAL"
  | "WEB_RESEARCH"
  | "REALTIME_LOOKUP"
  | "MAP_LOOKUP"
  | "IMAGE_UNDERSTANDING"
  | "IMAGE_GENERATION"
  | "VOICE_PROCESSING"
  | "LOCATION_LOOKUP"
  | "TASK_MANAGEMENT"
  | "CLARIFICATION";

export const PLAN_EXECUTION_TYPES: readonly PlanExecutionType[] = [
  "INTERNAL_REASONING",
  "RESPONSE_SYNTHESIS",
  "DOCUMENT_RETRIEVAL",
  "WEB_RESEARCH",
  "REALTIME_LOOKUP",
  "MAP_LOOKUP",
  "IMAGE_UNDERSTANDING",
  "IMAGE_GENERATION",
  "VOICE_PROCESSING",
  "LOCATION_LOOKUP",
  "TASK_MANAGEMENT",
  "CLARIFICATION",
];

/** 8B creates plans only; a future 8C executor advances them. */
export type PlanStepStatus = "PLANNED";
export type PlanStatus = "PLANNED";

/** Deterministic complexity classification (see complexityOf). */
export type PlanComplexity = "SIMPLE" | "MODERATE" | "COMPLEX";

export interface AgentPlanStep {
  /** Stable, deterministic id (step-1, step-2, …) — never random. */
  id: string;
  order: number;
  description: string;
  purpose: string;
  /** Explicit dependency edges — the graph is never inferred from prose. */
  dependencyIds: string[];
  executionType: PlanExecutionType;
  /** Guidance for the future executor, not fabricated results. */
  expectedOutput: string;
  status: PlanStepStatus;
}

export interface AgentPlanMetadata {
  /** Why this complexity was chosen (server-only rationale). */
  complexitySignals: string[];
  /** True when the turn arrived with a shared coarse location. */
  usesSharedLocation: boolean;
  /** True when fresh image bytes rode along with the turn. */
  hasFreshImage: boolean;
}

export interface AgentPlan {
  version: 1;
  status: PlanStatus;
  /** The exact 8A route this plan serves (never re-classifies). */
  route: AgentRoute;
  complexity: PlanComplexity;
  goal: string;
  steps: AgentPlanStep[];
  metadata: AgentPlanMetadata;
}

/** Context the planner may read: the normalized latest user request. */
export interface AgentPlanInput {
  message: string;
}

/** Small-talk turns stay one-step — planning is proportional to complexity. */
const SMALL_TALK =
  /^(?:hi|hello|heyy?|hiya|yo|hey\s+there)\b|^(?:thanks|thank\s+you|ok|okay|bye|goodbye)\b|^good\s+(?:morning|afternoon|evening|night)\b/i;

const COMPARISON_SIGNAL = /\b(?:compare|comparison|versus|\bvs\b|difference\s+between|similarities|differences|agree|disagree|conflict|trade-offs?)\b/i;

const MULTI_PART_SIGNAL =
  /\b(?:and\s+also|then\s+(?:tell|show|explain|find|check|search|list)|additionally)\b/i;

function step(
  order: number,
  description: string,
  purpose: string,
  executionType: PlanExecutionType,
  expectedOutput: string,
  dependencyIds: string[] = []
): AgentPlanStep {
  return {
    id: `step-${order}`,
    order,
    description,
    purpose,
    dependencyIds,
    executionType,
    expectedOutput,
    status: "PLANNED",
  };
}

interface Template {
  goal: string;
  steps: AgentPlanStep[];
}

// ---------------------------------------------------------------------------
// Route templates — every step is PLANNED; nothing is ever executed.
// ---------------------------------------------------------------------------

function chatTemplate(message: string): Template {
  const text = message.trim();
  const isSmallTalk = SMALL_TALK.test(text) && text.split(/\s+/).length <= 6;
  if (isSmallTalk) {
    return {
      goal: "Respond conversationally to the user's message.",
      steps: [
        step(1, "Generate a normal conversational response.", "conversation", "INTERNAL_REASONING", "A natural, friendly reply."),
      ],
    };
  }
  if (COMPARISON_SIGNAL.test(text)) {
    return {
      goal: "Answer the comparison question clearly.",
      steps: [
        step(1, "Identify the concepts being compared.", "interpretation", "INTERNAL_REASONING", "The entities and dimensions to compare."),
        step(2, "Compare the concepts across relevant dimensions.", "comparison", "INTERNAL_REASONING", "A structured point-by-point comparison.", ["step-1"]),
        step(3, "Weigh the similarities and differences.", "analysis", "INTERNAL_REASONING", "Reasons the differences matter.", ["step-2"]),
        step(4, "Synthesize a balanced answer.", "synthesis", "RESPONSE_SYNTHESIS", "A clear, even-handed comparison response.", ["step-3"]),
      ],
    };
  }
  return {
    goal: "Answer the user's question clearly.",
    steps: [
      step(1, "Interpret the question.", "interpretation", "INTERNAL_REASONING", "The intent and scope of the question."),
      step(2, "Reason from available knowledge.", "reasoning", "INTERNAL_REASONING", "A coherent line of reasoning.", ["step-1"]),
      step(3, "Synthesize a clear answer.", "synthesis", "RESPONSE_SYNTHESIS", "A complete, readable reply.", ["step-2"]),
    ],
  };
}

function documentRagTemplate(): Template {
  return {
    goal: "Answer the question grounded in the attached document evidence.",
    steps: [
      step(1, "Retrieve relevant document evidence.", "grounding", "DOCUMENT_RETRIEVAL", "Ranked evidence chunks from the attached sources."),
      step(2, "Analyze the retrieved evidence against the question.", "analysis", "INTERNAL_REASONING", "The document evidence most relevant to the answer.", ["step-1"]),
      step(3, "Synthesize an answer grounded in the document.", "synthesis", "RESPONSE_SYNTHESIS", "A cited, document-grounded reply.", ["step-2"]),
    ],
  };
}

function webResearchTemplate(): Template {
  return {
    goal: "Research the current information and answer with supporting sources.",
    steps: [
      step(1, "Identify the research topic.", "interpretation", "INTERNAL_REASONING", "A precise topic for search."),
      step(2, "Gather current relevant information.", "research", "WEB_RESEARCH", "Current, relevant web results.", ["step-1"]),
      step(3, "Evaluate the relevant findings.", "analysis", "INTERNAL_REASONING", "Assessed relevance and reliability.", ["step-2"]),
      step(4, "Synthesize the answer.", "synthesis", "RESPONSE_SYNTHESIS", "A coherent research-backed reply.", ["step-3"]),
      step(5, "Include supporting sources.", "grounding", "RESPONSE_SYNTHESIS", "Attribution for each claim.", ["step-4"]),
    ],
  };
}

function hybridRagWebTemplate(): Template {
  return {
    goal: "Answer using both the attached document and current web research, with evidence.",
    steps: [
      step(1, "Retrieve relevant document evidence.", "grounding", "DOCUMENT_RETRIEVAL", "Ranked evidence chunks from the attached sources."),
      step(2, "Research current web information.", "research", "WEB_RESEARCH", "Current, relevant web results."),
      step(3, "Compare document evidence with web evidence.", "comparison", "INTERNAL_REASONING", "Where the two evidence streams agree or diverge.", ["step-1", "step-2"]),
      step(4, "Identify agreements and disagreements.", "analysis", "INTERNAL_REASONING", "Points of consensus and conflict.", ["step-3"]),
      step(5, "Synthesize the answer.", "synthesis", "RESPONSE_SYNTHESIS", "A balanced, grounded reply.", ["step-4"]),
      step(6, "Present evidence and citations.", "grounding", "RESPONSE_SYNTHESIS", "Supporting sources for the claims.", ["step-5"]),
    ],
  };
}

function imageUnderstandingTemplate(routeResult: AgentRouteResult): Template {
  if (routeResult.underlying.primaryRoute === "VISUAL") {
    return {
      goal: "Understand the referenced visual content and explain it in context.",
      steps: [
        step(1, "Retrieve the referenced visual evidence from the document.", "grounding", "DOCUMENT_RETRIEVAL", "The visual pages/figures referenced in the turn."),
        step(2, "Analyze the visual content.", "interpretation", "IMAGE_UNDERSTANDING", "A faithful reading of the visual.", ["step-1"]),
        step(3, "Synthesize an explanation tied to the source.", "synthesis", "RESPONSE_SYNTHESIS", "An answer that explains the visual in context.", ["step-2"]),
      ],
    };
  }
  return {
    goal: "Understand the supplied image and explain its content.",
    steps: [
      step(1, "Analyze the supplied image.", "interpretation", "IMAGE_UNDERSTANDING", "A faithful reading of the image."),
      step(2, "Extract visible text and content.", "analysis", "INTERNAL_REASONING", "The recognizable text/objects in the image.", ["step-1"]),
      step(3, "Explain the extracted content.", "synthesis", "RESPONSE_SYNTHESIS", "A clear explanation of what the image shows.", ["step-2"]),
    ],
  };
}

function imageGenerationTemplate(routeResult: AgentRouteResult, metadata: AgentRouteMetadata): Template {
  const grounded = routeResult.underlying.requiresDocuments;
  if (metadata.imageOperation === "edit") {
    return {
      goal: "Edit the source image as requested.",
      steps: [
        step(1, "Interpret the edit instruction against the source image.", "interpretation", "INTERNAL_REASONING", "What changes are requested."),
        step(2, "Construct the edit request.", "construction", "INTERNAL_REASONING", "A precise edit prompt.", ["step-1"]),
        step(3, "Apply the edit to the source image.", "generation", "IMAGE_GENERATION", "The edited image.", ["step-2"]),
      ],
    };
  }
  if (metadata.imageOperation === "document_visual") {
    const stepsChain = [
      ...(grounded
        ? [step(1, "Retrieve the relevant document evidence.", "grounding", "DOCUMENT_RETRIEVAL", "The evidence the visual must reflect.")]
        : []),
    ];
    const base = stepsChain.length;
    stepsChain.push(
      step(base + 1, "Interpret the requested visual.", "interpretation", "INTERNAL_REASONING", "The visual concept requested.", stepsChain.length > 0 ? [`step-${base}`] : []),
      step(base + 2, "Construct the visual generation request.", "construction", "INTERNAL_REASONING", "A precise visual prompt.", [`step-${base + 1}`]),
      step(base + 3, "Generate the document visual.", "generation", "IMAGE_GENERATION", "The document-grounded visual.", [`step-${base + 2}`])
    );
    return {
      goal: "Generate a visual grounded in the document.",
      steps: stepsChain,
    };
  }
  if (grounded) {
    return {
      goal: "Generate an image grounded in the attached document.",
      steps: [
        step(1, "Retrieve the relevant document evidence.", "grounding", "DOCUMENT_RETRIEVAL", "The evidence the image must reflect."),
        step(2, "Interpret the requested visual concept.", "interpretation", "INTERNAL_REASONING", "The visual concept requested.", ["step-1"]),
        step(3, "Construct the generation request.", "construction", "INTERNAL_REASONING", "A precise generation prompt.", ["step-2"]),
        step(4, "Generate the image.", "generation", "IMAGE_GENERATION", "The generated image.", ["step-3"]),
      ],
    };
  }
  return {
    goal: "Generate the requested image.",
    steps: [
      step(1, "Interpret the requested visual concept.", "interpretation", "INTERNAL_REASONING", "The visual concept requested."),
      step(2, "Construct the generation request.", "construction", "INTERNAL_REASONING", "A precise generation prompt.", ["step-1"]),
      step(3, "Generate the image.", "generation", "IMAGE_GENERATION", "The generated image.", ["step-2"]),
    ],
  };
}

function voiceTemplate(): Template {
  return {
    goal: "Respond to the spoken request appropriately.",
    steps: [
      step(1, "Recognize the spoken request via the voice pipeline.", "recognition", "VOICE_PROCESSING", "The transcribed request text."),
      step(2, "Determine the intent from the utterance.", "interpretation", "INTERNAL_REASONING", "What the user is asking.", ["step-1"]),
      step(3, "Generate the conversational response.", "synthesis", "RESPONSE_SYNTHESIS", "A natural spoken-style reply.", ["step-2"]),
    ],
  };
}

function locationTemplate(): Template {
  return {
    goal: "Answer using the user's shared location.",
    steps: [
      step(1, "Use the shared location context.", "grounding", "LOCATION_LOOKUP", "The coarsened shared coordinates."),
      step(2, "Interpret what the user wants relative to that location.", "interpretation", "INTERNAL_REASONING", "The location-aware intent.", ["step-1"]),
      step(3, "Generate the location-aware response.", "synthesis", "RESPONSE_SYNTHESIS", "An answer that accounts for the shared location.", ["step-2"]),
    ],
  };
}

function mapsTemplate(metadata: AgentRouteMetadata): Template {
  const query = metadata.mapQuery ?? "nearby places";
  if (!metadata.location) {
    // Defensive only: 8A maps to CHAT without a shared location, but the
    // planner must never pretend a location exists.
    return {
      goal: `Resolve "${query}" once a location is shared.`,
      steps: [
        step(1, "Request the user's shared location.", "grounding", "LOCATION_LOOKUP", "A shared coarse location."),
        step(2, "Resolve the nearby-place query.", "interpretation", "INTERNAL_REASONING", `A geocodable place noun for "${query}".`, ["step-1"]),
        step(3, "Search and present nearby places once located.", "lookup", "MAP_LOOKUP", "Places with Google Maps links.", ["step-2"]),
      ],
    };
  }
  return {
    goal: `Find nearby "${query}" using the shared location.`,
    steps: [
      step(1, "Validate the user's shared location.", "grounding", "LOCATION_LOOKUP", "A validated coarsened location."),
      step(2, "Resolve the nearby-place query.", "interpretation", "INTERNAL_REASONING", `A geocodable place noun for "${query}".`, ["step-1"]),
      step(3, "Search nearby places with the maps capability.", "lookup", "MAP_LOOKUP", "Nearby places from the existing maps pipeline.", ["step-2"]),
      step(4, "Present the places with Google Maps links.", "presentation", "RESPONSE_SYNTHESIS", "Nearby places with map links.", ["step-3"]),
    ],
  };
}

function multimodalTemplate(routeResult: AgentRouteResult): Template {
  const isImagePlusWeb =
    routeResult.underlying.primaryRoute === "WEB_RESEARCH" && Boolean(routeResult.metadata.hasFreshUploadedImage);
  if (isImagePlusWeb) {
    return {
      goal: "Answer using both the supplied image and current web research.",
      steps: [
        step(1, "Analyze the supplied image.", "interpretation", "IMAGE_UNDERSTANDING", "A faithful reading of the image."),
        step(2, "Gather current relevant web information.", "research", "WEB_RESEARCH", "Current, relevant web results."),
        step(3, "Combine the visual and web evidence.", "fusion", "INTERNAL_REASONING", "How the image and web facts relate.", ["step-1", "step-2"]),
        step(4, "Synthesize the answer.", "synthesis", "RESPONSE_SYNTHESIS", "A combined answer with sources.", ["step-3"]),
      ],
    };
  }
  // Visual-reference + textual-analysis flavor (Phase 6B MULTIMODAL).
  return {
    goal: "Answer using every provided modality (image and text).",
    steps: [
      step(1, "Retrieve the referenced visual evidence from the document.", "grounding", "DOCUMENT_RETRIEVAL", "The referenced visual pages/figures."),
      step(2, "Retrieve the relevant textual evidence.", "grounding", "DOCUMENT_RETRIEVAL", "The referenced text chunks."),
      step(3, "Analyze the visual content.", "interpretation", "IMAGE_UNDERSTANDING", "A faithful reading of the visual.", ["step-1"]),
      step(4, "Combine the visual and textual evidence.", "fusion", "INTERNAL_REASONING", "How the visual and text relate.", ["step-2", "step-3"]),
      step(5, "Synthesize the answer.", "synthesis", "RESPONSE_SYNTHESIS", "A combined, cited answer.", ["step-4"]),
    ],
  };
}

function realtimeTemplate(metadata: AgentRouteMetadata): Template {
  const intent = metadata.realtimeIntent && metadata.realtimeIntent !== "NONE"
    ? ` (intent ${metadata.realtimeIntent})`
    : "";
  return {
    goal: "Answer using the existing real-time data capability.",
    steps: [
      step(1, `Identify the requested current data${intent}.`, "interpretation", "INTERNAL_REASONING", "The precise data requested."),
      step(2, "Obtain the current data via the existing realtime capability.", "lookup", "REALTIME_LOOKUP", "The authoritative current value.", ["step-1"]),
      step(3, "Validate and interpret the returned information.", "analysis", "INTERNAL_REASONING", "A correct reading of the value.", ["step-2"]),
      step(4, "Generate the response.", "synthesis", "RESPONSE_SYNTHESIS", "A direct, grounded reply.", ["step-3"]),
    ],
  };
}

function hybridTemplate(): Template {
  return {
    goal: "Answer by fusing document evidence with live realtime data.",
    steps: [
      step(1, "Retrieve the required document evidence.", "grounding", "DOCUMENT_RETRIEVAL", "Relevant chunks from the attached sources."),
      step(2, "Obtain the required realtime information.", "lookup", "REALTIME_LOOKUP", "The authoritative current value."),
      step(3, "Fuse the document and realtime evidence.", "fusion", "INTERNAL_REASONING", "How the two evidence streams combine.", ["step-1", "step-2"]),
      step(4, "Synthesize the answer.", "synthesis", "RESPONSE_SYNTHESIS", "A fused, grounded reply.", ["step-3"]),
    ],
  };
}

function taskTemplate(metadata: AgentRouteMetadata): Template {
  const kind = metadata.taskKind && metadata.taskKind !== "TASK_NONE" ? `${metadata.taskKind}` : "task or plan";
  return {
    goal: "Apply the requested task or plan operation through the existing task capability.",
    steps: [
      step(1, "Parse the request into a task or plan intent.", "interpretation", "TASK_MANAGEMENT", `A resolved intent (${kind}).`),
      step(2, `Apply the ${kind} operation via the existing task capability.`, "application", "TASK_MANAGEMENT", "The resulting task/plan state.", ["step-1"]),
      step(3, "Confirm the resulting state to the user.", "synthesis", "RESPONSE_SYNTHESIS", "An honest confirmation or error.", ["step-2"]),
    ],
  };
}

function clarificationTemplate(): Template {
  return {
    goal: "Resolve the ambiguity in the request.",
    steps: [
      step(1, "Identify the missing or ambiguous information.", "interpretation", "INTERNAL_REASONING", "The specific ambiguity to resolve."),
      step(2, "Ask a concise clarification question.", "synthesis", "RESPONSE_SYNTHESIS", "A focused follow-up to disambiguate the turn.", ["step-1"]),
    ],
  };
}

function unknownTemplate(): Template {
  return {
    goal: "Resolve the unrecognized request safely.",
    steps: [
      step(1, "Ask for clarification or provide a normal fallback response.", "fallback", "RESPONSE_SYNTHESIS", "A safe, honest reply that does not pretend to understand the request."),
    ],
  };
}

function templateFor(routeResult: AgentRouteResult, message: string): Template {
  switch (routeResult.route) {
    case "CHAT":
      return chatTemplate(message);
    case "CLARIFICATION":
      return clarificationTemplate();
    case "UNKNOWN":
      return unknownTemplate();
    case "DOCUMENT_RAG":
      return documentRagTemplate();
    case "WEB_RESEARCH":
      return webResearchTemplate();
    case "HYBRID_RAG_WEB":
      return hybridRagWebTemplate();
    case "IMAGE_UNDERSTANDING":
      return imageUnderstandingTemplate(routeResult);
    case "IMAGE_GENERATION":
      return imageGenerationTemplate(routeResult, routeResult.metadata);
    case "VOICE":
      return voiceTemplate();
    case "LOCATION":
      return locationTemplate();
    case "MAPS":
      return mapsTemplate(routeResult.metadata);
    case "MULTIMODAL":
      return multimodalTemplate(routeResult);
    case "REALTIME":
      return realtimeTemplate(routeResult.metadata);
    case "HYBRID":
      return hybridTemplate();
    case "TASK_MANAGEMENT":
      return taskTemplate(routeResult.metadata);
    default:
      return unknownTemplate();
  }
}

// ---------------------------------------------------------------------------
// Deterministic complexity
// ---------------------------------------------------------------------------

function complexityFor(
  route: AgentRoute,
  metadata: AgentRouteMetadata,
  message: string,
  stepCount: number
): { complexity: PlanComplexity; signals: string[] } {
  const signals: string[] = [];

  switch (route) {
    case "HYBRID_RAG_WEB":
      signals.push("document-plus-web");
      signals.push("parallel-evidence");
      return { complexity: "COMPLEX", signals };
    case "HYBRID":
      signals.push("realtime-plus-document");
      return { complexity: "COMPLEX", signals };
    case "MULTIMODAL":
      signals.push("multimodal-input");
      return { complexity: "COMPLEX", signals };
    case "TASK_MANAGEMENT":
      signals.push("task-management");
      return { complexity: "MODERATE", signals };
    case "DOCUMENT_RAG":
      signals.push("document-evidence");
      return { complexity: "MODERATE", signals };
    case "WEB_RESEARCH":
      signals.push("explicit-research");
      return { complexity: "MODERATE", signals };
    case "MAPS":
      signals.push("location-plus-lookup");
      return { complexity: "MODERATE", signals };
    case "IMAGE_UNDERSTANDING":
      signals.push(metadata.hasFreshUploadedImage ? "visual-input" : "visual-reference");
      return { complexity: "MODERATE", signals };
    case "IMAGE_GENERATION":
      if (metadata.imageOperation === "edit") {
        signals.push("reference-image-edit");
        return { complexity: "MODERATE", signals };
      }
      if (metadata.imageOperation === "document_visual") {
        signals.push("document-grounded-visual");
        return { complexity: "MODERATE", signals };
      }
      signals.push("text-to-image");
      return { complexity: "SIMPLE", signals };
    case "REALTIME":
      signals.push("single-realtime-intent");
      return { complexity: "SIMPLE", signals };
    case "LOCATION":
      signals.push("shared-location-context");
      return { complexity: "SIMPLE", signals };
    case "VOICE":
      signals.push("voice-input");
      return { complexity: "SIMPLE", signals };
    case "CLARIFICATION":
      signals.push("ambiguous-input");
      return { complexity: "SIMPLE", signals };
    case "UNKNOWN":
      signals.push("unrecognized-input");
      return { complexity: "SIMPLE", signals };
    case "CHAT":
    default:
      if (stepCount <= 1) {
        signals.push("small-talk");
        return { complexity: "SIMPLE", signals };
      }
      if (COMPARISON_SIGNAL.test(message)) signals.push("explicit-comparison");
      if (MULTI_PART_SIGNAL.test(message)) signals.push("multi-part-request");
      return { complexity: "MODERATE", signals };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a deterministic AgentPlan for an 8A AgentRouteResult. Pure function:
 * same inputs → equivalent plan, always. It consumes the 8A classification and
 * NEVER re-classifies, executes, or performs side effects.
 */
export function createAgentPlan(
  routeResult: AgentRouteResult,
  input: AgentPlanInput
): AgentPlan {
  const message = (input?.message ?? "").trim();
  const template = templateFor(routeResult, message);
  const { complexity, signals } = complexityFor(
    routeResult.route,
    routeResult.metadata,
    message,
    template.steps.length
  );

  return {
    version: 1,
    status: "PLANNED",
    route: routeResult.route,
    complexity,
    goal: template.goal,
    steps: template.steps,
    metadata: {
      complexitySignals: signals,
      usesSharedLocation: Boolean(routeResult.metadata.location),
      hasFreshImage: Boolean(routeResult.metadata.hasFreshUploadedImage),
    },
  };
}