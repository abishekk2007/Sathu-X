// ---------------------------------------------------------------------------
// Creator Profile — Deterministic application-owned fact
//
// This is NOT user memory, NOT a model-generated biography, NOT web content.
// It is permanent product metadata that is intercepted BEFORE any Gemini /
// web / RAG pipeline, ensuring the answer is always deterministic.
// ---------------------------------------------------------------------------

export interface CreatorProfile {
  productName: string;
  creator: string;
  education: string;
  projects: string[];
  /** Default answer when the user asks who created the product. */
  defaultAnswer: string;
  /** Answer when the user asks specifically about the creator. */
  creatorAnswer: string;
  /** Answer when the user asks about projects. */
  projectAnswer: string;
}

export const CREATOR_PROFILE: CreatorProfile = {
  productName: "SathuX",
  creator: "Abishek K",
  education: "second-year student at Panimalar Engineering College",
  projects: ["Vision Voice AI", "Intellix AI", "Vitanexa AI"],
  defaultAnswer:
    "SathuX was created by Abishek K, a second-year student at Panimalar Engineering College. He has successfully worked on projects including Vision Voice AI, Intellix AI, and Vitanexa AI.",
  creatorAnswer:
    "Abishek K is a second-year student at Panimalar Engineering College and the creator of SathuX. He has successfully worked on Vision Voice AI, Intellix AI, and Vitanexa AI.",
  projectAnswer:
    "The creator of SathuX, Abishek K, has successfully worked on Vision Voice AI, Intellix AI, and Vitanexa AI.",
};

// ---------------------------------------------------------------------------
// Deterministic matcher
// ---------------------------------------------------------------------------
// Matches ONLY when the question clearly refers to SathuX or Abishek K.
// Generic "who created this?" without product context is NOT matched.
// "Who created ChatGPT?" is NOT matched even when SathuX is in the conversation.

/** Product name references (case-insensitive). */
const PRODUCT_NAME = /\bsathux\b/i;

/** Creator name references (case-insensitive). */
const CREATOR_NAME = /\babishek\s*k\b/i;

/** Creator-related verbs / nouns. */
const CREATOR_VERBS =
  /\b(?:creat(?:ed|or|ors|ion)|invent(?:ed|or|ors|ion)|develop(?:ed|er|ers|ment)|made|built|build(?:ing|s)?|found(?:ed|er|ers)?)\b/i;

/** Generic reference to "this product" when no other product name is mentioned. */
const GENERIC_THIS_PRODUCT =
  /\b(?:this\s+(?:bot|app|project|chatbot|assistant|ai))\b/i;

/** Product names of OTHER systems that must NOT trigger a false positive. */
const OTHER_PRODUCT_NAMES =
  /\b(?:chatgpt|gpt[-\s]?[4o]?|openai|gemini|claude|anthropic|llama|mistral|copilot|bing|bard|siri|alexa|grok|perplexity|midjourney|dall[-\s]?e|stable\s*diffusion)\b/i;

/**
 * User asked about the creator's projects/work — not "who made X?".
 * A project question is a "what/how" query ("what projects…", "what did
 * Abishek K build?") containing a project noun/verb, NOT a "who created/made
 * SathuX?" framing (which is a creator question).
 */
const PROJECT_FOCUS =
  /\b(?:project|projects)\b|(?:what|which|how)\b.*\b(?:build?(?:built)?|made|work(?:ed)?|create|develop)\b/i;

export type CreatorMatchType =
  | "none"
  | "creator_question"
  | "creator_name"
  | "project_question";

/**
 * Pure, deterministic detection of a creator/profile question.
 *
 * Returns the match type (or "none") and the canonical answer text.
 * The function has NO side effects, makes NO external calls, and is
 * exhaustively unit-testable.
 */
export function detectCreatorProfileQuestion(
  message: string,
  priorTurns?: Array<{ role: "user" | "assistant"; content: string }>
): { type: CreatorMatchType; answer: string } {
  const text = message.trim();

  // Direct product-name reference: "Who created SathuX?" etc.
  if (PRODUCT_NAME.test(text)) {
    if (PROJECT_FOCUS.test(text)) {
      return { type: "project_question", answer: CREATOR_PROFILE.projectAnswer };
    }
    return { type: "creator_question", answer: CREATOR_PROFILE.defaultAnswer };
  }

  // Direct creator-name reference: "Who is Abishek K?" etc.
  if (CREATOR_NAME.test(text)) {
    if (PROJECT_FOCUS.test(text)) {
      return { type: "project_question", answer: CREATOR_PROFILE.projectAnswer };
    }
    return { type: "creator_name", answer: CREATOR_PROFILE.creatorAnswer };
  }

  // Generic "this bot/app" reference: only match when:
  // 1. A creator verb is present, AND
  // 2. No other product name is mentioned, AND
  // 3. No other specific name (beyond SathuX/Abishek K) is present
  if (CREATOR_VERBS.test(text) && GENERIC_THIS_PRODUCT.test(text)) {
    if (OTHER_PRODUCT_NAMES.test(text)) return { type: "none", answer: "" };
    return { type: "creator_question", answer: CREATOR_PROFILE.defaultAnswer };
  }

  return { type: "none", answer: "" };
}
