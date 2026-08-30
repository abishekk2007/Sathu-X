// ---------------------------------------------------------------------------
// Phase 6F — Advanced Memory: conservative, deterministic fact extraction.
//
// The chat route treats an explicit MEMORY_SAVE/UPDATE command by:
//   1. stripping the verb phrase → a clean fact clause;
//   2. inferring one of the 7 types;
//   3. deriving a stable dedup key;
//   4. normalizing first-person phrasing into third-person "The user …".
// Nothing here calls an LLM — the LLM path is only a *fallback* when the
// verb-strip leaves nothing clean ("remember to…", quoted facts, etc.).
// Better to remember nothing than to remember something wrong, so every step
// returns null / "ambiguous" on doubt.
// ---------------------------------------------------------------------------

import type { MemoryType, MemoryWrite } from "./types";
import { looksSensitive } from "./security";

type LexUnit =
  | { kind: "fact"; content: string; candidate: MemoryWrite }
  | { kind: "empty" }
  | { kind: "ambiguous" }
  | { kind: "secret" };

/** Legacy 4A category → 6F type bridge (used for LLM-extraction results). */
export const CATEGORY_TO_TYPE: Record<string, MemoryType> = {
  preference: "preference",
  communication: "preference",
  project: "project",
  goal: "goal",
  work: "project",
  education: "profile",
  academic: "profile",
  personal: "profile",
  general: "fact",
};

export function mapCategoryToType(category: string): MemoryType {
  return CATEGORY_TO_TYPE[category] ?? "fact";
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "about", "into", "from",
  "user", "users", "prefers", "prefer", "always", "never", "sometimes",
]);

/** Reduces a fact to a compact, stable key fragment ("preference:concise-answers"). */
export function slugify(content: string): string {
  const tokens = content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  const picked = tokens.slice(0, 4).join("-");
  return picked.slice(0, 50);
}

/** Stable dedup identity for a typed fact. */
export function buildDedupKey(type: MemoryType, content: string): string {
  const subject = slugify(content);
  return subject ? `${type}:${subject}` : `${type}:unknown`;
}

/**
 * Normalizes first-person phrasing into the third-person form used for stored
 * facts and the context block. Deliberately narrow (prefix/subject-pronoun
 * swaps only) so meaning is never rewritten.
 */
export function normalizeContent(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim().replace(/\s+\.$/, "").replace(/[.,;\s]+$/, "");
  if (!collapsed) return "";

  let text = collapsed;
  if (/^i\s+/i.test(text)) {
    text = `The user ${text.slice(2).trim()}`;
  } else if (/^i'm\s+/i.test(text)) {
    text = `The user is ${text.slice(3).trim()}`;
  }
  text = text
    .replace(/\bI\s+am\s+/gi, "The user is ")
    .replace(/\bmy\s+/gi, "the user's ")
    .replace(/\bi\s+/gi, "the user ")
    .replace(/\bme\b/gi, "the user");
  text = applyAgreement(text);
  // A trailing "please" attached to the command is boilerplate, not data.
  text = text.replace(/\s+,?\s*please[\s.,!?]*$/i, "").trim();
  return text.slice(0, 500);
}

const INSTRUCTION_HINTS =
  /\b(call\s+me|refer\s+to\s+me\s+as|address\s+me\s+as|pronounce\s+my\s+name|explain\s+(in|everything|all\s+answers|things|topics|concepts|stuff)|respond\s+in|reply\s+in|answer\s+in|never\s+(mention|call|use|repeat)|always\s+(start|begin|end|use|write|give|explain|respond|reply|answer)|treat\s+me\s+as|keep\s+answers?\s+(short|concise|brief)|send\s+me\s+(a\s+)?(summary|details|notes?|list))\b/i;

const PROFILE_HINTS =
  /\b(my\s+)?(name\s+is|called|born|birth|hometown|\bfrom\s+|live[ds]?\s+in|located\s+in|school|college|university|course|degree|semester|\bstream\b|stud(ying|y|ies|ent)\s+(in|at)|roll\s+number|working\s+as|job\s+title|year\s+of\s+study|gate|neet|jee|entrance|exam\s+target)\b/i;

const PROJECT_HINTS =
  /\b(project|projects?|building|developing|created\s+a|started\s+a|startup|\bapp\s+called|website\s+called|\brepo\b|codebase|initiative|side\s+project|thesis|research\s+project|client\s+work)\b/i;

