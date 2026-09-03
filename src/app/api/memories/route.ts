import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import {
  buildDedupKey,
  deleteAllMemories,
  listMemories,
  looksSensitive,
  mapCategoryToType,
  screenMemoryCandidate,
  upsertMemory,
} from "@/lib/memory";
import type { $UserMemory, MemoryType } from "@/lib/memory";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const LEGACY_CATEGORIES = [
  "general",
  "preference",
  "education",
  "personal",
  "project",
  "academic",
  "work",
  "goal",
  "communication",
] as const;

const MEMORY_TYPES = [
  "preference",
  "profile",
  "project",
  "workflow",
  "instruction",
  "fact",
  "goal",
] as const;

const memoryBodySchema = z
  .object({
    content: z.string().trim().min(1).max(500),
    category: z.enum(LEGACY_CATEGORIES).optional(),
    importance: z.coerce.number().int().min(1).max(5).optional(),
    // Phase 6F typed model — all optional for backward compatibility.
    type: z.enum(MEMORY_TYPES).optional(),
    key: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9:_-]+$/)
      .optional(),
    enabled: z.boolean().optional(),
    source: z.enum(["explicit", "inferred"]).optional(),
    confidence: z.enum(["high", "medium", "low"]).optional(),
  })
  .refine((value) => Object.prototype.hasOwnProperty.call(value, "content"), {
    message: "content is required",
  });

function serializeTypedMemory(memory: $UserMemory) {
  return {
    id: memory.id,
    content: memory.content,
    category: memory.type === "profile" ? "personal" : memory.type === "fact" ? "general" : memory.type,
    type: memory.type,
    key: memory.key || null,
    importance: memory.importance,
    source: memory.source,
    confidence: memory.confidence,
    enabled: memory.enabled,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    lastUsedAt: memory.lastUsedAt,
  };
}

export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  const typeParam = url.searchParams.get("type");
  const search = url.searchParams.get("search")?.trim() ?? "";
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw >= 1 && limitRaw <= 200 ? limitRaw : 200;

  if (category !== null && !LEGACY_CATEGORIES.includes(category as (typeof LEGACY_CATEGORIES)[number])) {
    return jsonError(400, "invalid_request");
  }
  if (typeParam !== null && !MEMORY_TYPES.includes(typeParam as (typeof MEMORY_TYPES)[number])) {
    return jsonError(400, "invalid_request");
  }

  try {
    const supabase = await getSupabaseServerClient();
    const memories = await listMemories(supabase, { limit });
    let filtered = memories;
    if (typeParam) filtered = filtered.filter((row) => row.type === typeParam);
    if (category) {
      const target = mapCategoryToType(category);
      filtered = filtered.filter((row) => row.type === target);
    }
    if (search) {
      filtered = filtered.filter((row) =>
        row.content.toLowerCase().includes(search.toLowerCase())
      );
    }
    return Response.json({ memories: filtered.map(serializeTypedMemory) });
  } catch {
    console.error("[api/memories] GET crashed");
    return jsonError(500, "server_error");
  }
}

export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }

  const parsed = memoryBodySchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");
  const { content, category, importance, type, key, enabled, source, confidence } = parsed.data;

  // Systems rule: credentials are never stored, even through the API.
  if (looksSensitive(content)) {
    return jsonError(400, "secrets_not_allowed");
  }

  // Phase 8D — the deterministic candidate gate protects EVERY write path.
  // Raw coordinates and bulk conversation dumps are deliberately not storable.
  const screened = screenMemoryCandidate(content);
  if (screened.verdict === "raw_location") {
    return Response.json(
      { error: "raw_location_not_allowed" },
      { status: 400 }
    );
  }
  if (screened.verdict === "conversation_dump") {
    return Response.json(
      { error: "conversation_dump_not_allowed" },
      { status: 400 }
    );
  }

  const memoryType: MemoryType = type ?? mapCategoryToType(category ?? "general");
  const finalKey = key ?? buildDedupKey(memoryType, content);

  try {
    const supabase = await getSupabaseServerClient();
    // user_id is never accepted from the client — RLS assigns the owner from
    // the authenticated session. Dedup happens inside the store: exact key
    // merge, then near-duplicate content merge.
    const result = await upsertMemory(supabase, {
      key: finalKey,
      content,
      type: memoryType,
      source: source ?? "explicit",
      confidence: confidence ?? (source === "inferred" ? "low" : "high"),
      importance: importance ?? 3,
      enabled: enabled ?? true,
    });

    if (result.kind === "error") {
      return jsonError(500, "server_error");
    }
    return Response.json(
      { memory: serializeTypedMemory(result.memory), updatedExisting: result.kind === "updated" },
      { status: result.kind === "created" ? 201 : 200 }
    );
  } catch {
    console.error("[api/memories] POST crashed");
    return jsonError(500, "server_error");
  }
}

/** Deletes ALL memories belonging to the caller. UI must confirm first. */
export async function DELETE() {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  try {
    const supabase = await getSupabaseServerClient();
    const deleted = await deleteAllMemories(supabase);
    if (deleted === null) {
      console.error("[api/memories] Bulk delete failed");
      return jsonError(500, "server_error");
    }
    return Response.json({ deleted });
  } catch {
    console.error("[api/memories] DELETE crashed");
    return jsonError(500, "server_error");
  }
}