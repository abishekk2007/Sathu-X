// ---------------------------------------------------------------------------
// Phase 6G — Tasks + Planning: deterministic intent detection.
//
// Like every intent layer in Spidey Bot (6A real-time, 6B domain, 6C/6D/6E
// visual), this is PURE rule-based matching — no LLM, no network. It only
// fires on EXPLICIT task/plan management language:
//   * bootstrap verbs: create/add/make/set/schedule/remind me to/remember to
//   * explicit nouns: task, reminder, to-do, errand
//   * command verbs: complete, cancel, delete, reschedule, update, list
// Ordinary statements ("I have an exam tomorrow", "I should study more") do
// NOT contain a management verb + noun pattern and correctly resolve to NONE,
// so the router keeps handing them to the normal chat pipeline.
// ---------------------------------------------------------------------------

import {
  TASK_RECURRENCES,
  TASK_PRIORITIES,
} from "./types";
import type {
  PlanIntentResult,
  TaskIntentResult,
  TaskPriority,
  TaskRecurrence,
} from "./types";

const IMAGE_VERB =
  /\b(?:draw|render|illustrate|sketch|paint|design|generate(?:d)?\s+(?:an?\s+)?image|create\s+(?:an?\s+)?(?:image|picture|photo|avatar|logo|illustration|diagram|chart|infographic|meme)|make\s+(?:an?\s+)?(?:image|picture|photo|avatar|logo|illustration|diagram|chart|infographic|meme))\b/i;
const DOCUMENT_REFERENCE = /\b(?:pdf|document|doc\b|notes\b|file\b|files\b|attachment|attached\b|handout|syllabus|textbook)\b/i;
// A bare document word ("notes") is NOT enough — task language like "add a
// task: finish physics notes" must stay a task. The doc routes only own the
// message when the user explicitly frames the reference ("according to my
// notes", "read the file", "my pdf"). Gate DOCUMENT_REFERENCE on that frame.
const DOCUMENT_INTENT =
  /\b(?:according\s+to|based\s+on|refer(?:ence)?\s+|referring\s+to|see\s+(?:the|my|this)|from\s+(?:the|my|this)|in\s+(?:the|my|this)|read\s+(?:the|my|this)|upload(?:ed)?|attached?|open\s+(?:the|my|this)|with\s+(?:my|the)\s+(?:notes|pdf|file|handout)|my\s+(?:pdf|document|notes?|file|handout|syllabus|textbook))\b/i;
const DEFINITION_FRAME = /^(?:what\s+(?:is|are)|define|explain|how\s+do|how\s+does|tell\s+me\s+(?:about|what))\b/i;

const PRIORITY_MATCH =
  /(?:priority\s*=\s*|\b)(urgen[ct]|asap|(?:very\s+)?(high|medium|normal|low))\s+priority\b/i;
const RECURRENCE_MATCH = /\b(every\s+(?:day|morning|evening|night|week|month)|daily|weekly|monthly)\b/i;
const TAG_MATCH = /#([a-z0-9][a-z0-9_-]{0,19})/gi;

function extractPriority(text: string): TaskPriority | null {
  const m = text.match(/(?:high|low|medium)\s+priority\b/i) ??
    text.match(/priority\s*\bp?\s*(high|low|medium)\b/i) ??
    text.match(/\b(urgent|asap)\b/i);
  if (!m) return null;
  if (/urgent|asap/i.test(m[0])) return "high";
  const value = m[0].toLowerCase().split(/\s+/)[0];
  return value === "high" || value === "low" ? value : "medium";
}

function extractRecurrence(text: string): TaskRecurrence {
  const m = text.match(RECURRENCE_MATCH);
  if (!m) return "none";
  const token = m[0].toLowerCase();
  if (/month/.test(token)) return "monthly";
  if (/week/.test(token)) return "weekly";
  if (/day|morning|evening|night|daily/.test(token)) return "daily";
  return "none";
}

function extractTags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TAG_MATCH)) {
    const tag = m[1].toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (tag.length > 0 && !out.includes(tag) && out.length < 8) out.push(tag);
  }
  return out;
}