const WORKFLOW_HINTS =
  /\b(always\s+when|usually|habit|daily\s+routine|routine|steps?\s+i\s+follow|process|procedure|first\s+\w+\s+then|when\s+i\s+(do|start|study|work)|before\s+(studying|sleep|work|class)|after\s+that|workflow|prefers?\s+to\s+(do|work|study|prepare)|while\s+(studying|working|reading|writing|preparing|coding|playing)|whenever\s+(studying|working|reading|writing|preparing|coding|playing)|every\s+(morning|night|evening|day|weekend))\b/i;

const GOAL_HINTS =
  /\b(wants?\s+to|aim|aims?\s+to|goal|goals?|plans?\s+to|target|targeting|trying\s+to|aspire(s)?\s+to|hope(s)?\s+to|dreams\s+of|prepar\w*\s+for|score\s+in|deadline\s+for|wish\s+to)\b/i;

const PREFERENCE_HINTS =
  /\b(prefer|prefers|preference|like|likes|loves?\s+to|enjoys?\s+|favourite|favorite|dislike|dislikes|hates?\s+to|wants?\s+(shorter|simpler|detailed|concise)|tone\s+|temperature\s+of\s+the\s+room|coffee|tea|music\s+while|fonts?|themes?|language\s+preference)\b/i;

/**
 * Deterministic 7-value type inference over a cleaned fact clause. Order
 * matters: instructions and goals are unmistakable, then project markers
 * (which often contain profile-y words like "called"), then identity, then
 * behavioural patterns, then preferences, falling back to fact.
 */
export function inferType(content: string): MemoryType {
  if (INSTRUCTION_HINTS.test(content)) return "instruction";
  if (GOAL_HINTS.test(content)) return "goal";
  if (PROJECT_HINTS.test(content)) return "project";
  if (PROFILE_HINTS.test(content)) return "profile";
  if (WORKFLOW_HINTS.test(content)) return "workflow";
  if (PREFERENCE_HINTS.test(content)) return "preference";
  return "fact";
}

/** High-signal statements (identity, goals, instructions) are core facts. */
export function deriveImportance(type: MemoryType, content: string): number {
  if (type === "profile" || type === "instruction" || type === "goal") return 4;
  if (type === "preference" && /\b(tamil|language|concise|shorter|simpler|pronunciation)\b/i.test(content)) return 4;
  return 3;
}

/** Common first-person verb → third-person singular after "The user …". */
const AGREEMENT: Record<string, string> = {
  prefer: "prefers",
  like: "likes",
  live: "lives",
  work: "works",
  use: "uses",
  want: "wants",
  plan: "plans",
  need: "needs",
  study: "studies",
  play: "plays",
  do: "does",
  have: "has",
  go: "goes",
  write: "writes",
  build: "builds",
  make: "makes",
};

function applyAgreement(text: string): string {
  return text.replace(
    /^The user\s+(prefer|like|live|work|use|want|plan|need|study|play|do|have|go|write|build|make)\b/i,
    (whole, verb: string) => {
      const agreed = AGREEMENT[verb.toLowerCase()];
      return agreed ? whole.replace(verb, agreed) : whole;
    }
  );
}

/**
 * Strips the command verb from an explicit save request and returns a typed,
 * secret-vetted write. Falls back to the LLM in the chat route only when this
 * returns empty/ambiguous.
 */
export function parseMemoryCandidate(message: string): LexUnit {
  const stripped = message
    .replace(/^\s*(please|hey|yo)\s*/i, "")
    .replace(
      /\s*(please|thanks|thank\s+you)[.,!]?\s*$/i,
      ""
    )
    .trim();

  const FACT_LEAD =
    /^\s*(you\s+should\s+)?(remember\s+that|remember\s+to|memori[sz]e|keep\s+in\s+mind|don'?t\s+forget|do\s+not\s+forget|never\s+forget|note\s+(that|down|this)|make\s+a\s+note\s*(that|of)?|take\s+a\s+note\s*(that|of)?|save\s+this|store\s+this|remember)\s*[:,\-]?\s*/i;

  const fact = stripped.replace(FACT_LEAD, "").trim().replace(/[.,;]+$/, "");

  if (!fact) return { kind: "empty" };
  if (fact.length < 3) return { kind: "ambiguous" };
  if (looksSensitive(fact)) return { kind: "secret" };

  const content = normalizeContent(fact);
  if (!content) return { kind: "empty" };
  if (looksSensitive(content)) return { kind: "secret" };

  const type = inferType(content);
  return {
    kind: "fact",
    content,
    candidate: {
      key: buildDedupKey(type, content),
      content,
      type,
      source: "explicit",
      confidence: "high",
      importance: deriveImportance(type, content),
      enabled: true,
    },
  };
}