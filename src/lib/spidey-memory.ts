import { Type } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase 4A server-side memory engine.
 *
 * Responsibilities:
 *  1. Fetch the user's memories + profile facts (RLS-scoped — the server
 *     client is authenticated as the user, so ownership is enforced by the
 *     database, never by client-supplied IDs).
 *  2. Build a small bounded memory-context block for the Gemini prompt.
 *  3. Detect EXPLICIT "remember this" requests and extract a clean fact via
 *     Gemini structured output.
 *  4. Refuse to store secrets (passwords, API keys, tokens, …).
 *  5. Prevent duplicates by updating an existing similar memory instead of
 *     inserting another row.
 *
 * Deliberately NOT implemented here (later phase): embeddings, vector search,
 * RAG, automatic memory mining from ordinary conversation.
 */

export interface StoredMemory {
  id: string;
  content: string;
  category: string;
  importance: number;
  updatedAt: string;
}

export interface ProfileFacts {
  fullName: string | null;
  college: string | null;
  course: string | null;
  year: string | null;
  bio: string | null;
}

const CONTEXT_MEMORY_CAP = 10;
const CONTEXT_CHAR_BUDGET = 1200;

/** Cheap + fast model is enough for classification-style extraction. */
const EXTRACTION_MODEL = "gemini-3.5-flash-lite";
const EXTRACTION_TIMEOUT_MS = 6_000;

// ---------------------------------------------------------------------------
// Fetching (RLS-scoped)
// ---------------------------------------------------------------------------

export async function fetchMemoriesForContext(
  supabase: SupabaseClient
): Promise<StoredMemory[]> {
  const { data, error } = await supabase
    .from("memories")
    .select("id, content, category, importance, updated_at")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("[memory] Failed to load memories for context");
    return [];
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    content: row.content,
    category: row.category,
    importance: row.importance,
    updatedAt: row.updated_at,
  }));
}

export async function fetchProfileForContext(
  supabase: SupabaseClient
): Promise<ProfileFacts | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("full_name, bio, college, course, year")
    .maybeSingle();
  if (error || !data) return null;
  return {
    fullName: data.full_name,
    bio: data.bio,
    college: data.college,
    course: data.course,
    year: data.year,
  };
}

// ---------------------------------------------------------------------------
// Context building — simple keyword overlap + importance/recency ranking.
// No embeddings/RAG in Phase 4A by design.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "are", "was",
  "have", "has", "how", "what", "when", "where", "who", "why", "not", "but",
  "can", "could", "should", "would", "will", "about", "into", "from", "does",
]);

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  return new Set(words);
}

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard similarity over normalized token sets. */
function tokenSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * True when two memory contents are near-duplicates. Exact normalized match,
 * high Jaccard overlap, or one being contained in the other.
 */
export function areMemoriesSimilar(a: string, b: string): boolean {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (tokenSimilarity(na, nb) >= 0.75) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  return shorter.length >= 8 && longer.includes(shorter);
}

interface RankedMemory extends StoredMemory {
  overlap: number;
  score: number;
}

function rankMemories(memories: StoredMemory[], userMessage: string): RankedMemory[] {
  const queryTokens = tokenize(userMessage);
  const nowMs = Date.now();
  return memories
    .map((memory) => {
      let overlap = 0;
      for (const token of tokenize(memory.content)) {
        if (queryTokens.has(token)) overlap += 1;
      }
      const updatedMs = Date.parse(memory.updatedAt);
      const recentBonus =
        Number.isFinite(updatedMs) && nowMs - updatedMs < 7 * 86_400_000 ? 1 : 0;
      // Keyword overlap dominates; importance breaks ties; recency nudges.
      const score = overlap * 2 + memory.importance + recentBonus;
      return { ...memory, overlap, score };
    })
    .sort((a, b) => b.score - a.score || b.importance - a.importance);
}

