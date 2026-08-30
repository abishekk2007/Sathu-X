import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { getGeminiClient } from "@/lib/gemini";
import {
  buildDomainSystemInstruction,
  buildRealtimeSystemInstruction,
  executeDomainTool,
  executeRealtimeTool,
  resolveDomainContext,
} from "@/lib/realtime";
import {
  extractMemory,
  fetchProfileForContext,
} from "@/lib/spidey-memory";
import {
  buildMemoryContextBlock,
  buildDedupKey,
  deleteAllMemories,
  deleteMemory,
  detectMemoryIntent,
  evaluateSave,
  findMemoryByKey,
  isMemoryEnabled,
  listMemories,
  mapCategoryToType,
  parseMemoryCandidate,
  resolveDeleteTarget,
  retrieveRelevantMemories,
  setMemoryMode,
  summarizeMemories,
  upsertMemory,
} from "@/lib/memory";
import type {
  $UserMemory,
  MemoryIntentResult,
  MemoryWrite,
} from "@/lib/memory";
import {
  applyWeaknessSignal,
  buildStudentContextBlock,
  detectWeaknessSignal,
  fetchChatAcademicContext,
} from "@/lib/student-intelligence";
import {
  buildPlannerChatBlock,
  fetchPlannerChatContext,
  toDateOnly,
} from "@/lib/study-planner";
import {
  buildProductivityChatBlock,
  fetchProductivityChatContext,
} from "@/lib/student-productivity";
import { detectProgrammingIntent } from "@/lib/programming-mode";
import { buildProgrammingInstruction, buildDocumentGroundingInstruction, buildSystemInstruction } from "@/lib/spidey-instruction";
import { retrieveDocumentChunks, formatRetrievalContext } from "@/lib/document-retrieval";
import { processDocument } from "@/lib/document-processing";
import {
  routeDecision,
  retrieveAgentContext,
  buildGroundingInstruction,
  buildNoResultsGrounding,
  orchestrateMultiSourceRetrieval,
  detectVisualIntent,
  loadVisualEvidence,
  buildVisualEvidenceNote,
  buildGeminiImageParts,
  routeQuery,
  describeQueryRoute,
} from "@/lib/agent";
import type { AgentSource, MultiSourceIntent } from "@/lib/agent";
import { handleTaskCommand } from "@/lib/tasks/chat-handler";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import {
  documentStatusCache,
  TimingAccumulator,
} from "@/lib/cache";
import {
  generateImage,
  editImage,
  generateDocumentVisual,
  detectImageEditIntent,
  SAFE_EDIT_UNAVAILABLE_MESSAGE,
  SAFE_EDIT_NO_IMAGE_MESSAGE,
  SAFE_EDIT_CLARIFY_MESSAGE,
  SAFE_EDIT_INVALID_SOURCE_MESSAGE,
  SAFE_DOC_VISUAL_NO_DOC_MESSAGE,
  type DocumentVisualEvidenceItem,
  type DocumentVisualType,
  type ImageContextRef,
  type ImageOutcome,
} from "@/lib/image-generation";
import { validateImage } from "@/lib/multimodal/image-processing";

export const runtime = "nodejs";

// Fastest suitable models verified available to this API configuration,
// ordered by answer quality. Free tier allows ~20 requests/min per model
// bucket; later chain entries draw from independent buckets so chat keeps
// working when interactive usage saturates the faster models. Override the
// primary via GEMINI_MODEL.
const MODEL_CHAIN = [
  process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
];

// Measured on this key: hidden reasoning delays first text by ~1.6s
// (≈2.5s vs ≈0.9s). Conversational chat doesn't need it. Some models reject
// the parameter with 400 — those are retried without it automatically.
const THINKING_BUDGET = 0;

// Hard ceiling on time spent retrying before answering with an error. Keeps
// worst-case "time to feedback" predictable instead of minute-long stalls.
const MAX_ATTEMPTS = 3;
const MAX_TOTAL_WAIT_MS = 8_000;

const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(8000),
      })
    )
    .min(1)
    .max(40),
  mode: z.enum(["general", "student", "assistant"]),
  // Optional subject/topic the user explicitly selected before chatting.
  // Existence + ownership are verified server-side via RLS-scoped reads;
  // foreign or unknown ids simply resolve to nothing.
  context: z
    .object({
      subjectId: z.string().uuid().optional(),
      topicId: z.string().uuid().optional(),
      documentId: z.string().uuid().optional(),
      sourceIds: z.array(z.string().uuid()).optional(),
    })
    .optional(),
  // Phase 6D — conversation image metadata (no bytes; keys tie to editImage).
  images: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(64),
        provider: z.string().trim().max(32).optional(),
        mimeType: z.string().trim().max(64).optional(),
        prompt: z.string().trim().max(900).optional(),
        width: z.number().int().positive().max(10000).optional(),
        height: z.number().int().positive().max(10000).optional(),
      })
    )
    .max(8)
    .optional(),
  // Phase 6D — bytes of a single conversation image the client rendered
  // (the most-recent one by default). The server re-validates the bytes; the
  // declared MIME is never trusted.
  editImage: z
    .object({
      sourceKey: z.string().trim().min(1).max(64),
      dataUrl: z.string().min(64).max(30_000_000),
      mimeType: z.string().trim().max(64).optional(),
    })
    .optional(),
  // Phase 6G — client's IANA timezone (for due-date resolution). Bounded to
  // a sane string; the schedule layer validates it, else falls back to the
  // server default.
  timezone: z.string().trim().max(64).optional(),
  // Phase 6D — an image the user uploaded directly in the chat composer.
  uploadedImage: z
    .object({
      dataUrl: z.string().min(64).max(30_000_000),
      mimeType: z.string().trim().max(64).optional(),
      name: z.string().trim().max(255).optional(),
    })
    .optional(),
});

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

// ---------------------------------------------------------------------------
// Phase 6F — deterministic memory commands (no LLM for simple instructions)
// ---------------------------------------------------------------------------

type ServerSupabase = Awaited<ReturnType<typeof getSupabaseServerClient>>;

const MEMORY_DISABLED_REPLY =
  'Memory is turned off, so I\'m not recalling or saving anything. Say "turn your memory back on" to resume using it.';

