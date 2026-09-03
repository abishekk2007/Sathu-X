// ---------------------------------------------------------------------------
// Phase 8C — Agent Tool Calling: adapters.
//
// Thin wrappers over the EXISTING real capabilities (never duplicate engines):
//   - DOCUMENT_RETRIEVAL → Phase 5C/5D retrieval (single or multi-source)
//   - WEB_RESEARCH       → Phase 7C  researchWeb
//   - REALTIME_LOOKUP    → Phase 6A  executeRealtimeTool
//   - TASK_MANAGEMENT    → Phase 6G  handleTaskCommand
//   - IMAGE_GENERATION   → Phase 6C/6D/6E image services
//   - MAP_LOOKUP         → shared Nominatim geocoder (single geocoder)
//   - VOICE_PROCESSING / LOCATION_LOOKUP / IMAGE_UNDERSTANDING
//                        → consume data the client ALREADY sends (never a
//                          server-side geolocation/camera/mic probe)
//   - INTERNAL_REASONING / RESPONSE_SYNTHESIS / CLARIFICATION
//                        → safe structured notes; the FINAL synthesis is the
//                          existing Gemini stream (never a second model call,
//                          never hidden chain-of-thought)
//
// Every adapter returns a serializable, secret-free `AgentToolResult` and is
// conservative: it returns UNAVAILABLE rather than fabricate results when the
// required input/capability is not present (no location, no image, …).
// ---------------------------------------------------------------------------

import type { AgentRuntimeContext, AgentToolContext, AgentToolResult, AgentToolErrorCode } from "./types";

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function ok(
  toolName: AgentToolResult["toolName"],
  stepId: string,
  output: unknown,
  meta: AgentToolResult["metadata"] = {}
): AgentToolResult {
  return { toolName, stepId, status: "SUCCESS", output, metadata: meta };
}

function fail(
  toolName: AgentToolResult["toolName"],
  stepId: string,
  code: AgentToolErrorCode,
  message: string,
  meta: AgentToolResult["metadata"] = {}
): AgentToolResult {
  return { toolName, stepId, status: "FAILED", error: { code, message }, metadata: meta };
}

function unavailable(
  toolName: AgentToolResult["toolName"],
  stepId: string,
  code: AgentToolErrorCode,
  message: string,
  meta: AgentToolResult["metadata"] = {}
): AgentToolResult {
  return { toolName, stepId, status: "UNAVAILABLE", error: { code, message }, metadata: meta };
}

// ---------------------------------------------------------------------------
// Internal / synthesis / clarification (safe structured notes only)
// ---------------------------------------------------------------------------

/** INTERNAL_REASONING — bookkeeping step. Produces a safe note, never hidden
 *  chain-of-thought, never a model call, never a fabricated result. */
function internalReasoning(ctx: AgentToolContext): Promise<AgentToolResult> {
  return Promise.resolve(
    ok("INTERNAL_REASONING", ctx.stepId, {
      // Deliberately NOT the reasoning trace — just what the plan asked.
      note: "internal reasoning step complete (deferred to the final synthesis)",
    })
  );
}

/** RESPONSE_SYNTHESIS — the final answer is produced by the EXISTING Gemini
 *  stream, never a second model call from a tool. Marks readiness only. */
function responseSynthesis(ctx: AgentToolContext): Promise<AgentToolResult> {
  return Promise.resolve(
    ok("RESPONSE_SYNTHESIS", ctx.stepId, {
      synthesis: "deferred-to-stream",
    })
  );
}

/** CLARIFICATION — the turn is answered by the existing chat pipeline with a
 *  clarifying question; never a separate tool execution. Marks readiness. */