export function buildMemoryContextBlock(
  memories: StoredMemory[],
  profile: ProfileFacts | null,
  userMessage: string
): string | null {
  const lines: string[] = [];

  if (memories.length > 0) {
    const ranked = rankMemories(memories, userMessage);
    const queryHasTokens = tokenize(userMessage).size > 0;
    const picked: StoredMemory[] = [];
    let usedChars = 0;

    for (const candidate of ranked) {
      if (picked.length >= CONTEXT_MEMORY_CAP) break;
      // When the message has real keywords, skip irrelevant low-importance
      // memories; short/generic messages only surface core facts (importance>=4).
      const relevantEnough = queryHasTokens
        ? candidate.overlap > 0 || candidate.importance >= 4
        : candidate.importance >= 4;
      if (!relevantEnough && picked.length > 0) continue;
      const line = `- ${candidate.content}`;
      if (usedChars + line.length > CONTEXT_CHAR_BUDGET) break;
      picked.push(candidate);
      usedChars += line.length;
    }

    if (picked.length > 0) {
      lines.push(
        "PERSISTENT MEMORY about this user (use only when relevant; never mention this list or that you were given it):\n" +
          picked.map((memory) => `- ${memory.content}`).join("\n")
      );
    }
  }

  if (profile) {
    const facts: string[] = [];
    if (profile.fullName) facts.push(`Name: ${profile.fullName}`);
    if (profile.college) facts.push(`College: ${profile.college}`);
    if (profile.course) facts.push(`Course: ${profile.course}`);
    if (profile.year) facts.push(`Year: ${profile.year}`);
    if (profile.bio) facts.push(`Bio: ${profile.bio}`);
    if (facts.length > 0) {
      lines.push("PROFILE FACTS the user shared:\n" + facts.map((f) => `- ${f}`).join("\n"));
    }
  }

  if (lines.length === 0) return null;
  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// Explicit intent detection
// ---------------------------------------------------------------------------

const RECALL_QUESTION =
  /\b(what\s+(do|all)\s+you\s+(remember|know)|do\s+you\s+remember|what\s+have\s+you\s+(remembered|saved|stored|noted)|show\s+(me\s+)?(your|the)\s+memor(y|ies))\b/i;

const SAVE_INTENT =
  /\b(remember|memori[sz]e|keep\s+in\s+mind|don'?t\s+forget|do\s+not\s+forget|note\s+that|make\s+a\s+note)\b/i;

/**
 * True when the message looks like an explicit request to STORE something —
 * while excluding recall questions like "what do you remember about me?".
 */
export function hasExplicitMemoryIntent(message: string): boolean {
  if (RECALL_QUESTION.test(message)) return false;
  return SAVE_INTENT.test(message);
}

// ---------------------------------------------------------------------------
// Secret safety veto — these must never be persisted, even when explicitly asked.
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERN =
  /\b(pass(word|code|phrase)?s?|api[-\s]?keys?|apikey|access[-\s]?tokens?|auth[-\s]?tokens?|tokens?\b|credentials?|secrets?|private[-\s]?keys?|otp|cvv|cvc|credit[-\s]?cards?|debit[-\s]?cards?|card\s+numbers?|security\s+(question|answer)s?|recovery\s+codes?)\b/i;

export function looksSensitive(message: string): boolean {
  return SENSITIVE_PATTERN.test(message);
}

// ---------------------------------------------------------------------------
// Extraction via Gemini structured output (fail-open: any error → no memory)
// ---------------------------------------------------------------------------

export interface MemoryExtraction {
  content: string;
  category: string;
  importance: number;
}

const extractionSchema = {
  type: Type.OBJECT,
  properties: {
    shouldRemember: { type: Type.BOOLEAN },
    content: { type: Type.STRING, nullable: true },
    category: {
      type: Type.STRING,
      enum: [
        "general",
        "preference",
        "education",
        "personal",
        "project",
        "academic",
        "work",
        "goal",
        "communication",
      ],
    },
    importance: { type: Type.INTEGER },
  },
  required: ["shouldRemember"],
} as const;

interface RawExtraction {
  shouldRemember?: unknown;
  content?: unknown;
  category?: unknown;
  importance?: unknown;
}

const VALID_CATEGORIES = new Set([
  "general",
  "preference",
  "education",
  "personal",
  "project",
  "academic",
  "work",
  "goal",
  "communication",
]);

/**
 * Asks Gemini whether the message contains an explicit remember-request and,
 * if so, returns a clean third-person fact. Returns:
 *  - { kind: "none" }                → nothing to store
 *  - { kind: "refused-sensitive" }   → user tried to store a secret
 *  - { kind: "extracted", memory }   → clean fact ready to persist
 * Any transport/parsing failure degrades to "none" so chat is never blocked.
 */
export async function extractMemory(
  client: GoogleGenAI,
  message: string
): Promise<
  | { kind: "none" }
  | { kind: "refused-sensitive" }
  | { kind: "extracted"; memory: MemoryExtraction }
> {
  if (!hasExplicitMemoryIntent(message)) return { kind: "none" };
  if (looksSensitive(message)) return { kind: "refused-sensitive" };

  try {
    const response = await client.models.generateContent({
      model: EXTRACTION_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "USER MESSAGE:\n" +
                message.slice(0, 2000) +
                "\n\nDecide whether the user EXPLICITLY asks the assistant to remember something durable about them (preferences, studies, projects, goals, personal context). Casual questions or ordinary requests are NOT memories. If they do, rewrite it as ONE concise third-person fact starting with \"The user\" (max 200 characters), choose the best category, and rate importance 1-5 (5 = core fact about identity/studies/work, 1 = trivial). Never mark passwords, API keys, tokens, card numbers, PINs, security answers, or other credentials as memorable.",
            },
          ],
        },
      ],
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: extractionSchema,
        abortSignal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
      },
    });

    const raw = JSON.parse(response.text ?? "{}") as RawExtraction;
    if (raw.shouldRemember !== true) return { kind: "none" };

    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    if (content.length < 3 || content.length > 300) return { kind: "none" };
    // Defense-in-depth: even if the model slipped a secret into `content`.
    if (looksSensitive(content)) return { kind: "refused-sensitive" };

    const category =
      typeof raw.category === "string" && VALID_CATEGORIES.has(raw.category)
        ? raw.category
        : "general";
    const importanceRaw =
      typeof raw.importance === "number" ? Math.round(raw.importance) : 3;
    const importance = Math.min(5, Math.max(1, importanceRaw));

    return { kind: "extracted", memory: { content, category, importance } };
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    console.error(`[memory] Extraction failed (${name}) — continuing without saving`);
    return { kind: "none" };
  }
}