/** Plain-text streaming reply for memory command turns. */
function memoryReply(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

interface MemoryCommandOutcome {
  /** When set, the turn is answered directly (list / delete / disable / …). */
  response: Response | null;
  /** Stored fact to acknowledge inside the normal LLM reply. */
  saveAck: string | null;
  /** A secret was refused — the reply must explain without echoing it. */
  refusedSecret: boolean;
}

const NO_MEMORY_OUTCOME: MemoryCommandOutcome = {
  response: null,
  saveAck: null,
  refusedSecret: false,
};

/**
 * Executes deterministic memory commands. Returns null in `response` for
 * SAVE/UPDATE (the normal Gemini reply then acknowledges the stored fact) and
 * a direct text answer for LIST/DELETE/DISABLE — mirroring the real-time
 * branches so the chat client renders them as plain text.
 */
async function handleMemoryCommand(opts: {
  supabase: ServerSupabase;
  intent: MemoryIntentResult;
  message: string;
  client: GoogleGenAI;
  memoryEnabled: boolean;
}): Promise<MemoryCommandOutcome> {
  const { supabase, intent, message, client, memoryEnabled } = opts;

  if (intent.intent === "MEMORY_DISABLE") {
    const targetMode = intent.mode ?? "off";
    if (targetMode === "off" && !memoryEnabled) {
      return { ...NO_MEMORY_OUTCOME, response: memoryReply(MEMORY_DISABLED_REPLY) };
    }
    const ok = await setMemoryMode(supabase, targetMode === "on");
    if (!ok) {
      return {
        ...NO_MEMORY_OUTCOME,
        response: memoryReply("I couldn't update your memory setting just now. Please try again."),
      };
    }
    const reply =
      targetMode === "on"
        ? "Memory is back on — I'll keep using what you've told me from now on."
        : "Okay — I've turned your memory off. I won't remember anything new or recall stored facts until you turn it back on.";
    return { ...NO_MEMORY_OUTCOME, response: memoryReply(reply) };
  }

  if (intent.intent === "MEMORY_LIST") {
    if (!memoryEnabled) {
      return { ...NO_MEMORY_OUTCOME, response: memoryReply(MEMORY_DISABLED_REPLY) };
    }
    const memories = await listMemories(supabase, { enabledOnly: true });
    const summary = summarizeMemories(memories);
    const reply = summary
      ? `Here's what I remember about you:\n\n${summary.join(
          "\n\n"
        )}\n\nYou can say "forget about <topic>" to remove something, or "delete all your memories" to clear everything.`
      : 'I don\'t have any memories saved yet. Tell me something like "Remember that I prefer concise answers" and I\'ll keep it in mind.';
    return { ...NO_MEMORY_OUTCOME, response: memoryReply(reply) };
  }

  if (intent.intent === "MEMORY_DELETE") {
    if (!memoryEnabled) {
      return { ...NO_MEMORY_OUTCOME, response: memoryReply(MEMORY_DISABLED_REPLY) };
    }
    if (intent.target === "__all__") {
      const deleted = await deleteAllMemories(supabase);
      if (deleted === null) {
        return {
          ...NO_MEMORY_OUTCOME,
          response: memoryReply(
            "I wasn't able to clear your memories just now — nothing was deleted. Please try again."
          ),
        };
      }
      const reply =
        deleted === 0
          ? "There were no memories to delete."
          : `Done — I've forgotten everything (${deleted} ${deleted === 1 ? "memory" : "memories"}).`;
      return { ...NO_MEMORY_OUTCOME, response: memoryReply(reply) };
    }

    const owned = await listMemories(supabase);
    const targets = resolveDeleteTarget(owned, intent.target);
    if (targets.length === 0) {
      const shown = intent.target.slice(0, 80);
      return {
        ...NO_MEMORY_OUTCOME,
        response: memoryReply(`I couldn't find anything to forget about "${shown}".`),
      };
    }
    const deleted = await deleteMemory(supabase, targets);
    if (deleted === null) {
      return {
        ...NO_MEMORY_OUTCOME,
        response: memoryReply("The deletion didn't go through — nothing was removed. Please try again."),
      };
    }
    const reply =
      deleted === 0
        ? "That memory was already gone."
        : `Okay, I've forgotten ${deleted > 1 ? `those (${deleted}).` : "that."}`;
    return { ...NO_MEMORY_OUTCOME, response: memoryReply(reply) };
  }

  // ---- MEMORY_SAVE / MEMORY_UPDATE --------------------------------
  if (!memoryEnabled) {
    return { ...NO_MEMORY_OUTCOME, response: memoryReply(MEMORY_DISABLED_REPLY) };
  }

  const parsed = parseMemoryCandidate(message);
  let write: MemoryWrite | null = null;

  if (parsed.kind === "secret") {
    return { ...NO_MEMORY_OUTCOME, refusedSecret: true };
  }
  if (parsed.kind === "fact") {
    write = parsed.candidate;
  } else {
    // Deterministic verb-strip had nothing clean → Phase 4A LLM bridge. Runs
    // ONLY for an explicit save command, never for ordinary chat turns.
    const extraction = await extractMemory(client, message);
    if (extraction.kind === "refused-sensitive") {
      return { ...NO_MEMORY_OUTCOME, refusedSecret: true };
    }
    if (extraction.kind === "extracted") {
      const type = mapCategoryToType(extraction.memory.category);
      write = {
        key: buildDedupKey(type, extraction.memory.content),
        content: extraction.memory.content,
        type,
        source: "explicit",
        confidence: "high",
        importance: extraction.memory.importance,
        enabled: true,
      };
    }
  }

  if (!write) {
    // Nothing storable — the normal Gemini reply continues without an ack.
    console.log("[api/chat] memory save had no storable fact — continuing");
    return NO_MEMORY_OUTCOME;
  }

  const existing = await findMemoryByKey(supabase, write.key ?? "");
  const decision = evaluateSave({
    content: write.content,
    source: write.source ?? "explicit",
    existing,
    context: { memoryEnabled },
  });

  if (decision.action === "deny" && decision.reason === "secret") {
    return { ...NO_MEMORY_OUTCOME, refusedSecret: true };
  }
  if (decision.action === "deny" && decision.reason === "memory_disabled") {
    return { ...NO_MEMORY_OUTCOME, response: memoryReply(MEMORY_DISABLED_REPLY) };
  }
  // preserve_explicit (an inferred candidate guarding a stored explicit fact)
  // can't happen from a typed explicit chat command — continue normally.
  if (decision.action === "ask") {
    return { ...NO_MEMORY_OUTCOME, response: memoryReply(decision.message) };
  }

  const result = await upsertMemory(supabase, write);
  if (result.kind === "error") {
    console.error("[api/chat] Memory save failed — continuing without saving");
    return NO_MEMORY_OUTCOME;
  }
  return { ...NO_MEMORY_OUTCOME, saveAck: result.memory.content };
}

// ---------------------------------------------------------------------------
// Phase 6C — text→image response helpers
// ---------------------------------------------------------------------------

/** Last USER turn among prior turns (the refinement base for image edits). */
function lastPriorUserMessage(
  priorTurns: Array<{ role: "user" | "assistant"; content: string }>
): string | null {
  for (let i = priorTurns.length - 1; i >= 0; i -= 1) {
    if (priorTurns[i].role === "user") return priorTurns[i].content;
  }
  return null;
}

/**
 * Serializes an image outcome to a JSON image_message the chat client
 * understands (text stream paths are untouched). Raw image bytes travel as a
 * validated data URL; nothing internal (keys, provider detail on failure) is
 * ever included.
 */
function jsonImageResponse(outcome: ImageOutcome): Response {
  return new Response(
    JSON.stringify({
      type: "image_message",
      message: outcome.message,
...(outcome.kind === "image"
            ? {
                image: {
                  provider: outcome.image.provider,
                  mimeType: outcome.image.mimeType,
                  dataUrl: outcome.image.dataUrl,
                  width: outcome.image.width,
                  height: outcome.image.height,
                  fileSizeBytes: outcome.image.fileSizeBytes,
                  prompt: outcome.image.prompt,
                  ...(outcome.image.mode ? { mode: outcome.image.mode } : {}),
                  ...(outcome.image.editSourceKey
                    ? { editSourceKey: outcome.image.editSourceKey }
                    : {}),
                  ...(outcome.image.sourceGrounded !== undefined
                    ? { sourceGrounded: outcome.image.sourceGrounded }
                    : {}),
                  ...(outcome.image.visualType != null
                    ? { visualType: outcome.image.visualType }
                    : {}),
                },
              }
            : {}),
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}

/** Runs one image-generation turn and returns the JSON response. */
async function handleImageTurn(opts: {
  message: string;
  mode: string;
  priorTurns: Array<{ role: "user" | "assistant"; content: string }>;
  evidence: string | null;
  groundedRequired: boolean;
}): Promise<Response> {
  const startedAt = performance.now();
  const outcome = await generateImage({
    message: opts.message,
    mode: opts.mode,
    evidence: opts.evidence,
    groundedRequired: opts.groundedRequired,
    priorUserMessage: lastPriorUserMessage(opts.priorTurns),
  });
  console.log(
    `[api/chat] outcome=image kind=${outcome.kind} provider=${outcome.kind === "image" ? outcome.image.provider : "-"} elapsed=${Math.round(performance.now() - startedAt)}ms`
  );
  return jsonImageResponse(outcome);
}

/** Logs only non-sensitive diagnostics (error class + numeric status). */
function logGeminiFailure(error: unknown) {
  const name = error instanceof Error ? error.name : typeof error;
  const status = (error as { status?: unknown } | null)?.status;
  const statusLabel = typeof status === "number" ? `, status ${status}` : "";
  console.error(`[api/chat] Gemini request failed (${name}${statusLabel})`);
}

// ---------------------------------------------------------------------------
// Phase 6D — image-edit source decoding + response helpers
// ---------------------------------------------------------------------------

/** Max accepted source-image bytes (holds the entire decoded payload). */
const EDIT_SOURCE_MAX_BYTES = 10 * 1024 * 1024;

/** Decodes a client-sent `data:<mime>;base64,<bytes>` URL. Returns null when malformed. */
function decodeDataUrl(dataUrl: string): { bytes: Buffer; declaredMime: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;
  const declaredMime = (match[1] || "").trim();
  try {
    const bytes = Buffer.from(match[3], match[2] ? "base64" : "utf8");
    if (!bytes.length || bytes.length > EDIT_SOURCE_MAX_BYTES) return null;
    return { bytes, declaredMime };
  } catch {
    return null;
  }
}

/**
 * Validates a client-sent source image via magic bytes (MIME is re-sniffed,
 * never trusted from the client). Returns null when the bytes aren't a usable
 * image — the route must answer SAFE_EDIT_INVALID_SOURCE and never call a
 * provider.
 */
function validateSourceImage(dataUrl: string): { bytes: Buffer; mimeType: string } | null {
  const decoded = decodeDataUrl(dataUrl);
  if (!decoded) return null;
  const validation = validateImage(decoded.bytes, decoded.declaredMime, {
    maxImageSizeBytes: EDIT_SOURCE_MAX_BYTES,
    maxImageDimension: 10_000,
  });
  if (!validation.ok || !validation.mimeType) return null;
  return { bytes: decoded.bytes, mimeType: validation.mimeType };
}

/**
 * Runs one image-edit turn and returns the JSON response. Source resolution is
 * re-derived here (deterministic, same inputs as the router), the selected
 * image's validated bytes drive the edit service, and clarifications/no-image
 * cases answer with a SAFE_EDIT_* copy — never a provider call.
 */
async function handleImageEditTurn(opts: {
  message: string;
  mode: string;
  priorTurns: Array<{ role: "user" | "assistant"; content: string }>;
  evidence: string | null;
  groundedRequired: boolean;
  images: ImageContextRef[];
  /** Validated bytes for the client-attached source, keyed by sourceKey. */
  sourceBytes: { sourceKey: string; bytes: Buffer; mimeType: string } | null;
}): Promise<Response> {
  const intent = detectImageEditIntent(opts.message, opts.images);
  if (!intent.detected) {
    return jsonImageResponse({ kind: "message", message: SAFE_EDIT_UNAVAILABLE_MESSAGE });
  }

  if (intent.requiresClarification || !intent.selectionKey) {
    const message =
      opts.images.length === 0 ? SAFE_EDIT_NO_IMAGE_MESSAGE : SAFE_EDIT_CLARIFY_MESSAGE;
    return jsonImageResponse({ kind: "message", message });
  }

  // No usable source bytes at all (nothing sent, or magic-byte validation
  // failed): the honest answer is that the image could not be read — never
  // pass an unvalidated source to a provider.
  if (!opts.sourceBytes) {
    return jsonImageResponse({ kind: "message", message: SAFE_EDIT_INVALID_SOURCE_MESSAGE });
  }

  // Only the selected key's bytes may be used as the edit source.
  if (opts.sourceBytes.sourceKey !== intent.selectionKey) {
    return jsonImageResponse({ kind: "message", message: SAFE_EDIT_CLARIFY_MESSAGE });
  }

  const startedAt = performance.now();
  const outcome = await editImage({
    message: opts.message,
    mode: opts.mode,
    sourceImage: { bytes: opts.sourceBytes.bytes, mimeType: opts.sourceBytes.mimeType },
    evidence: opts.evidence,
    groundedRequired: opts.groundedRequired,
    priorUserMessage: lastPriorUserMessage(opts.priorTurns),
    kind: intent.requestKind ?? "edit",
    sourceKey: intent.selectionKey,
  });
  console.log(
    `[api/chat] outcome=image-edit kind=${outcome.kind} provider=${outcome.kind === "image" ? outcome.image.provider : "-"} elapsed=${Math.round(performance.now() - startedAt)}ms`
  );
  return jsonImageResponse(outcome);
}

/**
 * Runs one Phase 6E document-visual turn and returns the JSON response. The
 * service enforces the grounding gate (empty evidence → safe refusal), the
 * chart numeric gate, and the refinement claim guard; the route only supplies
 * bounded, verified evidence items plus the deterministic intent metadata.
 */
async function handleDocumentVisualTurn(opts: {
  message: string;
  mode: string;
  priorTurns: Array<{ role: "user" | "assistant"; content: string }>;
  evidence: DocumentVisualEvidenceItem[];
  visualType: DocumentVisualType | null;
  refinementOf: string | null;
}): Promise<Response> {
  const startedAt = performance.now();
  const outcome = await generateDocumentVisual({
    message: opts.message,
    mode: opts.mode,
    evidence: opts.evidence,
    requestedVisualType: opts.visualType,
    priorUserMessage: lastPriorUserMessage(opts.priorTurns),
    refinementOf: opts.refinementOf,
  });
  console.log(
    `[api/chat] outcome=document-visual kind=${outcome.kind} provider=${outcome.kind === "image" ? outcome.image.provider : "-"} type=${outcome.kind === "image" ? (outcome.image.visualType ?? "generic") : "-"} elapsed=${Math.round(performance.now() - startedAt)}ms`
  );
  return jsonImageResponse(outcome);
}

/** Parses Google's "Please retry in 12.3s" hint from 429/503 responses. */
function extractRetryMs(error: unknown): number | null {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return null;
  const match = message.match(/retry in ([\d.]+)\s*s/i);
  if (!match) return null;
  const seconds = Number.parseFloat(match[1]);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}

interface GeminiChunk {
  text?: string;
}

interface StreamMeta {
  model: string;
  attempts: number;
  /** ms from request start until the first text chunk arrived. */
  ttftMs: number;
}

interface ModelVariant {
  model: string;
  thinkingConfig?: { thinkingBudget: number };
}

/**
 * Opens a Gemini stream and reads ahead until the first text chunk, so empty
 * responses surface as proper error responses instead of silent 200 streams.
 *
 * Retry policy is latency-budgeted: quick blips retry immediately, while
 * quota/overload errors only wait when Google's own hint is short. Anything
 * longer escalates straight to the next model variant or fails fast with a
 * friendly error — never a minute-long stall.
 */
async function openStream(
  client: GoogleGenAI,
  baseParams: Parameters<typeof client.models.generateContentStream>[0],
  variant: ModelVariant,
  request: Request,
  meta: StreamMeta,
  maxAttempts: number
): Promise<AsyncGenerator<GeminiChunk, void, unknown> | null> {
  const params = { ...baseParams, ...variant } as typeof baseParams;
  let waitedMs = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    meta.attempts += 1;
    const startedAt = performance.now();
    try {
      const stream = await client.models.generateContentStream(params);
      const iterator = stream[Symbol.asyncIterator]();

      // Skip non-text chunks (e.g. thinking-only) while hunting for text.
      for (let scanned = 0; scanned < 40; scanned += 1) {
        const next = await iterator.next();
        if (next.done || request.signal.aborted) return null;
        const text = (next.value as GeminiChunk).text;
        if (text) {
          meta.model = variant.model;
          meta.ttftMs = Math.round(performance.now() - startedAt);
          // Re-yield the buffered chunk as the first item of a wrapped
          // iterator so no content is lost.
          return (async function* () {
            yield { text };
            for (;;) {
              const following = await iterator.next();
              if (following.done) return;
              yield following.value as GeminiChunk;
            }
          })();
        }
      }
      console.error("[api/chat] Gemini returned no text content");
      return null;
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      const retriable =
        error instanceof TypeError ||
        (typeof status === "number" &&
          [408, 429, 500, 502, 503].includes(status));
      if (!retriable || attempt === maxAttempts - 1 || request.signal.aborted)
        throw error;

      // Short blips: small fixed delay. Quota/overload: only wait when
      // Google's hint fits the latency budget, otherwise bail out early and
      // let the caller try the next model variant.
      let delayMs = 700;
      if (status === 429 || status === 503) {
        const hinted = extractRetryMs(error);
        if (hinted !== null && hinted > 3_000) throw error;
        delayMs = Math.min(hinted ?? 1_500, 3_000);
      }
      if (waitedMs + delayMs > MAX_TOTAL_WAIT_MS || request.signal.aborted)
        throw error;
      waitedMs += delayMs;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("unreachable");
}

/**
 * Walks a chain of model variants — primary model with thinking disabled
 * (fastest first token), then progressively more available fallbacks. Each
 * step draws from a different quota bucket where possible.
 */
async function openStreamResilient(
  client: GoogleGenAI,
  params: Parameters<typeof client.models.generateContentStream>[0],
  request: Request,
  meta: StreamMeta
): Promise<AsyncGenerator<GeminiChunk, void, unknown> | null> {
  const seen = new Set<string>();
  const chain = MODEL_CHAIN.filter((model) => {
    if (seen.has(model)) return false;
    seen.add(model);
    return true;
  }).map((model, index) =>
    index === 0
      ? ({ model, thinkingConfig: { thinkingBudget: THINKING_BUDGET } } satisfies ModelVariant)
      : { model } satisfies ModelVariant
  );

  let lastError: unknown;

  for (let index = 0; index < chain.length; index += 1) {
    const variant = chain[index];
    try {
      return await openStream(
        client,
        params,
        variant,
        request,
        meta,
        index === 0 ? MAX_ATTEMPTS : 2
      );
    } catch (error) {
      lastError = error;
      if (request.signal.aborted) throw error;
      console.error(
        `[api/chat] model ${variant.model} unavailable, trying next option. Error:`, error
      );
    }
  }
  throw lastError;
}

export async function POST(request: Request) {
  const t0 = performance.now();
  const timing = new TimingAccumulator();

  // Identity comes from the Supabase session cookies — anonymous callers are
  // rejected before touching the Gemini quota.
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return jsonError(401, "unauthorized");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    console.error("[api/chat] Rejected malformed request payload");
    return jsonError(400, "invalid_request");
  }

  const { messages, mode, context, images, editImage, uploadedImage, timezone } = parsed.data;

  // The assistant only ever answers the newest turn.
  if (messages[messages.length - 1].role !== "user") {
    return jsonError(400, "invalid_request");
  }

  // Phase 6D — image context for edit-vs-generate-vs-clarify routing.
  // Metadata only (keys, MIME, dims, prompts); the selected source's bytes
  // travel separately in `editImage`/`uploadedImage` and are byte-validated
  // below. A client-uploaded image joins the context as its own entry so a
  // single-image edit turn resolves to it deterministically.
  const imageContextRefs: ImageContextRef[] = (images ?? []).map((img, index) => ({
    key: img.key || `img-${index}`,
    provider: img.provider,
    mimeType: img.mimeType,
    prompt: img.prompt,
    width: img.width,
    height: img.height,
  }));
  if (uploadedImage) {
    imageContextRefs.push({
      key: "upload",
      mimeType: uploadedImage.mimeType,
    });
  }

  // ---- Phase 6B: central query router ------------------------------------
  // Deterministic decision layer over every capability (Phases 1–6A). It picks
  // WHICH existing pipeline runs and, for HYBRID turns (a strong, groundable
  // real-time intent behind an explicit document/visual reference with
  // attached sources), which branches must execute so Gemini fuses the
  // evidence. The router is pure (no LLM/network) and its `reason`/confidence
  // stay on the server — nothing internal reaches the client.
  const latestUserMessage = messages[messages.length - 1].content;
  const hasSources =
    Boolean(context?.documentId) ||
    (context?.sourceIds != null && context.sourceIds.length > 0);
  const sourceCount =
    context?.sourceIds != null && context.sourceIds.length > 0
      ? context.sourceIds.length
      : context?.documentId
        ? 1
        : 0;

  const routerDecision = routeQuery({
    userId: authUser.id,
    message: latestUserMessage,
    mode,
    hasSources,
    sourceCount,
    priorTurns: messages.slice(0, -1),
    images: imageContextRefs,
    subjectId: context?.subjectId,
    topicId: context?.topicId,
  });
  console.log(`[api/chat] route ${describeQueryRoute(routerDecision)}`);

  // ---- Phase 6C: text→image generation (driven by the router decision) ----
  const isImageGeneration = routerDecision.primaryRoute === "IMAGE_GENERATION";
  const imageGrounded = isImageGeneration && routerDecision.requiresDocuments;

  // ---- Phase 6D: reference-image editing (driven by the router decision) ----
  const isImageEdit = routerDecision.primaryRoute === "IMAGE_EDIT";
  const imageEditGrounded = isImageEdit && routerDecision.requiresDocuments;

  // ---- Phase 6E: document→visual generation (driven by the router decision) --
  const isDocumentVisual = routerDecision.primaryRoute === "DOCUMENT_VISUAL_GENERATION";
  // For a refinement turn the retrieval query should be the ORIGINAL document
  // visual ask, so the evidence still matches the mother request.
  const retrievalMessage =
    isDocumentVisual && routerDecision.documentVisualIntent?.refinementOf
      ? routerDecision.documentVisualIntent.refinementOf
      : latestUserMessage;

  // Validate the client-attached source bytes ONCE, up front, before any turn
  // runs. `editSourceBytes` carries the key so the edit handler can demand the
  // selected image's bytes specifically (never a different image's).
  const editSourceBytes =
    editImage && validateSourceImage(editImage.dataUrl)
      ? { sourceKey: editImage.sourceKey, ...validateSourceImage(editImage.dataUrl)! }
      : null;
  const uploadedBytes = uploadedImage ? validateSourceImage(uploadedImage.dataUrl) : null;
  const effectiveEditBytes = editSourceBytes
    ? editSourceBytes
    : uploadedBytes
      ? { sourceKey: "upload", ...uploadedBytes }
      : null;

  // Pure image turns (no document grounding) are answered immediately — no
  // real-time / domain / student / memory context is needed to render an image.
  if (isImageGeneration && !imageGrounded) {
    return await handleImageTurn({
      message: latestUserMessage,
      mode,
      priorTurns: messages.slice(0, -1),
      evidence: null,
      groundedRequired: false,
    });
  }

  // Pure edit turns too: no context blocks, and a clarification/no-image copy
  // replaces the need for any context-gathering. Never calls a provider when
  // the source cannot be resolved.
  if (isImageEdit && !imageEditGrounded) {
    return await handleImageEditTurn({
      message: latestUserMessage,
      mode,
      priorTurns: messages.slice(0, -1),
      evidence: null,
      groundedRequired: false,
      images: imageContextRefs,
      sourceBytes: effectiveEditBytes,
    });
  }

  // Pure document-visual turn WITHOUT any attached source: the grounding gate
  // fails before any provider call. Memory can never substitute for an
  // attached document, so the honest answer is the safe no-document copy.
  if (isDocumentVisual && !hasSources) {
    return jsonImageResponse({ kind: "message", message: SAFE_DOC_VISUAL_NO_DOC_MESSAGE });
  }

  // Grounded image/edit/visual turns still need document retrieval; declare the
  // capture points here so the agent blocks below can fill them before they run.
  let imageGroundingEvidence: string | null = null;
  let documentVisualEvidence: DocumentVisualEvidenceItem[] = [];

  // ---- Phase 6A: real-time execution (driven by the router decision) -----
  // Deterministic (no Gemini) for date/time, calculations, weather, and
  // currency. Document references always win — the router preserves 6A's
  // stand-down and only runs a real-time branch when the turn is genuinely a
  // direct real-time question (or a HYBRID turn). Every tool returns a
  // structured result grounded in the measured value (never invented); direct
  // answers never reach the upstream model for time-sensitive guesses.
  const isDirectRealtime =
    routerDecision.primaryRoute === "REALTIME_DATE" ||
    routerDecision.primaryRoute === "REALTIME_TIME" ||
    routerDecision.primaryRoute === "REALTIME_WEATHER" ||
    routerDecision.primaryRoute === "REALTIME_CURRENCY" ||
    routerDecision.primaryRoute === "CALCULATION";
  const isDirectDomain = routerDecision.primaryRoute === "DOMAIN_REALTIME";
  const isHybrid = routerDecision.primaryRoute === "HYBRID";

  // Non-null HYBRID holds the grounded real-time result to fuse into Gemini.
  let hybridRealtimeResult: import("@/lib/realtime").RealtimeToolResult | null = null;
  if ((isDirectRealtime || isHybrid) && routerDecision.realtimeDecision) {
    const result = await executeRealtimeTool({
      decision: routerDecision.realtimeDecision,
      message: latestUserMessage,
      userId: authUser.id,
    });

    console.log(
      `[api/chat] outcome=realtime intent=${result.intent} tool=${result.tool} ok=${result.success} elapsed=${Math.round(performance.now() - t0)}ms`
    );

    if (isDirectRealtime) {
      return new Response(result.answer, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    }
    hybridRealtimeResult = result;
  }

  // ---- Phase 6B Extended: domain advisory (driven by the router decision) ---
  // A domain turn (agriculture / marine / aviation / smart-city / travel /
  // outdoor) resolves location+timeframe from context and runs the
  // deterministic advisory pipeline (Open-Meteo / Marine). Results are
  // direct plain-text answers — like the 6A trivia, never sent to the model.
  let hybridDomainResult: import("@/lib/realtime").DomainToolResult | null = null;
  if ((isDirectDomain || isHybrid) && routerDecision.domainDecision) {
    const domainResult = await resolveDomainContext(
      routerDecision.domainDecision,
      messages.slice(0, -1)
    );
    // A HYBRID turn (document + domain) is answered from the attached source.
    // The live domain tool only runs when a location resolves; without one the
    // model answers from the document instead of receiving a location prompt.
    const domainOutcome =
      isDirectDomain || Boolean(domainResult.location)
        ? await executeDomainTool({
            decision: domainResult,
            userId: authUser.id,
          })
        : null;

    if (domainOutcome) {
      console.log(
        `[api/chat] outcome=domain domain=${domainOutcome.domain} ok=${domainOutcome.success} elapsed=${Math.round(performance.now() - t0)}ms`
      );

      if (isDirectDomain) {
        // A compound/multi-sentence query may carry related domains ("at Delhi
        // airport and is heavy rainfall expected tonight?" → primary
        // AVIATION + related SMART_CITY). Serve each as its own deterministic
        // advisory, sharing the resolved location/timeframe. If the primary
        // could not run (e.g. location_required) the user is asked once.
        if (!domainOutcome.success) {
          return new Response(domainOutcome.answer, {
            status: 200,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Accel-Buffering": "no",
            },
          });
        }
        const answers = [domainOutcome.answer];
        for (const related of domainResult.relatedDomains ?? []) {
          if (related.domain === domainOutcome.domain) continue;
          const relatedDecision = domainResult.location
            ? { ...related, location: domainResult.location, locationInherited: true }
            : related;
          const relatedOutcome = await executeDomainTool({
            decision: relatedDecision,
            userId: authUser.id,
          });
          if (!relatedOutcome.success) continue;
          console.log(
            `[api/chat] outcome=domain domain=${relatedOutcome.domain} ok=${relatedOutcome.success} elapsed=${Math.round(performance.now() - t0)}ms`
          );
          answers.push(relatedOutcome.answer);
        }
        return new Response(answers.join("\n\n---\n\n"), {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          },
        });
      }
      hybridDomainResult = domainOutcome;
    }
  }

  const client = getGeminiClient();
  const supabase = await getSupabaseServerClient();

  // ---- Phase 6G: tasks + planning (driven by the router decision) --------
  // Deterministic task/planning commands run BEFORE the Gemini pipeline (and
  // even before the Gemini key guard): "remind me to call mom at 9pm", "show
  // my tasks", "create a study plan for my physics exam" are answered directly
  // and honestly, never sent to the model, and never blocked when the image
  // fast-paths or a missing key would otherwise own the turn.
  if (routerDecision.primaryRoute === "TASK_MANAGEMENT" || routerDecision.primaryRoute === "TASK_QUERY" || routerDecision.primaryRoute === "PLAN_GENERATION") {
    const outcome = await handleTaskCommand({
      supabase,
      taskIntent: routerDecision.taskIntent,
      planIntent: routerDecision.planIntent,
      message: latestUserMessage,
      timezone,
    });
    console.log(
      `[api/chat] outcome=tasks primaryRoute=${routerDecision.primaryRoute} elapsed=${Math.round(performance.now() - t0)}ms`
    );
    return new Response(outcome, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  }

  if (!client && !isImageGeneration && !isImageEdit && !isDocumentVisual) {
    console.error("[api/chat] GEMINI_API_KEY is missing on the server");
    return jsonError(500, "server_misconfigured");
  }

  // ---- Phase 4A: personal profile + long-term memory --------------------
  // ---- Phase 4B: academic context (subjects/topics/knowledge) -----------
  // Every query runs through the session-authenticated server client, so
  // RLS scopes results to this user regardless of anything in the payload.

  // Image turns render an image, not conversational prose — profile/memory/
  // planner context is irrelevant to them, and the memory extraction would
  // spend the Gemini text model before the image request even starts.
  let savedMemoryContent: string | null = null;
  let refusedSensitive = false;
  const studentNotes: string[] = [];
  const memorySections: string[] = [];
  const meta: StreamMeta = { model: "-", attempts: 0, ttftMs: -1 };

  if (!isImageGeneration && !isImageEdit && !isDocumentVisual) {
    // Phase 6F: the per-user master switch gates recall AND extraction.
    const memoryEnabled = await isMemoryEnabled(supabase);

    // Phase 6F: deterministic memory commands run BEFORE the normal pipeline —
    // "remember …" / "what do you know about me" / "forget …" never touch the
    // image/realtime/document branches and never spend the Gemini text model.
    const commandOutcome = await handleMemoryCommand({
      supabase,
      intent: detectMemoryIntent(latestUserMessage),
      message: latestUserMessage,
      client: client as GoogleGenAI,
      memoryEnabled,
    });
    if (commandOutcome.response) return commandOutcome.response;
    if (commandOutcome.saveAck) savedMemoryContent = commandOutcome.saveAck;
    if (commandOutcome.refusedSecret) refusedSensitive = true;

    const [userMemories, userProfile, academicContext, plannerContext, productivityContext] =
      await Promise.all([
        // Phase 6F: relevance-ranked typed memories (bounded, enabled only).
        memoryEnabled
          ? retrieveRelevantMemories(supabase, latestUserMessage)
          : Promise.resolve<$UserMemory[]>([]),
        fetchProfileForContext(supabase),
        fetchChatAcademicContext(supabase, context),
        // Phase 4C: bounded exam/plan/session/goal context for study questions.
        fetchPlannerChatContext(supabase, toDateOnly(new Date())).catch(() => null),
        // Phase 4D: bounded productivity context (score, streak, next action).
        fetchProductivityChatContext(supabase, toDateOnly(new Date())).catch(() => null),
      ]);

    // Phase 4B weakness signals: explicit phrases like "I don't understand X"
    // nudge the matched topic's confidence down. Regex-only (no model call) and
    // only when a real, owned topic confidently matches — never auto-creates.
    if (academicContext.scanTopics.length > 0) {
      const signal = detectWeaknessSignal(
        latestUserMessage,
        academicContext.scanTopics
      );
      if (signal) {
        console.error("[api/chat] Weakness signal recorded for an owned topic");
        await applyWeaknessSignal(supabase, signal);
        studentNotes.push(
          `WEAKNESS SIGNAL: The user just said they don't understand or struggle with "${signal.topicName}". ` +
            "Treat it as a confirmed weak area in this reply — start simpler than usual, use a concrete example, and offer a small practice step."
        );
      }
    }

    const contextBlock = buildMemoryContextBlock(
      userMemories,
      userProfile,
      latestUserMessage
    );
    if (contextBlock) memorySections.push(contextBlock);

    // Phase 4B: bounded academic context (profile fields, subjects, weak/strong
    // topics, selected subject/topic + practice record).
    const studentBlock = buildStudentContextBlock(academicContext, studentNotes);
    if (studentBlock) memorySections.push(studentBlock);

    // Phase 4C: exams / active plan / today's sessions / study goals. Fail-open:
    // planner fetch problems never block a chat reply.
    if (plannerContext) {
      const plannerBlock = buildPlannerChatBlock(plannerContext);
      if (plannerBlock) memorySections.push(plannerBlock);
    }

    // Phase 4D: productivity context (score, streak, recommendation). Fail-open.
    if (productivityContext) {
      const productivityBlock = buildProductivityChatBlock(productivityContext);
      if (productivityBlock) memorySections.push(productivityBlock);
    }
  }

  // Phase 5A: Agentic context retrieval.
  // Collects all sources (from sourceIds + legacy documentId), runs the agent
  // router, retrieves evidence, and injects grounding instructions. Fail-open:
  // retrieval problems never block a normal chat reply.
  const agentSources: AgentSource[] = [];

  // Phase 5E-2: Visual evidence loaded during retrieval, used when constructing
  // multimodal Gemini content. Declared here so it survives the nested try blocks.
  let multimodalEvidence: import("@/lib/agent").MultimodalEvidence | null = null;

  // Resolve sourceIds to AgentSource objects.
  // Documents with non-ready status are auto-processed on the fly so that
  // freshly uploaded + attached documents work immediately in chat.
  timing.start("sourceResolution");
  if (context?.sourceIds && context.sourceIds.length > 0) {
    for (const sourceId of context.sourceIds) {
      // Check documents table first (L2 cached for 30s)
      const docCacheKey = `${authUser.id}:${sourceId}`;
      let doc: { id: string; name: string; original_filename: string; processing_status: string } | undefined =
        documentStatusCache.get(docCacheKey) as typeof doc;

      if (!doc) {
        const { data: docRow } = await supabase
          .from("documents")
          .select("id, name, original_filename, processing_status")
          .eq("id", sourceId)
          .eq("user_id", authUser.id)
          .maybeSingle();

        if (docRow) {
          doc = {
            id: docRow.id,
            name: docRow.name,
            original_filename: docRow.original_filename,
            processing_status: docRow.processing_status,
          };
          documentStatusCache.set(docCacheKey, { status: doc.processing_status, extractedLength: null });
        }
      }

      if (doc) {
        // Auto-process if not yet ready
        if (doc.processing_status !== "ready") {
          console.log(
            `[api/chat] auto-processing document ${doc.id} (status=${doc.processing_status})`
          );
          const proc = await processDocument(doc.id, authUser.id);
          // Invalidate status cache after processing
          documentStatusCache.delete(docCacheKey);
          if (!proc.ok) {
            console.error(
              `[api/chat] auto-processing failed for ${doc.id}: ${proc.error}`
            );
            // Source failed — include it so grounding can report the failure
            agentSources.push({
              id: doc.id,
              type: "document",
              name: doc.original_filename || doc.name,
              metadata: { processingError: proc.error },
            });
            continue;
          }
          console.log(
            `[api/chat] auto-processing result for ${doc.id}: ok=${proc.ok} chunks=${proc.chunkCount} chars=${proc.extractedLength}`
          );
        }

        // Re-fetch the doc status after potential processing
        const { data: freshDoc } = await supabase
          .from("documents")
          .select("id, name, original_filename, processing_status, extracted_text_length")
          .eq("id", sourceId)
          .eq("user_id", authUser.id)
          .maybeSingle();

        if (freshDoc && freshDoc.processing_status === "ready") {
          documentStatusCache.set(docCacheKey, { status: "ready", extractedLength: freshDoc.extracted_text_length });
          console.log(
            `[api/chat] source resolved: ${freshDoc.id} status=ready textLength=${freshDoc.extracted_text_length ?? 0}`
          );
          agentSources.push({
            id: freshDoc.id,
            type: "document",
            name: freshDoc.original_filename || freshDoc.name,
          });
          continue;
        }

        // Document still not ready after processing attempt — include it
        // with error metadata so grounding can tell the user what happened
        const finalStatus = freshDoc?.processing_status ?? "missing";
        console.error(
          `[api/chat] source not ready: ${doc.id} finalStatus=${finalStatus}`
        );
        agentSources.push({
          id: doc.id,
          type: "document",
          name: doc.original_filename || doc.name,
          metadata: {
            processingError: `Document processing status: ${finalStatus}. Please retry from the Documents page.`,
          },
        });
        continue;
      }

      // Check context_sources table (pasted text, images)
      const { data: cs } = await supabase
        .from("context_sources")
        .select("id, type, name, content_text")
        .eq("id", sourceId)
        .eq("user_id", authUser.id)
        .maybeSingle();

      if (cs) {
        agentSources.push({
          id: cs.id,
          type: cs.type as AgentSource["type"],
          name: cs.name || (cs.type === "pasted_text" ? "Pasted notes" : "Image"),
          content: cs.content_text ?? undefined,
        });
      }
    }
  }
  timing.end("sourceResolution");

  // Legacy documentId support: if only documentId is provided (no sourceIds)
  if (agentSources.length === 0 && context?.documentId) {
    try {
      const retrieval = await retrieveDocumentChunks({
        documentId: context.documentId,
        userId: authUser.id,
        question: retrievalMessage,
      });
      if (retrieval && retrieval.chunks.length > 0) {
        const chunksText = formatRetrievalContext(retrieval);
        // Phase 6C/6D: grounded images/edits reuse the same verified passages
        // as the text answer — the service refuses to fabricate from nothing.
        if (isImageGeneration || isImageEdit) imageGroundingEvidence = chunksText;
        // Phase 6E: document visuals consume the SAME passages as structured,
        // bounded evidence items (never raw dumps in the provider prompt).
        if (isDocumentVisual) {
          documentVisualEvidence = retrieval.chunks.map((chunk) => ({
            sourceName: retrieval.documentName,
            page: chunk.pageNumber ?? null,
            text: chunk.text,
            relevance: chunk.score ?? null,
          }));
        }
        const groundingBlock = buildDocumentGroundingInstruction(
          retrieval.documentName,
          chunksText,
          retrieval.originalFilename
        );
        memorySections.push(groundingBlock);
      } else {
        memorySections.push(
          `DOCUMENT GROUNDING RULES\n\nThe user selected a document, but no relevant content could be retrieved for their question. Respond naturally, but if the user asks about the document specifically, explain that you could not find relevant information in the selected document.`
        );
      }
    } catch {
      console.error("[api/chat] Document retrieval failed, continuing without document context");
    }
  } else if (agentSources.length > 0) {
    // New agent pipeline: route decision → retrieve → ground
    try {
      const decision = routeDecision({
        userId: authUser.id,
        message: isDocumentVisual ? retrievalMessage : latestUserMessage,
        sources: agentSources,
        mode,
        subjectId: context?.subjectId,
        topicId: context?.topicId,
      });

      console.log(
        `[api/chat] agent action=${decision.action} reason="${decision.reason}" sources=${agentSources.length}`
      );

      if (decision.action === "retrieve_context") {
        let results: import("@/lib/agent").RetrievalResult[];
        let multiSourceAnalysis: {
          strategy: MultiSourceIntent;
          conflicts: Array<{ topic: string; sources: Array<{ sourceId: string; sourceName: string; evidence: string }> }>;
          sourceCount: number;
        } | null = null;

        timing.start("retrieval");
        if (agentSources.length > 1) {
          // Phase 5D: multi-source orchestration
          const multiResult = await orchestrateMultiSourceRetrieval(
            isDocumentVisual ? retrievalMessage : latestUserMessage,
            agentSources,
            authUser.id
          );
          results = multiResult.results;
          multiSourceAnalysis = {
            strategy: multiResult.analysis.intent.strategy,
            conflicts: multiResult.analysis.conflicts,
            sourceCount: multiResult.analysis.readySourceCount,
          };
        } else {
          // Single source: existing retrieval
          results = await retrieveAgentContext(
            {
              query: isDocumentVisual ? retrievalMessage : latestUserMessage,
              sources: agentSources,
            },
            authUser.id
          );
        }

        timing.end("retrieval");
        const bestScore = results[0]?.score ?? 0;
        console.log(
          `[api/chat] retrieval chunks=${results.length} bestScore=${bestScore}`
        );

        // Phase 5E-2: VISUAL RETRIEVAL IS AN INDEPENDENT EVIDENCE CHANNEL.
        // Visual intent detection + visual_assets loading run REGARDLESS of the
        // text-retrieval outcome. A zero-result text retrieval (e.g. scanned or
        // image-heavy document) must NOT prevent visual evidence from loading.
        let visualIntent: ReturnType<typeof detectVisualIntent> | null = null;
        let visualContextForGrounding: {
          hasVisualEvidence: boolean;
          assetTypes: string[];
          partialFailure: boolean;
        } | undefined;

        if (agentSources.length > 0) {
          const detected = detectVisualIntent(latestUserMessage);
          if (detected.type !== "none") {
            visualIntent = detected;
            const sourceNameMap = new Map(
              agentSources.map((s) => [s.id, s.name])
            );
            timing.start("visualEvidence");
            multimodalEvidence = await loadVisualEvidence(
              detected,
              agentSources.map((s) => s.id),
              authUser.id,
              sourceNameMap
            );
            timing.end("visualEvidence");

            if (multimodalEvidence.visuals.length > 0) {
              visualContextForGrounding = {
                hasVisualEvidence: true,
                assetTypes: [
                  ...new Set(multimodalEvidence.visuals.map((v) => v.assetType)),
                ],
                partialFailure: multimodalEvidence.partialFailure,
              };
              console.log(
                `[api/chat] visual evidence loaded: %d assets, types=[%s]`,
                multimodalEvidence.visuals.length,
                visualContextForGrounding.assetTypes.join(", ")
              );
            }

            if (multimodalEvidence.errors.length > 0) {
              console.warn(
                "[api/chat] visual evidence errors: %s",
                multimodalEvidence.errors.join("; ")
              );
            }

            // Grounding note: says which images are attached (or that none
            // matched), so the model never invents or substitutes visuals.
            memorySections.push(
              buildVisualEvidenceNote(detected, multimodalEvidence)
            );
          }
        }

        if (results.length > 0) {
          // Group by source for the grounding instruction
          const bySource = new Map<string, { sourceName: string; sourceType: string; passages: string[] }>();
          for (const r of results) {
            const existing = bySource.get(r.sourceId);
            if (existing) {
              existing.passages.push(r.content);
            } else {
              bySource.set(r.sourceId, {
                sourceName: r.sourceName,
                sourceType: r.sourceType,
                passages: [r.content],
              });
            }
          }

          const evidenceBlocks = Array.from(bySource.values()).map((g) => ({
            sourceName: g.sourceName,
            sourceType: g.sourceType,
            passagesText: g.passages
              .map((p, i) => `[Passage ${i + 1}]:\n${p}`)
              .join("\n\n"),
          }));

          // Phase 6C/6D: grounded images/edits reuse the same verified
          // passages as the text grounding — the service refuses to fabricate
          // from nothing.
          if (isImageGeneration || isImageEdit) {
            imageGroundingEvidence = evidenceBlocks
              .map((g) => g.passagesText)
              .join("\n\n");
          }

          // Phase 6E: document visuals consume the SAME verified passages as
          // structured, bounded evidence items — retrieval MUST happen before
          // generation, and the provider never sees raw retrieval dumps.
          if (isDocumentVisual) {
            documentVisualEvidence = results.map((r) => {
              const page =
                r.metadata && typeof r.metadata.pageNumber === "number"
                  ? r.metadata.pageNumber
                  : r.metadata && typeof r.metadata.page === "number"
                    ? r.metadata.page
                    : null;
              return {
                sourceId: r.sourceId,
                sourceName: r.sourceName,
                page,
                text: r.content,
                relevance: r.score,
              };
            });
          }

          // Phase 5D.1: Extract structural match from the first result's metadata
          const firstResultMeta = results[0]?.metadata;
          const structuralMatch = (firstResultMeta && typeof firstResultMeta === "object" && "structuralMatch" in firstResultMeta)
            ? firstResultMeta.structuralMatch as "exact_match" | "partial_match" | "no_match"
            : undefined;

          const groundingBlock = buildGroundingInstruction(
            evidenceBlocks,
            multiSourceAnalysis ?? undefined,
            structuralMatch,
            visualContextForGrounding
          );
          if (groundingBlock) memorySections.push(groundingBlock);
        } else {
          // No text retrieval results. If usable VISUAL evidence was loaded,
          // the document is still answerable from its visuals — do NOT tell the
          // user the document "could not be processed" in that case.
          if (
            visualIntent &&
            multimodalEvidence &&
            multimodalEvidence.visuals.length > 0
          ) {
            console.log(
              "[api/chat] text retrieval empty but visual evidence available: %d assets",
              multimodalEvidence.visuals.length
            );
          } else {
            const errorSources = agentSources.filter(
              (s) => s.metadata && "processingError" in s.metadata && s.metadata.processingError
            );

            if (errorSources.length > 0) {
              // Sources attached but processing failed — tell the user
              const errorDetails = errorSources
                .map((s) => `"${s.name}": ${String(s.metadata?.processingError)}`)
                .join("; ");
              memorySections.push(
                `DOCUMENT GROUNDING RULES\n\nThe user attached source(s), but processing failed: ${errorDetails}\n\n` +
                "Respond by explaining that the document could not be processed and suggest the user retry from the Documents page. " +
                "Do NOT claim the document was never provided."
              );
            } else {
              const sourceNames = agentSources.map((s) => s.name);
              memorySections.push(buildNoResultsGrounding(sourceNames));
            }
          }
        }
      }
    } catch {
      console.error("[api/chat] Agent retrieval failed, continuing without context");
    }
  }

  // Phase 6C/6D: document-grounded images and edits have now had every
  // retrieval path populate `imageGroundingEvidence`. Generate/edit from the
  // verified passages, or let the service refuse safely when no evidence could
  // be retrieved.
  if (isImageGeneration) {
    return await handleImageTurn({
      message: latestUserMessage,
      mode,
      priorTurns: messages.slice(0, -1),
      evidence: imageGroundingEvidence,
      groundedRequired: true,
    });
  }

  if (isImageEdit) {
    return await handleImageEditTurn({
      message: latestUserMessage,
      mode,
      priorTurns: messages.slice(0, -1),
      evidence: imageGroundingEvidence,
      groundedRequired: true,
      images: imageContextRefs,
      sourceBytes: effectiveEditBytes,
    });
  }

  // Phase 6E: document→visual generation is now grounded — every retrieval
  // path above populated `documentVisualEvidence` from verified passages. The
  // service refuses safely when evidence is empty, when a chart request has no
  // numerical data, or when a refinement introduces unsupported facts.
  if (isDocumentVisual) {
    return await handleDocumentVisualTurn({
      message: latestUserMessage,
      mode,
      priorTurns: messages.slice(0, -1),
      evidence: documentVisualEvidence,
      visualType: routerDecision.documentVisualIntent?.visualType ?? null,
      refinementOf: routerDecision.documentVisualIntent?.refinementOf ?? null,
    });
  }

  if (savedMemoryContent) {
    memorySections.push(
      `The user JUST asked you to remember: "${savedMemoryContent}". It has been stored. Start your reply with a brief, natural acknowledgement (e.g. "Got it — I'll remember that.") tailored to what was remembered, then answer their message normally.`
    );
  } else if (refusedSensitive) {
    memorySections.push(
      "The user asked you to remember something that contains sensitive credentials (a password, API key, token, PIN, or similar secret). Nothing was stored and nothing must ever be stored. In ONE short sentence, politely explain you don't keep secrets safe and suggest a password manager — do NOT repeat any part of the secret — then address the rest of their message."
    );
  }
  // Programming intent detection: when the user asks for code, inject strong
  // programming-specific rules into the system prompt. Non-code questions are
  // unaffected — the detection is purely additive.
  const programmingIntent = detectProgrammingIntent(latestUserMessage);
  if (programmingIntent.detected) {
    memorySections.push(
      buildProgrammingInstruction(programmingIntent.language)
    );
  }

  // Phase 6B: HYBRID fusion — the real-time tool result is injected verbatim
  // (so the Gemini explanation can never invent the date/rate/temperature), on
  // top of the document/visual evidence gathered above. If the tool failed,
  // the grounding block says so and Gemini explains the failure honestly.
  if (hybridRealtimeResult) {
    memorySections.push(buildRealtimeSystemInstruction(hybridRealtimeResult));
  }
  // Phase 6B Extended: same grounding for a domain advisory fused into a
  // HYBRID explanation (e.g. comparing a PDF's farming guidance with the
  // live forecast) — every measurement stays verbatim from the provider.
  if (hybridDomainResult) {
    memorySections.push(buildDomainSystemInstruction(hybridDomainResult));
  }

  const systemInstruction = [buildSystemInstruction(mode), ...memorySections]
    .filter(Boolean)
    .join("\n\n");

  try {
    const iterator = await openStreamResilient(
      client as GoogleGenAI,
      {
        model: MODEL_CHAIN[0],
        // Compact context: recent turns only, each bounded — enough memory
        // for natural conversation without bloating every request. Programming
        // content is code-heavy so the ceiling is raised to 12k per message.
        // Phase 5E-2: Last user message includes visual evidence as inline image parts.
        contents: messages.map((message, index) => {
          const isLastUserMessage =
            index === messages.length - 1 && message.role === "user";
          const textPart = {
            text: message.content.slice(0, 12_000),
          };

          if (
            isLastUserMessage &&
            multimodalEvidence &&
            multimodalEvidence.visuals.length > 0
          ) {
            const imageParts = buildGeminiImageParts(
              multimodalEvidence.visuals
            );
            return {
              role: "user",
              parts: [textPart, ...imageParts],
            };
          }

          return {
            role: message.role === "assistant" ? "model" : "user",
            parts: [textPart],
          };
        }),
        config: {
          systemInstruction,
          // Prevent silent truncation of long code responses. 16k tokens is
          // enough for a full program + explanation without hitting the default
          // (often 4k) ceiling that silently clips the end of a code block.
          maxOutputTokens: 16_384,
          // Cancelled by the SDK when the client disconnects (Stop button).
          abortSignal: request.signal,
        },
      },
      request,
      meta
    );

    if (!iterator) {
      console.error(
        `[api/chat] outcome=empty model=${meta.model} attempts=${meta.attempts} elapsed=${Math.round(performance.now() - t0)}ms`
      );
      if (request.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      return jsonError(502, "empty_response");
    }

    const encoder = new TextEncoder();
    let bytesOut = 0;

    const readable = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            timing.flush("chat");
            console.log(
              `[api/chat] outcome=ok model=${meta.model} attempts=${meta.attempts} ttft=${meta.ttftMs}ms total=${Math.round(performance.now() - t0)}ms bytes≈${bytesOut}`
            );
            return;
          }
          if (next.value.text) {
            const encoded = encoder.encode(next.value.text);
            bytesOut += encoded.byteLength;
            controller.enqueue(encoded);
          }
        } catch (error) {
          if (!request.signal.aborted) logGeminiFailure(error);
          // End the stream quietly; the client keeps whatever was received.
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        void iterator.return?.(undefined);
      },
    });

    request.signal.addEventListener(
      "abort",
      () => {
        console.error(
          `[api/chat] outcome=aborted model=${meta.model} ttft=${meta.ttftMs}ms elapsed=${Math.round(performance.now() - t0)}ms bytes≈${bytesOut}`
        );
      },
      { once: true }
    );

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "X-Spidey-Agent-Action": "retrieved",
      },
    });
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    logGeminiFailure(error);
    const status = (error as { status?: unknown } | null)?.status;
    const code =
      status === 429 || status === 503 ? "rate_limited" : "upstream_error";
    console.error(
      `[api/chat] outcome=error code=${code} model=${meta.model} attempts=${meta.attempts} elapsed=${Math.round(performance.now() - t0)}ms`
    );
    return jsonError(502, code);
  }
}