function clarification(ctx: AgentToolContext): Promise<AgentToolResult> {
  return Promise.resolve(
    ok("CLARIFICATION", ctx.stepId, {
      clarification: "deferred-to-pipeline",
    })
  );
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/** DOCUMENT_RETRIEVAL — runs the real Phase 5C/5D retrieval (never duplicates
 *  an engine). Returns bounded, safe evidence the downstream pipeline consumes. */
async function documentRetrieval(
  ctx: AgentToolContext,
  rt: AgentRuntimeContext
): Promise<AgentToolResult> {
  if (ctx.sourceCount === 0) {
    return unavailable("DOCUMENT_RETRIEVAL", ctx.stepId, "no_evidence",
      "No attached document sources to retrieve from.");
  }
  const started = Date.now();
  try {
    if (ctx.sourceCount > 1 && rt.orchestrateMultiSourceRetrieval) {
      const multi = await rt.orchestrateMultiSourceRetrieval(
        ctx.retrievalMessage,
        rt.agentSources ?? [],
        rt.userId ?? ""
      );
      return ok("DOCUMENT_RETRIEVAL", ctx.stepId, {
        chunks: multi.results,
        strategy: multi.analysis.intent.strategy,
        conflicts: multi.analysis.conflicts,
        multiSourceAnalysis: {
          strategy: multi.analysis.intent.strategy,
          conflicts: multi.analysis.conflicts,
          sourceCount: multi.analysis.readySourceCount,
        },
      }, { durationMs: Date.now() - started, source: "multi-source", count: multi.results.length });
    }
    if (rt.retrieveAgentContext) {
      const results = await rt.retrieveAgentContext(
        {
          query: ctx.retrievalMessage,
          sources: rt.agentSources ?? [],
        },
        rt.userId ?? ""
      );
      return ok("DOCUMENT_RETRIEVAL", ctx.stepId, {
        chunks: results,
      }, { durationMs: Date.now() - started, source: "retrieveAgentContext", count: results.length });
    }
    return unavailable("DOCUMENT_RETRIEVAL", ctx.stepId, "not_configured",
      "Retrieval capability is not available in this context.");
  } catch (e) {
    console.error("[agent-tools] DOCUMENT_RETRIEVAL failed", e);
    return fail("DOCUMENT_RETRIEVAL", ctx.stepId, "internal",
      "Retrieval failed; continuing without document evidence.");
  }
}

// ---------------------------------------------------------------------------
// Web research
// ---------------------------------------------------------------------------

/** WEB_RESEARCH — runs the real Phase 7C orchestrator (fails open). */
async function webResearch(
  ctx: AgentToolContext,
  rt: AgentRuntimeContext
): Promise<AgentToolResult> {
  const started = Date.now();
  try {
    const research = await (rt.researchWeb ?? realResearchWeb)(
      ctx.message,
      { force: true }
    );
    return ok("WEB_RESEARCH", ctx.stepId, {
      sources: research.sources,
      evidence: research.evidence,
      images: research.images,
      degraded: research.degraded,
      status: research.status,
    }, { durationMs: Date.now() - started, source: "web-research", count: research.sources.length });
  } catch (e) {
    console.error("[agent-tools] WEB_RESEARCH failed", e);
    return fail("WEB_RESEARCH", ctx.stepId, "upstream_error",
      "Web research failed; answering without web-verified sources.");
  }
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/** REALTIME_LOOKUP — runs the real Phase 6A tool (never throws). */
async function realtimeLookup(
  ctx: AgentToolContext,
  rt: AgentRuntimeContext
): Promise<AgentToolResult> {
  if (!rt.realtimeDecision || !rt.realtimeDecision.handled) {
    return unavailable("REALTIME_LOOKUP", ctx.stepId, "not_found",
      "No real-time decision was attached to this turn.");
  }
  const started = Date.now();
  try {
    const result = await (rt.executeRealtimeTool ?? realExecuteRealtimeTool)({
      decision: rt.realtimeDecision,
      message: ctx.message,
      userId: rt.userId,
    });
    if (!result.success) {
      return fail("REALTIME_LOOKUP", ctx.stepId, "upstream_error",
        result.error?.message ?? "Live data isn't available right now.",
        { durationMs: Date.now() - started, source: result.tool });
    }
    return ok("REALTIME_LOOKUP", ctx.stepId, {
      answer: result.answer,
      tool: result.tool,
      source: result.source,
      success: true,
    }, { durationMs: Date.now() - started, source: result.tool });
  } catch (e) {
    console.error("[agent-tools] REALTIME_LOOKUP failed", e);
    return fail("REALTIME_LOOKUP", ctx.stepId, "upstream_error",
      "Live data isn't available right now.");
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** TASK_MANAGEMENT — runs the real Phase 6G command handler. */
async function taskManagement(
  ctx: AgentToolContext,
  rt: AgentRuntimeContext
): Promise<AgentToolResult> {
  if (!rt.supabase) {
    return unavailable("TASK_MANAGEMENT", ctx.stepId, "not_configured",
      "No authenticated database session for task management.");
  }
  const started = Date.now();
  try {
    const reply = await (rt.handleTaskCommand ?? realHandleTaskCommand)({
      supabase: rt.supabase,
      taskIntent: rt.taskIntent,
      planIntent: rt.planIntent,
      message: ctx.message,
      timezone: ctx.timezone,
    });
    return ok("TASK_MANAGEMENT", ctx.stepId, { reply }, {
      durationMs: Date.now() - started,
      source: "tasks",
    });
  } catch (e) {
    console.error("[agent-tools] TASK_MANAGEMENT failed", e);
    return fail("TASK_MANAGEMENT", ctx.stepId, "internal",
      "The task operation failed; nothing was recorded.");
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** IMAGE_GENERATION — delegates to the real service (generate / edit / doc). */
async function imageGeneration(
  ctx: AgentToolContext,
  rt: AgentRuntimeContext
): Promise<AgentToolResult> {
  const operation = ctx.imageOperation ?? "generate";
  const started = Date.now();

  try {
    if (operation === "edit") {
      if (!ctx.imageSource) {
        return unavailable("IMAGE_GENERATION", ctx.stepId, "no_image",
          "No validated source image to edit.");
      }
      const outcome = await (rt.editImage ?? realEditImage)({
        message: ctx.message,
        mode: ctx.mode,
        sourceImage: { bytes: ctx.imageSource.bytes, mimeType: ctx.imageSource.mimeType },
        evidence: rt.imageEvidence,
        groundedRequired: Boolean(ctx.sourceCount > 0),
        priorUserMessage: ctx.priorUserMessage,
        kind: "edit",
        sourceKey: ctx.imageSource.sourceKey,
      });
      return imageOutcomeToResult("IMAGE_GENERATION", ctx.stepId, outcome, started);
    }

    if (operation === "document_visual") {
      const ev: import("@/lib/image-generation").DocumentVisualEvidenceItem[] =
        rt.documentVisualEvidence ?? [];
      const outcome = await (rt.generateDocumentVisual ?? realGenerateDocumentVisual)({
        message: ctx.message,
        mode: ctx.mode,
        evidence: ev,
        requestedVisualType: rt.documentVisualType ?? null,
        priorUserMessage: ctx.priorUserMessage,
        refinementOf: rt.documentVisualRefinementOf ?? null,
      });
      return imageOutcomeToResult("IMAGE_GENERATION", ctx.stepId, outcome, started);
    }

    const outcome = await (rt.generateImage ?? realGenerateImage)({
      message: ctx.message,
      mode: ctx.mode,
      evidence: rt.imageEvidence,
      groundedRequired: Boolean(ctx.sourceCount > 0),
      priorUserMessage: ctx.priorUserMessage,
    });
    return imageOutcomeToResult("IMAGE_GENERATION", ctx.stepId, outcome, started);
  } catch (e) {
    console.error("[agent-tools] IMAGE_GENERATION failed", e);
    return fail("IMAGE_GENERATION", ctx.stepId, "upstream_error",
      "Image generation isn't available right now.");
  }
}

function imageOutcomeToResult(
  toolName: AgentToolResult["toolName"],
  stepId: string,
  outcome: import("@/lib/image-generation").ImageOutcome,
  started: number
): AgentToolResult {
  if (outcome.kind === "message") {
    // A safe explainer message (no keys / no internals) is a valid outcome.
    return ok(toolName, stepId, { kind: "message", message: outcome.message }, {
      durationMs: Date.now() - started,
      source: "image-service",
    });
  }
  const image = outcome.image;
  return ok(toolName, stepId, {
    kind: "image",
    provider: image.provider,
    mimeType: image.mimeType,
    dataUrl: image.dataUrl,
    width: image.width,
    height: image.height,
    fileSizeBytes: image.fileSizeBytes,
    prompt: image.prompt,
    mode: image.mode,
    editSourceKey: image.editSourceKey,
    sourceGrounded: image.sourceGrounded,
    visualType: image.visualType,
  }, { durationMs: Date.now() - started, source: image.provider });
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

/** MAP_LOOKUP — runs the SHARED Nominatim geocoder, only when a location was
 *  shared. No location → UNAVAILABLE (never fabricates coordinates). Never
 *  includes the user's raw location in the result. */
async function mapLookup(
  ctx: AgentToolContext,
  rt: AgentRuntimeContext
): Promise<AgentToolResult> {
  if (!ctx.sharedLocation) {
    return unavailable("MAP_LOOKUP", ctx.stepId, "location_required",
      "No shared location; cannot resolve nearby places.");
  }
  const query = ctx.mapQuery;
  if (!query) {
    return unavailable("MAP_LOOKUP", ctx.stepId, "invalid_input",
      "No resolvable place query for this turn.");
  }
  const started = Date.now();
  try {
    const outcome = await (rt.geocodePlaces ?? realGeocodePlaces)(
      {
        q: query,
        latitude: ctx.sharedLocation.latitude,
        longitude: ctx.sharedLocation.longitude,
      },
      rt.fetchImpl
    );
    if (!outcome.ok) {
      return fail("MAP_LOOKUP", ctx.stepId, "upstream_error",
        outcome.code === "rate_limited" ? "Place search is temporarily busy." : "Place search is unavailable right now.",
        { durationMs: Date.now() - started, source: "nominatim" });
    }
    // Strip absolute place coordinates from the tool result (no raw coords).
    const places = outcome.places.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      address: p.address,
      distanceMeters: p.distanceMeters,
      openInGoogleMaps: p.openInGoogleMaps,
    }));
    return ok("MAP_LOOKUP", ctx.stepId, { places, count: places.length }, {
      durationMs: Date.now() - started,
      source: "nominatim",
      count: places.length,
    });
  } catch (e) {
    console.error("[agent-tools] MAP_LOOKUP failed", e);
    return fail("MAP_LOOKUP", ctx.stepId, "upstream_error",
      "Place search is unavailable right now.");
  }
}

// ---------------------------------------------------------------------------
// Modality adapters (consume client-provided data, never probe server-side)
// ---------------------------------------------------------------------------

/** VOICE_PROCESSING — the transcript ALREADY arrived as `inputModality:voice`
 *  from speech-to-text. Marks the recognized utterance ready for downstream
 *  interpretation; never touches the mic, never re-transcribes. */
function voiceProcessing(ctx: AgentToolContext): Promise<AgentToolResult> {
  if (ctx.inputModality !== "voice") {
    return Promise.resolve(
      unavailable("VOICE_PROCESSING", ctx.stepId, "internal",
        "This turn did not arrive via voice input.")
    );
  }
  return Promise.resolve(
    ok("VOICE_PROCESSING", ctx.stepId, {
      recognized: true,
      // The transcribed text IS ctx.message — the client already provided it.
      transcript: ctx.message,
    })
  );
}

/** LOCATION_LOOKUP — consumes the client's already-sent shared location and
 *  reports presence + (coarsened) accuracy ONLY — never raw coordinates. */
function locationLookup(ctx: AgentToolContext): Promise<AgentToolResult> {
  const loc = ctx.sharedLocation;
  if (!loc) {
    return Promise.resolve(
      unavailable("LOCATION_LOOKUP", ctx.stepId, "location_required",
        "No shared location was provided by the user.")
    );
  }
  return Promise.resolve(
    ok("LOCATION_LOOKUP", ctx.stepId, {
      hasLocation: true,
      accuracy: loc.accuracy,
    })
  );
}

/** IMAGE_UNDERSTANDING — reports whether this turn carries an image for the
 *  downstream vision pipeline. UNAVAILABLE when no image context exists. No
 *  server-side probe; the client already attached the bytes/refs. */
function imageUnderstanding(ctx: AgentToolContext): Promise<AgentToolResult> {
  const hasImage = ctx.hasFreshImage || ctx.visionSource !== null;
  if (!hasImage) {
    return Promise.resolve(
      unavailable("IMAGE_UNDERSTANDING", ctx.stepId, "no_image",
        "This turn carried no image to understand.")
    );
  }
  return Promise.resolve(
    ok("IMAGE_UNDERSTANDING", ctx.stepId, {
      hasImage: true,
      validated: ctx.visionSource !== null || ctx.hasFreshImage,
    })
  );
}

// ---------------------------------------------------------------------------
// Registry — the closed set. One adapter per execution type.
// ---------------------------------------------------------------------------

import type { AgentToolName } from "./types";
import type { AgentToolRegistry } from "./registry";

/**
 * The real implementations these adapters default to (network-capable). They
 * are imported here so the default `runtime` needs no construction; tests
 * inject mocks via `AgentRuntimeContext` instead.
 */
import { researchWeb as realResearchWeb } from "@/lib/web-research";
import { executeRealtimeTool as realExecuteRealtimeTool } from "@/lib/realtime";
import { handleTaskCommand as realHandleTaskCommand } from "@/lib/tasks/chat-handler";
import {
  generateImage as realGenerateImage,
  editImage as realEditImage,
  generateDocumentVisual as realGenerateDocumentVisual,
} from "@/lib/image-generation";
import { geocodePlaces as realGeocodePlaces } from "@/lib/map-geocode";

/** Builds and returns the closed adapter registry (idempotent). */
export function buildAdapters(): AgentToolRegistry {
  const registry: AgentToolRegistry = {
    INTERNAL_REASONING: internalReasoning,
    RESPONSE_SYNTHESIS: responseSynthesis,
    DOCUMENT_RETRIEVAL: documentRetrieval,
    WEB_RESEARCH: webResearch,
    REALTIME_LOOKUP: realtimeLookup,
    MAP_LOOKUP: mapLookup,
    IMAGE_UNDERSTANDING: imageUnderstanding,
    IMAGE_GENERATION: imageGeneration,
    VOICE_PROCESSING: voiceProcessing,
    LOCATION_LOOKUP: locationLookup,
    TASK_MANAGEMENT: taskManagement,
    CLARIFICATION: clarification,
  };
  return registry;
}

export { internalReasoning, responseSynthesis, clarification, documentRetrieval, webResearch, realtimeLookup, taskManagement, imageGeneration, mapLookup, voiceProcessing, locationLookup, imageUnderstanding };
export type { AgentToolName };