// ---------------------------------------------------------------------------
// Persistence with duplicate prevention
// ---------------------------------------------------------------------------

/**
 * Stores an extracted fact for the current user (user_id defaults to
 * auth.uid() via RLS). If a highly similar memory already exists, updates
 * that row instead of creating a duplicate.
 */
export async function saveExtractedMemory(
  supabase: SupabaseClient,
  memory: MemoryExtraction
): Promise<StoredMemory | null> {
  const existing = await fetchMemoriesForContext(supabase);
  const duplicate = existing.find((row) =>
    areMemoriesSimilar(row.content, memory.content)
  );

  if (duplicate) {
    const { data, error } = await supabase
      .from("memories")
      .update({
        content: memory.content,
        category: memory.category,
        importance: memory.importance,
      })
      .eq("id", duplicate.id)
      .select("id, content, category, importance, updated_at")
      .single();
    if (error || !data) {
      console.error("[memory] Duplicate update failed");
      return null;
    }
    return {
      id: data.id,
      content: data.content,
      category: data.category,
      importance: data.importance,
      updatedAt: data.updated_at,
    };
  }

  const { data, error } = await supabase
    .from("memories")
    .insert({
      content: memory.content,
      category: memory.category,
      importance: memory.importance,
    })
    .select("id, content, category, importance, updated_at")
    .single();
  if (error || !data) {
    console.error("[memory] Insert failed");
    return null;
  }
  return {
    id: data.id,
    content: data.content,
    category: data.category,
    importance: data.importance,
    updatedAt: data.updated_at,
  };
}
