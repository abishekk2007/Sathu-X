// ---------------------------------------------------------------------------
// Phase 6A — Deterministic intent router (no Gemini, no LLM).
// Mirrors the Phase 5 agent router's style: pure, rule-based, fast.
//
// Priority (strongest first):
//   DOCUMENT-REFERENCE > CALCULATION > CURRENCY > WEATHER > DATE/TIME
//
// Document-priority guard: ANY explicit reference to a document/PDF/notes
// ("according to my PDF", "what does my file say", "what date does the PDF
// mention") makes the real-time layer stand down — even without attached
// sources — so the RAG/Gemini pipeline answers from the document. Without
// this, "what date does my PDF mention?" would be hijacked by the date tool.
//
// Intent-signal guards keep everyday chat out of the tools: planning verbs
// ("plan my day for tomorrow") never become date queries, and non-question
// "usd" mentions never become conversions.
// ---------------------------------------------------------------------------

import { resolveTimeZone } from "./date-time";
import type { RealtimeDecision, RealtimeIntent, RealtimeParams } from "./types";

/** Mirrors the agent router's SOURCE_REFERENCE_PATTERNS guard (broadened). */
const DOCUMENT_REFERENCE_PATTERNS: RegExp[] = [
  /\b(?:according to|based on|refer(?:ring)? to|using)\s+(?:the\s+|my\s+)?(?:document|file|notes|pdf|pasted\s+(?:notes|text)|material|text|book)\b/i,
  /\b(?:from|in)\s+(?:the\s+|my\s+)?(?:document|file|notes|pdf|pasted\s+(?:notes|text)|material|text|book)\b/i,
  /\b(?:this|that|the|my)\s+(?:document|file|notes|pdf|material|text|book)\b/i,
  /\b(?:what does|what do|what is|what's)\s+(?:the\s+|my\s+)?(?:document|file|notes|pdf|material|text|book)\s+(?:say|state|mention|contain)/i,
  /\b(?:explain|describe|summariz[se]|analys[ie]|read)\s+(?:the\s+|my\s+)?(?:document|file|notes|pdf|material|text|book)\b/i,
  /\b(?:uploaded|attached|selected|pasted)\s+(?:document|file|notes|pdf|material|text|image)\b/i,
];

/** True when the message explicitly references a document/PDF/notes. */
export function referencesDocument(message: string): boolean {
  return DOCUMENT_REFERENCE_PATTERNS.some((pattern) => pattern.test(message));
}

// ---------------------------------------------------------------------------
// Calculation extraction
// ---------------------------------------------------------------------------

const CALC_PREFIXES: RegExp[] = [
  /^(?:please\s+)?(?:calculate|compute|calc|evaluate|solve|simplify|work\s+out|figure\s+out)\s+/i,
  /^what\s+(?:is|are)\s+/i,
  /^what'?s\s+/i,
  /^whats\s+/i,
  /^the\s+value\s+of\s+/i,
  /^how\s+much\s+is\s+/i,
  /^result\s+of\s+/i,
  /^the\s+answer\s+to\s+/i,
];

const CALC_ALLOWED_CHARS = /^(?:sqrt|pow|[0-9+\-*/%^().\s])+$/;

function stripCalcWrapper(text: string): string {
  let current = text.trim();
  for (let pass = 0; pass < 6; pass += 1) {
    let cleaned = current;
    for (const prefix of CALC_PREFIXES) {
      const stripped = cleaned.replace(prefix, "");
      if (stripped !== cleaned) {
        cleaned = stripped.trim();
        break;
      }
    }
    cleaned = cleaned.replace(/\s+\?\s*$/, "").replace(/\s+please\s*$/i, "").trim();
    if (cleaned === current) break;
    current = cleaned;
  }
  return current;
}

/**
 * Returns a clean arithmetic expression when the message is a pure-arithmetic
 * request, otherwise null. Anything with foreign letters/words/JavaScript
 * syntax is NOT a calculation (falls through to the normal flow).
 */
export function extractCalculation(message: string): string | null {
  const expr = stripCalcWrapper(message);
  if (!expr || expr.length > 60) return null;
  if (!CALC_ALLOWED_CHARS.test(expr)) return null;
  if (!/\d/.test(expr)) return null;

  const hasOperator = /[+\-*/%^]/.test(expr);
  const hasFunction = /sqrt\s*\(|pow\s*\(/.test(expr.toLowerCase());
  if (!hasOperator && !hasFunction) return null;

  return expr;
}

// ---------------------------------------------------------------------------
// Currency detection
// ---------------------------------------------------------------------------

/** Major, unambiguous ISO 4217 codes (no common English words like mad/pen). */
const CURRENCY_CODES = new Set([
  "usd", "eur", "gbp", "jpy", "inr", "aud", "cad", "chf", "cny", "hkd",
  "sgd", "nzd", "sek", "nok", "dkk", "krw", "thb", "myr", "idr", "php",
  "vnd", "brl", "mxn", "zar", "aed", "sar", "try", "rub", "pln", "czk",
  "huf", "ron", "ils", "twd", "pkr", "bdt", "lkr", "npr", "ngn", "kes",
  "egp",
]);

const CURRENCY_KEYWORD = /\b(?:currency|convert|exchange|rate|how\s+much|how\s+many|worth)\b/i;
const CURRENCY_GUARD_WORD = /\b(?:dollars?|euros?|pounds?|rupees?|yen|yuan|usd|eur|gbp|inr|jpy)\b/i;

function parseAmount(raw: string): number {
  const cleaned = raw.replace(/,/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : Number.NaN;
}

interface CurrencyHit {
  intent: RealtimeIntent;
  params: RealtimeParams;
  /** True when the currency intent exists but the pair couldn't be parsed. */
  guard?: boolean;
}

/**
 * Detects a currency conversion or exchange-rate query, or null.
 * Only known ISO codes count; pair structure must match; ordinary prose
 * (e.g. "try to use this") never becomes a conversion.
 */
export function detectCurrency(message: string): CurrencyHit | null {
  const lower = message.toLowerCase().trim();
  const known = (code: string): boolean => CURRENCY_CODES.has(code.toLowerCase());

  // 1. "how many EUR is 100 USD" -> base USD (amount 100), target EUR.
  let m = lower.match(/\bhow\s+many\s+([a-z]{3})\s+(?:is|are|=)\s+(\d[\d.,]{0,14})\s+([a-z]{3})\b/);
  if (m && known(m[1]) && known(m[3])) {
    const amount = parseAmount(m[2]);
    if (Number.isFinite(amount)) {
      return {
        intent: "CURRENCY_CONVERSION",
        params: { from: m[3].toUpperCase(), to: m[1].toUpperCase(), amount },
      };
    }
  }

  // 2. "convert [amount] USD to EUR" / "exchange 100 USD in INR".
  m = lower.match(/\b(?:convert|exchange)\s+(?:(\d[\d.,]{0,14})\s*)?([a-z]{3})\s+(?:to|into|in)\s+([a-z]{3})\b/);
  if (m && known(m[2]) && known(m[3])) {
    const amount = m[1] ? parseAmount(m[1]) : 1;
    if (Number.isFinite(amount)) {
      return {
        intent: m[1] ? "CURRENCY_CONVERSION" : "EXCHANGE_RATE",
        params: { from: m[2].toUpperCase(), to: m[3].toUpperCase(), amount },
      };
    }
  }

  // 3. "100 USD to EUR".
  m = lower.match(/\b(\d[\d.,]{0,14})\s+([a-z]{3})\s+(?:to|into|in|for)\s+([a-z]{3})\b/);
  if (m && known(m[2]) && known(m[3])) {
    const amount = parseAmount(m[1]);
    if (Number.isFinite(amount)) {
      return {
        intent: "CURRENCY_CONVERSION",
        params: { from: m[2].toUpperCase(), to: m[3].toUpperCase(), amount },
      };
    }
  }

  // 4. "how much is 50 EUR in INR".
  m = lower.match(/\bhow\s+much\s+(?:is|does)\s+(\d[\d.,]{0,14})\s+([a-z]{3})\s+(?:in|as)\s+([a-z]{3})\b/);
  if (m && known(m[2]) && known(m[3])) {
    const amount = parseAmount(m[1]);
    if (Number.isFinite(amount)) {
      return {
        intent: "CURRENCY_CONVERSION",
        params: { from: m[2].toUpperCase(), to: m[3].toUpperCase(), amount },
      };
    }
  }

  // 5. "USD to EUR" / "usd/eur" rate pair (no amount).
  m = lower.match(/\b([a-z]{3})\s*(?:to|\/|-|vs|against)\s*([a-z]{3})\b/);
  if (m && known(m[1]) && known(m[2])) {
    const separator = m[0].slice(m[1].length, m[0].length - m[2].length);
    const rateContext = CURRENCY_KEYWORD.test(lower) || lower.length <= 24;
    if (separator && rateContext) {
      return {
        intent: "EXCHANGE_RATE",
        params: { from: m[1].toUpperCase(), to: m[2].toUpperCase(), amount: 1 },
      };
    }
  }

  // 6. Currency intent that didn't parse into a clean pair (e.g. "100 dollars
  //    to euros"). Answer with safe guidance instead of letting an LLM guess.
  if (CURRENCY_GUARD_WORD.test(lower) && /\b(?:convert|exchange|how\s+much|how\s+many|rate)\b/i.test(lower)) {
    return { intent: "CURRENCY_CONVERSION", params: {}, guard: true };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Weather detection
// ---------------------------------------------------------------------------

const WEATHER_KEYWORDS = /\b(?:weather|forecast|temperature|rain|rainy|raining|drizzle|snow|snowy|snowing|humidity|humid|wind|windy|sunny|cloudy|overcast|thunder|storm|hot|cold|warm|heat|freezing|chilly|precipitation)\b/i;
const WEATHER_REQUEST_SIGNAL = /\b(?:what|how|is|will|weather|forecast|temperature|current|today|tomorrow|now|next|this\s+week|this\s+weekend)\b/i;
const WEATHER_STOP_WORDS = /\b(?:the|weather|forecast|temperature|today|tomorrow|please|right|now|this|week|weekend|upcoming|morning|evening|will|be|is|for|in|at|it|like)\b/i;

// A clear weather QUESTION with no attached location (e.g. "what's the
// weather today?") → the tool asks "Which location should I check?" instead of
// letting Gemini invent coordinates. Idiomatic chat ("the weather is nice") is
// NOT a question and does not match this signal.
const NO_LOCATION_WEATHER_QUESTION =
  /\b(?:what('s|\s+is)\s+(?:the\s+)?(?:weather|forecast|temperature)|how\s+(?:is\s+the\s+|hot\s+is\s+(?:it|the\s+weather|the\s+temperature)|cold\s+is\s+(?:it|the\s+weather)|warm\s+is\s+(?:it|the\s+weather))(?:weather|forecast|temperature)?|is\s+it\s+(?:raining?|snowing|sunny|cloudy|hot|cold|windy|foggy|stormy)|(?:weather|forecast|temperature|humidity)\s+(?:like\s+)?(?:today|now|tonight|right\s+now|tomorrow|this\s+week(?:end)?)|forecast\s+(?:for\s+)?(?:today|tonight|tomorrow|this\s+week(?:end)?)|temperature\s+(?:now|today|tonight|right\s+now)|is\s+the\s+(?:weather|forecast)\s+(?:good|bad|nice))\b/i;

/** Detects a weather intent (current or forecast) with a resolvable location. */
export function detectWeather(message: string): { intent: RealtimeIntent; params: RealtimeParams } | null {
  const lower = message.toLowerCase().trim();
  if (!WEATHER_KEYWORDS.test(lower)) return null;
  if (!WEATHER_REQUEST_SIGNAL.test(lower)) return null;

  const location = extractWeatherLocation(message);

  // No location, but an explicit weather QUESTION — answer with a location
  // prompt (never invent coordinates, never fall through to a Gemini guess).
  if (!location) {
    if (NO_LOCATION_WEATHER_QUESTION.test(lower)) {
      return { intent: "WEATHER_CURRENT", params: { location: "", weatherKind: "current" } };
    }
    return null;
  }

  const mentionsForecast =
    /\b(?:forecast|week|weekend|tomorrow|next\s+\d+|day\s+after|this\s+week)\b/i.test(lower);
  const mentionsNow = /\b(?:current|right\s+now|now|today)\b/i.test(lower);
  const isForecast = mentionsForecast && !mentionsNow;

  return {
    intent: isForecast ? "WEATHER_FORECAST" : "WEATHER_CURRENT",
    params: { location, weatherKind: isForecast ? "forecast" : "current" },
  };
}

function extractWeatherLocation(message: string): string | null {
  // Surface punctuation is extremely common in real chat ("weather in Chennai?")
  // and was breaking every $-anchored location pattern. Strip it up-front.
  const text = message.replace(/[?!.]+$/, "").trim();

  // "in/for/at <City>" at the end — covers "weather in Chennai",
  // "temperature in Chennai", "rain in Chennai", "forecast for Chennai".
  const tail = text.match(/\b(?:in|for|at)\s+([A-Za-z\u00C0-\u017F][A-Za-z\u00C0-\u017F .'’-]{1,39})$/i);
  if (tail) {
    const cleaned = tail[1]
      .trim()
      .replace(/\s+(?:tomorrow|tonight|today|now|right\s+now|this\s+week(?:end)?|soon)\s*$/i, "")
      .trim();
    if (cleaned && !WEATHER_STOP_WORDS.test(cleaned)) return cleaned;
  }

  // "weather/forecast/temperature in or for <City>" at the end.
  const forMatch = text.match(/\b(?:weather|forecast|temperature)\s+(?:for|in|at)\s+([A-Za-z\u00C0-\u017F][A-Za-z\u00C0-\u017F .'’-]{1,39})$/i);
  if (forMatch) {
    const cleaned = forMatch[1].trim();
    if (cleaned && !WEATHER_STOP_WORDS.test(cleaned)) return cleaned;
  }

  // "how hot is <City>" / "how cold is <City>" / "how warm is <City>".
  const howIs = text.match(/\bhow\s+(?:hot|cold|warm)\s+is\s+([A-Za-z\u00C0-\u017F][A-Za-z\u00C0-\u017F .'’-]{1,39})$/i);
  if (howIs) {
    const cleaned = howIs[1].trim();
    if (cleaned && !WEATHER_STOP_WORDS.test(cleaned)) return cleaned;
  }

  // "<City> weather/forecast" at the start.
  const leadMatch = text.match(/^([A-Za-z\u00C0-\u017F][A-Za-z\u00C0-\u017F .'’-]{1,39})\s+(?:weather|forecast|temperature)\b/i);
  if (leadMatch) {
    const cleaned = leadMatch[1].trim();
    if (cleaned && !WEATHER_STOP_WORDS.test(cleaned)) return cleaned;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Date / time detection
// ---------------------------------------------------------------------------

const TIME_GUARD_WORDS = /\b(?:should|wake|sleep|go\s+to|leave|start|finish|begin|end|meet|meeting|call|set\b|alarm|bus|train|class|school|work\b|study|appointment|dinner|lunch|breakfast|flight|trip|movie|concert|scheduled)\b/i;
const DATE_GUARD_WORDS = /\b(?:plan|schedule|session|deadline|due\b|exam|quiz|homework|assignment|remind|alarm|calendar|task|todo|study|book\b|cancel|edit|update|meeting|meet\b|appointment|event|trip|flight|party|wedding)\b/i;

interface DateTimeHit {
  intent: RealtimeIntent;
  params?: RealtimeParams;
}

function looksLikeDateQuery(lower: string): boolean {
  return (
    /\btomorrow\b|\byesterday\b|\bday\s+after\s+tomorrow\b|\bday\s+before\s+yesterday\b|\bin\s+\d+\s+(?:days?|weeks?|months?|years?)\b/.test(lower) ||
    /\bwhat\s+day\b/.test(lower) ||
    /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/.test(lower) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/i.test(lower)
  );
}

/** Detects current-date / current-time / date-math queries, or null. */
export function detectDateTime(message: string): DateTimeHit | null {
  const lower = message.toLowerCase().trim();
  if (!/\b(?:date|day|time|today|tomorrow|yesterday|clock|now)\b/i.test(lower)) return null;

  // Current time — including timezone-aliased time ("what time is it in Tokyo").
  if (
    /\bwhat\s+time\b|\bcurrent\s+time\b|\btime\s+is\s+it\b|\btime\s+now\b|\bwhat'?s\s+the\s+time\b|\bthe\s+time\b|\btime\s+in\b/i.test(lower)
  ) {
    if (!TIME_GUARD_WORDS.test(lower)) return { intent: "CURRENT_TIME" };
  }

  // Current date. Handles the possessive "today's date" (a real live-app bug:
  // `\w` does not match an apostrophe) plus every common live phrasing.
  if (
    /\btoday(?:'s|s)?\s+(?:date|day)\b|\bcurrent\s+date\b|\bdate\s+today\b|\bdate\s+is\s+it\b|\bwhat\s+date\s+is\s+it\b|\bwhat\s+day\s+is\s+(?:it|today)\b|\bwhat'?s\s+the\s+date\b|\bwhat\s+is\s+the\s+date\b/i.test(lower)
  ) {
    if (!DATE_GUARD_WORDS.test(lower)) return { intent: "CURRENT_DATE" };
  }

  // Date-math / named dates ("what day is tomorrow", "in 10 days",
  // "what day is 2026-12-25", "28 August 2026"). Checked AFTER current date so
  // "what day is today" / "what date is it" stay CURRENT_DATE.
  if (looksLikeDateQuery(lower)) {
    if (!DATE_GUARD_WORDS.test(lower)) return { intent: "DATE_QUERY" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public router
// ---------------------------------------------------------------------------

export interface RealtimeRoutingInput {
  message: string;
  /** True when the turn has attached/selected document sources. */
  hasSources?: boolean;
}

/**
 * Deterministically decides whether the real-time layer should answer this
 * message directly. Never calls an LLM. Document references win.
 */
export function detectRealtimeIntent(input: RealtimeRoutingInput): RealtimeDecision {
  const { message } = input;

  if (referencesDocument(message)) {
    return {
      intent: "NONE",
      handled: false,
      reason: "Message explicitly references a document/PDF/notes — document context wins over real-time tools.",
    };
  }

  // CALCULATION (pure arithmetic, strongest signal).
  const expression = extractCalculation(message);
  if (expression !== null) {
    return {
      intent: "CALCULATION",
      handled: true,
      reason: "Pure arithmetic expression",
      params: { expression },
    };
  }

  // CURRENCY.
  const currency = detectCurrency(message);
  if (currency) {
    if (currency.guard) {
      return {
        intent: currency.intent,
        handled: true,
        reason: "Currency query with an unparseable pair — asked to restate, never guessed",
        params: currency.params,
      };
    }
    return {
      intent: currency.intent,
      handled: true,
      reason: "Currency conversion / exchange-rate query",
      params: currency.params,
    };
  }

  // WEATHER.
  const weather = detectWeather(message);
  if (weather) {
    return {
      intent: weather.intent,
      handled: true,
      reason: "Weather query with a resolvable location",
      params: weather.params,
    };
  }

  // DATE / TIME.
  const dateTime = detectDateTime(message);
  if (dateTime) {
    const tz = resolveTimeZone(message);
    return {
      intent: dateTime.intent,
      handled: true,
      reason: "Current date / current time / date-math query",
      params: tz ? { ...dateTime.params, tz } : dateTime.params,
    };
  }

  return { intent: "NONE", handled: false, reason: "No real-time intent detected" };
}