/** Removes priority/recurrence/tag noise so the final title stays clean. */
function cleanTitle(raw: string): string {
  return raw
    .replace(PRIORITY_MATCH, " ")
    .replace(RECURRENCE_MATCH, " ")
    .replace(TAG_MATCH, " ")
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/g, "")
    .trim();
}

/**
 * Splits a "rest" string into title + trailing due phrase.
 * Recognizes connectors at the END: "... at 6pm", "... by tomorrow",
 * "... for Monday", "... on Friday", "... before 8am".
 */
function splitDuePhrase(rest: string): { title: string; rawDue: string | null } {
  const dueMatch = rest.match(
    /\s+(?:at|by|around|for|on|before)\s+(.+)$/i
  );
  if (dueMatch) {
    // A due phrase must look date/time-ish, otherwise it's part of the title.
    const phrase = dueMatch[1].trim();
    if (
      /(am|pm|a\.m|p\.m|today|tonight|tomorrow|tmr|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|weekend|noon|midnight|\d{1,2}\s?[:.]\d{2})/i.test(phrase)
    ) {
      return {
        title: cleanTitle(rest.slice(0, dueMatch.index).trim()),
        rawDue: phrase,
      };
    }
  }
  return { title: cleanTitle(rest), rawDue: null };
}

const CREATE_VERB_PATTERN =
  /^(?:please\s+)?(?:create|add|make|set|schedule|log|record|enter|put|write|plan|track)\b/i;

const COMPLETE_VERB = /\b(?:complete|finish|mark\s+(?:[\w'-]+\s+){0,4}(?:as\s+)?done|set\s+(?:[\w'-]+\s+){0,4}(?:as\s+)?done|done\s+with|checked?\s+off|tick\s+off)\b/i;
const CANCEL_VERB = /\b(?:cancel|turn\s+off|dismiss)\b/i;
const DELETE_VERB = /\b(?:delete|remove)\b/i;
const UPDATE_VERB = /\b(?:change|change\s+the|update|edit|rename|repurpose)\b/i;

const LIST_NOUN = /\b(?:tasks?|reminders?|to[- ]dos?|task\s+list|to[- ]do\s+list|things?|errands?)\b/i;

