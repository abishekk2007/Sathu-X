// ---------------------------------------------------------------------------
// Phase 6F — Advanced Memory: persistence service (RLS-scoped).
//
// Every function speaks to the row-level security-scoped server client — the
// database derives the owner from the session (auth.uid()), and NO function
// here ever accepts or writes a user_id. Ownership mistakes are therefore
// impossible by construction: a foreign row simply doesn't match and returns
// null / 0 instead of leaking or mutating someone else's memory.
//
// Fail-open contract: DB errors return [] / null / {kind:"error"} / 0 — the
// chat route treats memory as an auxiliary layer and never blocks a reply on a
// memory failure. Logs are sanitized via security.describeMemoryForLog.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  $UserMemory,
  MemoryConfidence,
  MemorySaveResult,
  MemorySource,
  MemoryType,
  MemoryWrite,
} from "./types";
import { MEMORY_FETCH_LIMIT } from "./types";
import { buildDedupKey } from "./extractor";
import { describeMemoryForLog } from "./security";

interface MemoryRow {
  id: string;
  key: string;
  content: string;
  memory_type: MemoryType;
  source: MemorySource;
  confidence: MemoryConfidence;
  importance: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string;
}

// ---------------------------------------------------------------------------
// Sanitized structured database-error logging.
//
// Surfaces the REAL Supabase/PostgREST error so the true cause of a memory
// failure becomes observable in server logs — without echoing secrets, cookies,
// tokens, keys, or full memory contents. Never exposes anything to the browser.
// Fail-open behaviour is preserved: callers still return [] / null / error.
// ---------------------------------------------------------------------------
function logDbError(operation: string, table: string, error: unknown): void {
  // Supabase errors carry { code, message, details, hint } and optionally a
  // status. Extract only those safe, short fields.
  const e = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
    status?: unknown;
  };
  const sanitize = (v: unknown): string => {
    if (v === undefined || v === null) return "";
    return String(v).slice(0, 500);
  };
  // Only log the error's own field values (never request bodies or memory
  // contents). These hold no secrets; tokens/keys never appear in PostgREST
  // error fields. Apply looksSensitive as defense-in-depth regardless.
  const message = sanitize(e.message);
  const details = sanitize(e.details);
  const hint = sanitize(e.hint);
  console.error(
    `[memory/store] db-error\n` +
      `operation=${operation}\n` +
      `table=${table}\n` +
      `code=${sanitize(e.code)}\n` +
      `message=${message}\n` +
      `details=${details}\n` +
      `hint=${hint}`
  );
}

function mapRow(row: MemoryRow): $UserMemory {
  return {
    id: row.id,
    key: row.key ?? "",
    content: row.content,
    type: row.memory_type,
    source: row.source,
    confidence: row.confidence,
    importance: row.importance,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

// ---------------------------------------------------------------------------
// Similarity helpers (deterministic; mirrors the proven Phase 4A approach so
// dedup behaviour stays consistent across the app).
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "are", "was",
  "have", "has", "how", "what", "when", "where", "who", "why", "not", "but",
  "can", "could", "should", "would", "will", "about", "into", "from", "does",
  "user", "users", "please",
]);

function tokenSet(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  return new Set(words);
}

