// ---------------------------------------------------------------------------
// Phase 6F — Advanced Memory: deterministic command intent detection.
//
// No LLM, no network, no third-party call: a handful of ordered regex gates map
// a message onto one of the memory intents. Ordering matters — DISABLE and
// DELETE-ALL are matched before single-target DELETE, and the ambiguity guards
// keep everyday questions ("do you remember where the keys are?") off the
// memory pipeline entirely. Ambiguous self-referential recall that merely
// *mentions* memory stays MEMORY_NONE so the normal chat pipeline answers.
// ---------------------------------------------------------------------------

import type { MemoryIntentResult } from "./types";

/** Explicit "store this" phrases. Must not collide with recall. */
const SAVE_TRIGGERS =
  /\b(remember|memori[sz]e|memorize\sthat|keep\s+in\s+mind|don'?t\s+forget|do\s+not\s+forget|never\s+forget|note\s+that|make\s+a\s+note|take\s+a\s+note|note\s+down|save\s+this|store\s+this)\b/i;

/** Re-assert / correct an existing memory ("update what you remember…"). */
const UPDATE_TRIGGERS =
  /\b(update|correct|change|fix|revise)\s+(what|your|the).*(remember|memor|note|fact|preference)|(update|correct|change|fix|revise)\s+(my|the|that)\s*(memory|memor|fact|preference|goal|project)\b/i;

/** Self-referential recall: the user is inspecting what WE know about them. */
const LIST_TRIGGERS =
  /\b(what\s+(do|all|else)\s+you\s+(remember|know|have|saved|stored|noted)|show\s+(me\s+)?everything\s+you\s+(have\s+)?(stored|saved|remembered|got)|show\s+(me\s+)?(your|the|all)\s+(memor[a-z]*|notes|saved\s+things)|list\s+(your|the|all|my)\s+(memor[a-z]*|notes|saved\s+preferences|preferences|goals|facts)|display\s+(your|the|all\s+)?memor[a-z]*|view\s+(your|the)\s+memor[a-z]*|what\s+have\s+you\s+(remembered|saved|stored|noted|got)|tell\s+me\s+what\s+you\s+(remember|know)\s+about\s+me|recap\s+(what\s+)?you\s+(remember|know)|recall\s+(what\s+)?you\s+(remember|know)\s+about\s+me|go\s+through\s+your\s+memor[a-z]*)\b/i;

/** Master-switch control ("stop remembering anything"). */
const DISABLE_TRIGGERS =
  /\b(stop\s+remembering|turn\s+off\s+(your\s+)?(memor[a-z]*|remembering)|disable\s+(your\s+)?(memor[a-z]*|remembering)|pause\s+(your\s+)?(memor[a-z]*|remembering)|switch\s+off\s+(your\s+)?(memor[a-z]*|remembering)|shut\s+down\s+(your\s+)?memory|don'?t\s+memorize\s+anything|do\s+not\s+memorize\s+anything|stop\s+saving\s+(anything|memor[a-z]*))\b/i;

/** Re-enable the master switch ("turn your memory back on"). */
const ENABLE_TRIGGERS =
  /\b(turn\s+(your\s+)?memor[a-z]*\s+(back\s+)?on|enable\s+(your\s+)?memor[a-z]*|resume\s+remembering|start\s+remembering\s+again|switch\s+(your\s+)?memor[a-z]*\s+back\s+on|turn\s+on\s+(your\s+)?memor[a-z]*)\b/i;

/** Wipe-ALL memory request ("delete everything you remember about me"). */
const DELETE_ALL_TRIGGERS =
  /\b(forget\s+everything|delete\s+all\s+(your\s+)?memor[a-z]*|clear\s+all\s+(your\s+)?memor[a-z]*|clear\s+your\s+memor[a-z]*|erase\s+everything\s+you\s+(remember|know)|forget\s+everything\s+you\s+(remember|know)|wipe\s+(your\s+)?memor[a-z]*|remove\s+all\s+(your\s+)?memor[a-z]*|delete\s+everything\s+you\s+remember)\b/i;

/** Single-target removal ("forget about X", "delete the memory about Y"). */
const DELETE_TRIGGERS =
  /\b(forget|forgot|erase|delete|remove|drop|unlearn)\b/i;

/** Negation that makes the bare verb a SAVE, never a DELETE. */
const DELETE_BLOCKERS =
  /\b(don'?t|do\s+not|never|please\s+don'?t)\s+(?:forget|forgot)\b/i;

/**
 * "do you remember where the keys are?" / "remember when we met" are knowledge
 * recall, not memory commands. Runs right before the SAVE trigger (the only
 * intent a recall question could collide with); explicit command intents like
 * LIST already won upstream.
 */
function looksLikeKnowledgeRecall(message: string): boolean {
  const recallAsk =
    /\b(do|did|can|could|would)\s+you\s+remember\b|\bremember\s+when\b|\bremember\s+the\s+(date|time|place|name|day|year|address)\b/i;
  if (!recallAsk.test(message)) return false;
  // "remember that I…" / "remember to…" are genuine save intent.
  if (/\bremember\s+that\b|\bremember\s+to\b/i.test(message)) return false;
  // "can you remember the date of the exam?" is a yes/no recall question even
  // without a "?" or a what/how/where continuation.
  if (/\b(do|did|can|could|would)\s+you\s+remember\b/i.test(message)) return true;
  return /\?$/.test(message.trim()) || /\bwhat|how|where|when|who\b/i.test(message);
}

/**
 * Decides whether a message is a memory command, and if so which one plus the
 * deletion target (DELETE only). Ambiguous messages return MEMORY_NONE so the
 * normal chat router answers.
 */
export function detectMemoryIntent(message: string): MemoryIntentResult {
  const text = message.trim();
  const result: MemoryIntentResult = { intent: "MEMORY_NONE", target: "", mode: null };
  if (text.length < 3 || text.length > 500) return result;

  // Explicit command intents first — LIST/DISABLE/DELETE are unambiguous and
  // must beat the recall guard ("what do you remember about me?" lists the
  // stored memory; it is NOT knowledge recall).
  if (DISABLE_TRIGGERS.test(text)) {
    result.intent = "MEMORY_DISABLE";
    result.mode = "off";
    return result;
  }
  if (ENABLE_TRIGGERS.test(text)) {
    result.intent = "MEMORY_DISABLE";
    result.mode = "on";
    return result;
  }
  if (DELETE_ALL_TRIGGERS.test(text)) {
    result.intent = "MEMORY_DELETE";
    result.target = "__all__";
    return result;
  }
  if (LIST_TRIGGERS.test(text)) {
    result.intent = "MEMORY_LIST";
    return result;
  }
  if (UPDATE_TRIGGERS.test(text)) {
    result.intent = "MEMORY_UPDATE";
    return result;
  }
  if (DELETE_TRIGGERS.test(text) && !DELETE_BLOCKERS.test(text)) {
    const target = extractDeleteTarget(text);
    if (target === null) return result; // "forget" alone → not a command.
    result.intent = "MEMORY_DELETE";
    result.target = target;
    return result;
  }

  // "do you remember where the keys are?" is knowledge recall, not a save
  // command — only checked now, right before the save trigger it would
  // otherwise collide with.
  if (looksLikeKnowledgeRecall(text)) return result;

  if (SAVE_TRIGGERS.test(text)) {
    result.intent = "MEMORY_SAVE";
    return result;
  }

  return result;
}

/** True when detectMemoryIntent returned anything but MEMORY_NONE. */
export function isMemoryCommand(message: string): boolean {
  return detectMemoryIntent(message).intent !== "MEMORY_NONE";
}

/**
 * Pulls the subject out of a delete command. Returns null when the trigger is
 * used without a subject ("forget", "erase!") so the caller can answer with an
 * honest "what should I forget?" instead of doing nothing silently. The special
 * subject "__all__" is handled by the delete-all gate before this runs.
 */
function extractDeleteTarget(message: string): string | null {
  // Cut the whole trailing clause off the leading verb.
  const stripped = message
    .replace(/^\s*(please|hey|yo)\s*/i, "")
    .replace(/^.*?\b(forget|forgot|erase|delete|remove|drop|unlearn)\b\s*/i, "")
    .replace(/^(?:(?:about|that|the|my|our|your)\s+)+/i, "")
    .replace(/(please)[\s.,!?]*$/i, "")
    .replace(/^(it|that)\s*$/i, "")
    .trim();
  if (!stripped) return stripped.length === 0 ? null : "";
  if (/\b(remember|memor|preference|fact|detail|info|information)\b/i.test(stripped) && stripped.length < 4) return null;
  return stripped;
}