function hasTaskNoun(text: string): boolean {
  return /\b(?:task|reminder|reminders|to[- ]do\b|to[- ]dos|errand|appointment)\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Task command detection
// ---------------------------------------------------------------------------

export function detectTaskCommand(message: string): TaskIntentResult {
  const text = message.trim();
  const lower = text.toLowerCase();

  // Hard guards — other stronger routes own these.
  if (IMAGE_VERB.test(text) || (IMAGE_VERB.test(text) === false && /\bcreate\s+(?:an?\s+)?(?:image|picture|photo)\b/i.test(text))) {
    return { intent: "TASK_NONE", title: "", rawDue: null, priority: "medium", recurrence: "none", tags: [], target: "", rescheduleTo: null, reason: "Image-generation language — owned by the image routes." };
  }
  if (DOCUMENT_INTENT.test(text) && DOCUMENT_REFERENCE.test(text)) {
    return { intent: "TASK_NONE", title: "", rawDue: null, priority: "medium", recurrence: "none", tags: [], target: "", rescheduleTo: null, reason: "Document reference — owned by the document routes." };
  }
  if (DEFINITION_FRAME.test(lower) && text.length < 80) {
    return { intent: "TASK_NONE", title: "", rawDue: null, priority: "medium", recurrence: "none", tags: [], target: "", rescheduleTo: null, reason: "Definitional/explanation question — not a command." };
  }

  // ---- CREATE --------------------------------------------------------------
  // "remind me to X" / "remind me that X" → the whole rest is the task.
  const remindMe = text.match(/^(?:please\s+)?(?:remind|remember)\s+me\s+(?:to|that)\s+(.+)$/i);
  if (remindMe && remindMe[1].trim().length > 0) {
    const { title, rawDue } = splitDuePhrase(remindMe[1]);
    if (title.length > 0) {
      return {
        intent: "TASK_CREATE",
        title,
        rawDue,
        priority: extractPriority(text) ?? "medium",
        recurrence: extractRecurrence(text),
        tags: extractTags(text),
        target: "",
        rescheduleTo: null,
        reason: `Explicit "remind me to" command for "${title}".`,
      };
    }
  }

  // "don't forget to X"
  const dontForget = text.match(/^don'?t\s+forget\s+(?:to|about)\s+(.+)$/i);
  if (dontForget && dontForget[1].trim().length > 0) {
    const { title, rawDue } = splitDuePhrase(dontForget[1]);
    if (title.length > 0) {
      return {
        intent: "TASK_CREATE",
        title,
        rawDue,
        priority: extractPriority(text) ?? "medium",
        recurrence: extractRecurrence(text),
        tags: extractTags(text),
        target: "",
        rescheduleTo: null,
        reason: `Explicit "don't forget to" command for "${title}".`,
      };
    }
  }

  // "add/create/set/make a task: X" | "add a task to X" | "set a reminder for X"
  if (CREATE_VERB_PATTERN.test(text)) {
    if (hasTaskNoun(lower)) {
      const afterNoun = text
        .replace(/^(?:please\s+)?(?:create|add|make|set|schedule|log|record|enter|put|write|plan|track)\b/i, " ")
        .replace(/^(?:a|an|the|my|one|a\s+new|a\s+new|another|new|this)\s*/i, " ")
        .replace(/\b(?:task|reminder|reminders|to[- ]do|to[- ]dos|errand|appointment|item|entry|deadline)\b/i, " ")
        .replace(/^(?:for|about|to|that|on|at|in|as|of|:|:\s*)\s*/i, " ")
        .replace(/\b(?:please)\b/i, " ")
        .trim();
      if (afterNoun.length > 0) {
        const { title, rawDue } = splitDuePhrase(afterNoun);
        if (title.length > 0) {
          return {
            intent: "TASK_CREATE",
            title,
            rawDue,
            priority: extractPriority(text) ?? "medium",
            recurrence: extractRecurrence(text),
            tags: extractTags(text),
            target: "",
            rescheduleTo: null,
            reason: `Task-creation verb + noun (${title}).`,
          };
        }
      }
    }
  }

  // ---- LIST ---------------------------------------------------------------
  const isList = /^(?:show|list|view|get|display|open|load)\s+(?:me\s+)?/i.test(text) && LIST_NOUN.test(lower)
    || /^(?:what|which)\s+.{0,20}?(?:tasks?|reminders?|to[- ]dos?|things?)\s+(?:do\s+i\s+have|are\s+due|due)\b/i.test(text)
    || /^(?:show|tell)\s+me\s+(?:what|which)\s+(?:tasks?|reminders?|things?)\s+(?:are\s+)?(?:due|i\s+have)\b/i.test(text)
    || /^what(?:'s| is| do i have)\b/i.test(text) && /(?:on\s+(?:my\s+)?(?:tasks?|list|to[- ]do)|due\s+today|reminders?)\b/i.test(lower)
    || /^(?:what|which)\s+(?:tasks?|reminders?)\s+are\s+due\b/i.test(text)
    || /^(?:is|are)\s+there\s+(?:any|the)\s+(?:tasks?|reminders?)\s+due\b/i.test(text);
  if (isList) {
    return { intent: "TASK_LIST", title: "", rawDue: null, priority: "medium", recurrence: "none", tags: [], target: "", rescheduleTo: null, reason: "Task/reminder listing request." };
  }

  // ---- RESCHEDULE ---------------------------------------------------------
  const reschedule = text.match(
    /^(?:please\s+)?(?:reschedule|postpone|push|move|shift|defer|bump)\s+(?:the\s+)?(?:task|reminder|appointment)\s+(.+?)\s+(?:to|until|by|for)\s+(.+)$/i
  );
  if (reschedule) {
    const target = cleanTitle(reschedule[1]);
    if (target.length > 0) {
      return {
        intent: "TASK_RESCHEDULE",
        title: "", rawDue: null,
        priority: extractPriority(text) ?? "medium",
        recurrence: extractRecurrence(text),
        tags: extractTags(text),
        target,
        rescheduleTo: reschedule[2].trim(),
        reason: `Reschedule command for "${target}".`,
      };
    }
  }

  // ---- COMPLETE -----------------------------------------------------------
  const complete = text.match(
    /^(?:please\s+)?(?:mark|set)\s+\S+\s+(?:task|reminder|item)\s*(?:\s+(?:as|to)|:)?\s*(.+?)\s*(?:\s+as)?\s+(?:done|completed|complete|finished|checked\s+off)\s*$/i
  ) ?? text.match(/^(?:please\s+)?(?:complete|finish|tick\s+off|check\s+off)\s+(?:the\s+)?(?:task|reminder|item)\s*(?:\s+(?:to|named|for|:|))?\s*(.+)$/i);
  if (complete && COMPLETE_VERB.test(text)) {
    const target = cleanTitle((/marked/.test(complete[0]) || /as done/.test(complete[0]) ? complete[1] : complete[1]).replace(/\s+(?:as\s+)?(?:done|completed|complete|finished)\s*$/i, ""));
    if (target.length > 0) {
      return {
        intent: "TASK_COMPLETE", title: "", rawDue: null,
        priority: "medium", recurrence: "none", tags: [],
        target,
        rescheduleTo: null,
        reason: `Completion command for "${target}".`,
      };
    }
  }

  // ---- CANCEL -------------------------------------------------------------
  const cancel = text.match(/^(?:please\s+)?(?:cancel|dismiss|turn\s+off)\s+(?:the\s+)?(?:task|reminder|alarm|reminder\s+for)\s*(?:\s+(?:to|for|named|:|))?\s*(.+)$/i);
  if (cancel && CANCEL_VERB.test(text) && cancel[1]?.trim()) {
    const target = cleanTitle(cancel[1]);
    if (target.length > 0) {
      return {
        intent: "TASK_CANCEL", title: "", rawDue: null,
        priority: "medium", recurrence: "none", tags: [],
        target,
        rescheduleTo: null,
        reason: `Cancellation command for "${target}".`,
      };
    }
  }

  // ---- DELETE -------------------------------------------------------------
  const del = text.match(/^(?:please\s+)?(?:delete|remove)\s+(?:the\s+)?(?:task|reminder|appointment)\s+(.+)$/i);
  if (del && DELETE_VERB.test(text) && del[1]?.trim()) {
    const target = cleanTitle(del[1]);
    if (target.length > 0) {
      return {
        intent: "TASK_DELETE", title: "", rawDue: null,
        priority: "medium", recurrence: "none", tags: [],
        target,
        rescheduleTo: null,
        reason: `Deletion command for "${target}".`,
      };
    }
  }

  // ---- UPDATE -------------------------------------------------------------
  const update = text.match(/^(?:please\s+)?(?:change|rename|reprioritize)\s+(?:the\s+)?(?:task|reminder|appointment)\s+(.+)$/i);
  if (update && UPDATE_VERB.test(text) && update[1]?.trim()) {
    const target = cleanTitle(update[1]);
    if (target.length > 0) {
      return {
        intent: "TASK_UPDATE", title: "", rawDue: null,
        priority: "medium", recurrence: "none", tags: [],
        target,
        rescheduleTo: null,
        reason: `Update command for "${target}".`,
      };
    }
  }

  return { intent: "TASK_NONE", title: "", rawDue: null, priority: "medium", recurrence: "none", tags: [], target: "", rescheduleTo: null, reason: "No explicit task-management language." };
}

// ---------------------------------------------------------------------------
// Plan intent detection
// ---------------------------------------------------------------------------

const PLAN_NOUN = /\b(?:plan|study\s+plan|revision\s+plan|preparation|routine|schedule|roadmap|itinerary|breakdown|timeline|prep)\b/i;
const PLAN_VERB = /\b(?:create|make|build|prepare|draft|write|formulate|generate|design|develop|organize|draw\s+up|put\s+together)\s+(?:(?:a|an|the|me|my|us|our|one)\s+)?(?:detailed\s+|full\s+|simple\s+|2-week\s+|two-week\s+|3-week\s+|three-week\s+|month\s+|weekly\s+|daily\s+|study\s+|revision\s+)?(?:study\s+|revision\s+)?(?:plan|study\s+plan|revision\s+plan|routine|schedule|roadmap|itinerary|breakdown|timeline|prep)\b/i;
const THEMATIC_PLAN_PATTERN =
  /^plan\s+(?:my|our|the|your)\s+(.+?)\s*(?:for\s+(.+))?$/i;

const PLAN_STATUS_PATTERN =
  /^(?:show|view|list|get|check|what|is|are)\s+(?:me\s+)?(?:my|the|all\s+my)?\s*(?:study\s+)?plans?\b/i;

// "I should write a plan soon" is a statement, not a command. Block
// subject-pronoun + modal/want phrasing from matching PLAN_VERB below, while
// imperatives ("make a study plan", "can you make a study plan") keep working.
const PLAN_SUBJECT_STATEMENT =
  /^(?:i|i'd|i'll|i've|i'm|we|we'd|we'll|we're|they|they'd|they'll|she|she'd|she'll|he|he'd|he'll|it|it'll|it's)\s+(?:should|would|could|can|will|am|are|was|were|need\s+to|wanted?\s+to|have\s+to|ought\s+to|hope\s+to|plan(?:ned|ning)?\s+to|like\s+to|going\s+to)\b/i;

export function detectPlanCommand(message: string): PlanIntentResult {
  const text = message.trim();

  if (IMAGE_VERB.test(text)) {
    return { intent: "PLAN_NONE", objective: "", title: "", reason: "Image-generation language — owned by the image routes." };
  }
  if (DOCUMENT_INTENT.test(text) && DOCUMENT_REFERENCE.test(text)) {
    return { intent: "PLAN_NONE", objective: "", title: "", reason: "Document reference — owned by the document routes." };
  }
  if (/^what\s+is\s+(?:a\s+)?(?:study\s+)?plan\?*$/i.test(text)) {
    return { intent: "PLAN_NONE", objective: "", title: "", reason: "Definitional question, not a plan request." };
  }
  if (PLAN_SUBJECT_STATEMENT.test(text)) {
    return { intent: "PLAN_NONE", objective: "", title: "", reason: "Aspirational statement, not a plan command." };
  }

  // "create a study plan for my physics exam" → objective is the FOR-phrase.
  const createMatch = text.match(PLAN_VERB);
  if (createMatch) {
    const rest = text.slice(createMatch.index! + createMatch[0].length).trim();
    const forPhrase = rest.match(/^for\s+(.+)$/i)?.[1]?.trim();
    if (forPhrase) {
      return {
        intent: "PLAN_CREATE",
        objective: forPhrase,
        title: `Study plan for ${forPhrase}`,
        reason: `Plan-creation request for "${forPhrase}".`,
      };
    }
    const remaining = rest.replace(/\s*$/g, "");
    if (remaining.length > 0) {
      return {
        intent: "PLAN_CREATE",
        objective: remaining,
        title: `Study plan: ${remaining}`,
        reason: `Plan-creation request with objective "${remaining}".`,
      };
    }
    return {
      intent: "PLAN_CREATE",
      objective: "general study preparation",
      title: "Study plan",
      reason: "General plan-creation request with no objective stated.",
    };
  }

  const thematic = text.match(THEMATIC_PLAN_PATTERN);
  if (thematic) {
    const focus = thematic[1].trim();
    const purpose = thematic[2]?.trim();
    if (focus || purpose) {
      return {
        intent: "PLAN_CREATE",
        objective: `plan ${focus}${purpose ? ` (for ${purpose})` : ""}`,
        title: `Plan for ${focus}`,
        reason: `Thematic planning request focused on "${focus}"${purpose ? ` for "${purpose}"` : ""}.`,
      };
    }
  }

  if (PLAN_STATUS_PATTERN.test(text)) {
    return { intent: "PLAN_STATUS", objective: "", title: "", reason: "Plan listing request." };
  }

  if (PLAN_NOUN.test(text) && /\b(?:update|edit|revise|adjust|change)\b/i.test(text)) {
    return { intent: "PLAN_STATUS", objective: "", title: "", reason: "Plan refinement request — surface current plans honestly." };
  }

  return { intent: "PLAN_NONE", objective: "", title: "", reason: "No explicit plan language." };
}

// Exported for tests / reuse
export const _INTENT_HELPERS = { extractPriority, extractRecurrence, extractTags, cleanTitle, splitDuePhrase };
export const _VALID_RECURRENCES = [...TASK_RECURRENCES];
export const _VALID_PRIORITIES = [...TASK_PRIORITIES];