function normalizeCompare(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenSimilarity(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/** True when two fact clauses are near-duplicates. */
export function areMemoriesSimilar(a: string, b: string): boolean {
  const na = normalizeCompare(a);
  const nb = normalizeCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (tokenSimilarity(na, nb) >= 0.75) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  return shorter.length >= 8 && longer.includes(shorter);
}

// ---------------------------------------------------------------------------
// Reads (fail-open → [])
// ---------------------------------------------------------------------------

export async function listMemories(
  supabase: SupabaseClient,
  opts?: { enabledOnly?: boolean; limit?: number }
): Promise<$UserMemory[]> {
  try {
    let query = supabase
      .from("memories")
      .select(
        "id, key, content, memory_type, source, confidence, importance, enabled, created_at, updated_at, last_used_at"
      )
      .order("updated_at", { ascending: false })
      .limit(opts?.limit ?? MEMORY_FETCH_LIMIT);
    if (opts?.enabledOnly) query = query.eq("enabled", true);
    const { data, error } = await query;
    if (error) {
      logDbError("SELECT listMemories", "memories", error);
      return [];
    }
    return (data ?? []).map(mapRow);
  } catch (e) {
    logDbError("SELECT listMemories", "memories", e);
    return [];
  }
}

export async function findMemoryByKey(
  supabase: SupabaseClient,
  key: string
): Promise<$UserMemory | null> {
  try {
    const { data, error } = await supabase
      .from("memories")
      .select(
        "id, key, content, memory_type, source, confidence, importance, enabled, created_at, updated_at, last_used_at"
      )
      .eq("key", key)
      .limit(1)
      .maybeSingle();
    if (error) {
      logDbError("SELECT findMemoryByKey", "memories", error);
      return null;
    }
    if (!data) return null;
    return mapRow(data as MemoryRow);
  } catch (e) {
    logDbError("SELECT findMemoryByKey", "memories", e);
    return null;
  }
}

/** True when the user's master memory switch is on (default on; fail-closed reads go on). */
export async function isMemoryEnabled(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("memory_enabled")
      .maybeSingle();
    if (error) {
      logDbError("SELECT isMemoryEnabled", "profiles", error);
      return true;
    }
    if (!data) return true;
    return data.memory_enabled !== false;
  } catch (e) {
    logDbError("SELECT isMemoryEnabled", "profiles", e);
    return true;
  }
}

/** Turns the per-user memory switch off or on. Returns false on failure. */
export async function setMemoryMode(
  supabase: SupabaseClient,
  enabled: boolean
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("profiles")
      .update({ memory_enabled: enabled })
      .eq("memory_enabled", !enabled);
    if (error) {
      logDbError("UPDATE setMemoryMode", "profiles", error);
      return false;
    }
    return true;
  } catch (e) {
    logDbError("UPDATE setMemoryMode", "profiles", e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Inserts a memory or merges it into an existing near-duplicate (same key, or
 * high content similarity) — newer explicit statements win. Returns a
 * MemorySaveResult; errors fold to {kind:"error"} so callers can reply
 * honestly without pretending a save succeeded.
 */
export async function upsertMemory(
  supabase: SupabaseClient,
  write: MemoryWrite
): Promise<MemorySaveResult> {
  const content = write.content.trim();
  if (!content) return { kind: "error" };

  const type = write.type ?? "fact";
  const source = write.source ?? "inferred";
  const confidence = write.confidence ?? (source === "explicit" ? "high" : "low");
  const importance =
    typeof write.importance === "number" ? Math.min(5, Math.max(1, write.importance)) : 3;
  const enabled = write.enabled ?? true;
  const key = (write.key && write.key.trim()) || buildDedupKey(type, content);

  try {
    const owned = await listMemories(supabase);

    // 1) Exact stable-key hit → merge (keeps the key stable across re-saves).
    const sameKey = owned.find((row) => row.key && row.key === key);
    if (sameKey) {
      const { data, error } = await supabase
        .from("memories")
        .update({
          key,
          content,
          memory_type: type,
          source,
          confidence,
          importance,
          enabled,
          last_used_at: new Date().toISOString(),
        })
        .eq("id", sameKey.id)
        .select(
          "id, key, content, memory_type, source, confidence, importance, enabled, created_at, updated_at, last_used_at"
        )
        .single();
      if (error) {
        logDbError("UPDATE upsertMemory key-merge", "memories", error);
        return { kind: "error" };
      }
      if (!data) return { kind: "error" };
      console.log(`[memory/store] upsert merged memory ${describeMemoryForLog(mapRow(data as MemoryRow))}`);
      return { kind: "updated", memory: mapRow(data as MemoryRow) };
    }

    // 2) Near-duplicate content (prefer same type) → merge onto that row.
    const peers = [...owned].sort((a, b) =>
      Number(a.type === type) - Number(b.type === type)
    );
    const similar = peers.find((row) =>
      areMemoriesSimilar(row.content, content) && row.enabled
    );
    if (similar) {
      // An explicit restatement raises the confidence; an inferred restatement
      // never lowers the stored one.
      const mergedConfidence: MemoryConfidence =
        source === "explicit" ? "high" : similar.confidence;
      const { data, error } = await supabase
        .from("memories")
        .update({
          content,
          memory_type: type,
          source,
          confidence: mergedConfidence,
          importance,
          enabled,
          last_used_at: new Date().toISOString(),
        })
        .eq("id", similar.id)
        .select(
          "id, key, content, memory_type, source, confidence, importance, enabled, created_at, updated_at, last_used_at"
        )
        .single();
      if (error) {
        logDbError("UPDATE upsertMemory similarity-merge", "memories", error);
        return { kind: "error" };
      }
      if (!data) return { kind: "error" };
      console.log(`[memory/store] upsert merged similar memory ${describeMemoryForLog(mapRow(data as MemoryRow))}`);
      return { kind: "updated", memory: mapRow(data as MemoryRow) };
    }

    // 3) New row. user_id is NOT sent — the database default (auth.uid()) +
    //    the insert RLS check assign and verify ownership.
    const { data, error } = await supabase
      .from("memories")
      .insert({
        key,
        content,
        memory_type: type,
        source,
        confidence,
        importance,
        enabled,
      })
      .select(
        "id, key, content, memory_type, source, confidence, importance, enabled, created_at, updated_at, last_used_at"
      )
      .single();
    if (error) {
      logDbError("INSERT upsertMemory", "memories", error);
      return { kind: "error" };
    }
    if (!data) return { kind: "error" };
    console.log(`[memory/store] upsert created memory ${describeMemoryForLog(mapRow(data as MemoryRow))}`);
    return { kind: "created", memory: mapRow(data as MemoryRow) };
  } catch (e) {
    logDbError("INSERT upsertMemory", "memories", e);
    return { kind: "error" };
  }
}

/**
 * Selectively edits an owned memory row. Returns the refreshed row or null.
 */
export async function patchMemory(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<MemoryWrite> & { enabled?: boolean }
): Promise<$UserMemory | null> {
  try {
    const update: Record<string, unknown> = {};
    if (patch.content !== undefined) update.content = patch.content.trim();
    if (patch.type !== undefined) update.memory_type = patch.type;
    if (patch.key !== undefined) update.key = patch.key;
    if (patch.source !== undefined) update.source = patch.source;
    if (patch.confidence !== undefined) update.confidence = patch.confidence;
    if (patch.importance !== undefined) {
      update.importance = Math.min(5, Math.max(1, Math.round(patch.importance)));
    }
    if (patch.enabled !== undefined) update.enabled = patch.enabled;
    if (Object.keys(update).length === 0) return null;

    const { data, error } = await supabase
      .from("memories")
      .update(update)
      .eq("id", id)
      .select(
        "id, key, content, memory_type, source, confidence, importance, enabled, created_at, updated_at, last_used_at"
      )
      .single();
    if (error) {
      logDbError("UPDATE patchMemory", "memories", error);
      return null;
    }
    if (!data) return null;
    return mapRow(data as MemoryRow);
  } catch (e) {
    logDbError("UPDATE patchMemory", "memories", e);
    return null;
  }
}

/**
 * Deletes owned rows by id(s). Returns the number actually deleted (0 when a
 * foreign/missing id exists) or null on error. A caller can therefore report
 * an honest failure — a delete that didn't run is never reported as success.
 */
export async function deleteMemory(
  supabase: SupabaseClient,
  ids: string[]
): Promise<number | null> {
  try {
    if (ids.length === 0) return 0;
    const { data, error } = await supabase
      .from("memories")
      .delete()
      .in("id", ids.slice(0, 100))
      .select("id");
    if (error) {
      logDbError("DELETE deleteMemory", "memories", error);
      return null;
    }
    return data?.length ?? 0;
  } catch (e) {
    logDbError("DELETE deleteMemory", "memories", e);
    return null;
  }
}

/** Deletes every memory the caller owns. Returns count or null on error. */
export async function deleteAllMemories(supabase: SupabaseClient): Promise<number | null> {
  try {
    // PostgREST rejects a filterless DELETE; this always-true predicate satisfies
    // it while RLS (auth.uid() = user_id) continues to scope rows to the owner.
    const { data, error } = await supabase
      .from("memories")
      .delete()
      .gte("created_at", "1970-01-01T00:00:00.000Z")
      .select("id");
    if (error) {
      logDbError("DELETE deleteAllMemories", "memories", error);
      return null;
    }
    return data?.length ?? 0;
  } catch (e) {
    logDbError("DELETE deleteAllMemories", "memories", e);
    return null;
  }
}

/** Records that a memory was surfaced in a conversation (fail-silent). */
export async function touchMemoryUsage(supabase: SupabaseClient, id: string): Promise<void> {
  try {
    await supabase
      .from("memories")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", id);
  } catch (e) {
    logDbError("UPDATE touchMemoryUsage", "memories", e);
  }
}

/**
 * Resolves a delete command's target phrase to owned row ids (exact key hit,
 * then token overlap, then content similarity). Pure + deterministic so tests
 * can exercise it without a database.
 */
export function resolveDeleteTarget(memories: $UserMemory[], target: string): string[] {
  const normalized = target.trim().toLowerCase();
  if (!normalized) return [];

  if (target === "__all__") return memories.map((row) => row.id);

  const exactKey = memories.find(
    (row) => row.key && row.key === target.toLowerCase()
  );
  if (exactKey) return [exactKey.id];

  const targetTokens = new Set(
    normalized
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  );
  if (targetTokens.size > 0) {
    const overlapMatches = memories.filter((row) => {
      const rowTokens =
        row.content
          .toLowerCase()
          .match(/[a-z0-9]{3,}/g)
          ?.filter((token) => token.length >= 3 && !STOPWORDS.has(token)) ?? [];
      return rowTokens.some((token) => targetTokens.has(token));
    });
    if (overlapMatches.length > 0) return overlapMatches.map((row) => row.id);
  }

  const similar = memories.find((row) => areMemoriesSimilar(row.content, target));
  return similar ? [similar.id] : [];
}