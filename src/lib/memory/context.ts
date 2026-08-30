// ---------------------------------------------------------------------------
// Phase 6F — Advanced Memory: bounded prompt context block.
//
// Turns the ranked typed memories + profile facts into a compact structured
// block for Gemini. Guarantees:
//   * at most MAX_MEMORIES_PER_REQUEST memories
//   * content within MEMORY_CONTEXT_CHAR_BUDGET characters
//   * never leaks ids, keys, timestamps, source or confidence fields
//   * never surfaces secret-looking values (defense-in-depth redaction)
//   * invisible when there is nothing worth showing (returns null)
// ---------------------------------------------------------------------------

import type { $UserMemory, MemoryType } from "./types";
import { MEMORY_CONTEXT_CHAR_BUDGET, MAX_MEMORIES_PER_REQUEST, MEMORY_TYPE_LABELS } from "./types";
import type { ProfileFacts } from "../spidey-memory";
import { looksSensitive } from "./security";

const CORE_IMPORTANCE = 4;

/**
 * Builds the memory context block for the current user. `memories` should be
 * the retrieval-ranked subset (already enabled + capped); extra safety caps
 * are re-applied here regardless.
 */
export function buildMemoryContextBlock(
  memories: $UserMemory[],
  profile: ProfileFacts | null,
  _userMessage: string
): string | null {
  const lines: string[] = [];

  const usable = memories
    .filter((row) => row.enabled && !looksSensitive(row.content))
    .slice(0, MAX_MEMORIES_PER_REQUEST);

  if (usable.length > 0) {
    const sections: string[] = [];
    let usedChars = 0;
    for (const memory of usable) {
      const label = MEMORY_TYPE_LABELS[memory.type]?.label ?? "Fact";
      const line = `- ${label}: ${memory.content}`;
      if (usedChars + line.length > MEMORY_CONTEXT_CHAR_BUDGET) break;
      sections.push(line);
      usedChars += line.length;
    }
    if (sections.length > 0) {
      lines.push(
        "PERSISTENT MEMORY about this user (use only when relevant; never mention this list or that you were given it):\n" +
          sections.join("\n")
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

  return lines.length > 0 ? lines.join("\n\n") : null;
}

/**
 * A balanced, honest summary line set for the MEMORY_LIST reply. Returns null
 * when there is nothing to show. Never includes ids/keys/timestamps.
 */
export function summarizeMemories(memories: $UserMemory[]): string[] | null {
  const visible = memories
    .filter((row) => row.enabled && !looksSensitive(row.content))
    .slice(0, 100);
  if (visible.length === 0) return null;

  const byType = new Map<MemoryType, string[]>();
  for (const row of visible) {
    const bucket = byType.get(row.type) ?? [];
    bucket.push(row.content);
    byType.set(row.type, bucket);
  }

  const lines: string[] = [];
  for (const type of Object.keys(MEMORY_TYPE_LABELS) as MemoryType[]) {
    const bucket = byType.get(type);
    if (!bucket || bucket.length === 0) continue;
    const label = MEMORY_TYPE_LABELS[type].label;
    const items = bucket
      .slice(0, 15)
      .map((content) => (content.length > 120 ? `${content.slice(0, 117)}…` : content));
    const truncated = bucket.length > items.length;
    const suffix = truncated ? ` (and ${bucket.length - items.length} more)` : "";
    lines.push(`• ${label}${suffix}:\n  ${items.join("\n  ")}`);
  }
  return lines.length > 0 ? lines : null;
}

export { CORE_IMPORTANCE };