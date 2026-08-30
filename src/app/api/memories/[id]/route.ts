import { z } from "zod";

import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";
import { deleteMemory, patchMemory } from "@/lib/memory";
import type { $UserMemory } from "@/lib/memory";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchSchema = z
  .object({
    content: z.string().trim().min(1).max(500).optional(),
    category: z
      .enum([
        "general",
        "preference",
        "education",
        "personal",
        "project",
        "academic",
        "work",
        "goal",
        "communication",
      ])
      .optional(),
    importance: z.coerce.number().int().min(1).max(5).optional(),
    // Phase 6F typed fields — all optional.
    type: z
      .enum([
        "preference",
        "profile",
        "project",
        "workflow",
        "instruction",
        "fact",
        "goal",
      ])
      .optional(),
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
  .refine((value) => Object.keys(value).length > 0, { message: "empty" });

interface RouteContext {
  params: Promise<{ id: string }>;
}

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

/**
 * Per-memory operations. RLS guarantees only the owner's rows match; a
 * foreign ID is indistinguishable from a missing one — both yield 404.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");

  try {
    const supabase = await getSupabaseServerClient();
    const updated = await patchMemory(supabase, id, {
      content: parsed.data.content,
      type: parsed.data.type,
      key: parsed.data.key,
      importance: parsed.data.importance,
      enabled: parsed.data.enabled,
      source: parsed.data.source,
      confidence: parsed.data.confidence,
    });

    if (!updated) {
      console.error("[api/memories/:id] PATCH found no owned row");
      return jsonError(404, "not_found");
    }
    return Response.json({ memory: serializeTypedMemory(updated) });
  } catch {
    console.error("[api/memories/:id] PATCH crashed");
    return jsonError(500, "server_error");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return jsonError(404, "not_found");

  try {
    const supabase = await getSupabaseServerClient();
    const deleted = await deleteMemory(supabase, [id]);
    if (deleted === null) {
      console.error("[api/memories/:id] DELETE failed");
      return jsonError(500, "server_error");
    }
    // Zero rows deleted → either never existed or belongs to someone else.
    if (deleted === 0) return jsonError(404, "not_found");
    return Response.json({ deleted });
  } catch {
    console.error("[api/memories/:id] DELETE crashed");
    return jsonError(500, "server_error");
  }
}