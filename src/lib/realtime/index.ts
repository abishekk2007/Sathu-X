// ---------------------------------------------------------------------------
// Phase 6A — Real-Time Intelligence. Tool registry + orchestration.
//
// `executeRealtimeTool` runs the correct tool for a handled decision and
// ALWAYS returns a structured `RealtimeToolResult` (never throws). Simple
// deterministic answers (calculator, date/time) are produced directly — no
// Gemini. Weather/currency go through the provider adapters with timeouts,
// bounded retries, short-TTL user-scoped caching and safe failures.
//
// `buildRealtimeSystemInstruction` is the grounding block used whenever a
// Gemini explanation is (optionally) built around a tool result: the real
// measured value is injected verbatim so Gemini can never invent it.
// ---------------------------------------------------------------------------

import { evaluateExpression } from "./calculator";
import {
  computeDateQuery,
  defaultTimeZone,
  getDateTimeInfo,
  weekdayForCalendarDate,
} from "./date-time";
import { fetchRealtimeCurrency } from "./currency";
import { fetchRealtimeWeather } from "./weather";
import { detectRealtimeIntent, extractCalculation, referencesDocument } from "./intent";
import type {
  RealtimeDecision,
  RealtimeIntent,
  RealtimeToolResult,
} from "./types";
import {
  buildDomainSystemInstruction,
  detectDomainIntent,
  executeDomainTool,
  resolveDomainContext,
} from "./domain";

export {
  detectRealtimeIntent,
  referencesDocument,
  extractCalculation,
  evaluateExpression,
  computeDateQuery,
  defaultTimeZone,
  getDateTimeInfo,
  weekdayForCalendarDate,
  fetchRealtimeCurrency,
  fetchRealtimeWeather,
  detectDomainIntent,
  resolveDomainContext,
  executeDomainTool,
  buildDomainSystemInstruction,
};
export type {
  RealtimeDecision,
  RealtimeIntent,
  RealtimeParams,
  RealtimeToolResult,
} from "./types";
export type {
  DomainDecision,
  DomainIntent,
  DomainTimeframe,
  DomainToolResult,
} from "./domain";
export { WEATHER_TIMEOUT_MS } from "./weather";
export { CURRENCY_TIMEOUT_MS } from "./currency";
export { DOMAIN_WEATHER_TIMEOUT_MS, DOMAIN_WEATHER_MAX_ATTEMPTS } from "./domain-weather";
export { MARINE_TIMEOUT_MS, MARINE_MAX_ATTEMPTS } from "./marine";

export interface RealtimeExecuteInput {
  decision: RealtimeDecision;
  message: string;
  userId?: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

function fail(
  intent: RealtimeIntent,
  tool: string,
  code: string,
  message: string
): RealtimeToolResult {
  return {
    success: false,
    intent,
    tool,
    answer: message,
    source: tool,
    timestamp: new Date().toISOString(),
    error: { code, message },
  };
}

function formatCalendarWeekday(date: Date): string {
  const day = weekdayForCalendarDate(date);
  const month = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long" }).format(date);
  const year = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", year: "numeric" }).format(date);
  const dayNumber = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric" }).format(date);
  return `${dayNumber} ${month} ${year} (a ${day})`;
}

/**
 * Executes the tool for a handled decision. Never throws.
 */
export async function executeRealtimeTool(input: RealtimeExecuteInput): Promise<RealtimeToolResult> {
  const { decision, message } = input;
  const now = (input.now ?? (() => new Date()))();
  const intent = decision.intent;

  try {
    switch (intent) {
      case "CALCULATION": {
        const expression = decision.params?.expression ?? extractCalculation(message) ?? "";
        const result = evaluateExpression(expression);
        if (!result.ok) {
          return {
            success: false,
            intent,
            tool: "calculator",
            answer: result.message,
            source: "calculator",
            timestamp: now.toISOString(),
            error: { code: result.code, message: result.message },
            details: { expression },
          };
        }
        return {
          success: true,
          intent,
          tool: "calculator",
          answer: result.formatted,
          source: "calculator",
          timestamp: now.toISOString(),
          details: { expression, value: result.value },
        };
      }

      case "CURRENT_DATE": {
        const tz = decision.params?.tz ?? defaultTimeZone();
        const info = getDateTimeInfo(now, tz);
        return {
          success: true,
          intent,
          tool: "date-time",
          answer: `Today is ${info.dateText} (${info.tzName}, ${info.offsetLabel}).`,
          source: "date-time",
          timestamp: now.toISOString(),
          timezone: info.tzName,
          details: { ...info },
        };
      }

      case "CURRENT_TIME": {
        const tz = decision.params?.tz ?? defaultTimeZone();
        const info = getDateTimeInfo(now, tz);
        return {
          success: true,
          intent,
          tool: "date-time",
          answer: `It's ${info.timeText} (${info.tzName}, ${info.offsetLabel}).`,
          source: "date-time",
          timestamp: now.toISOString(),
          timezone: info.tzName,
          details: { ...info },
        };
      }

      case "DATE_QUERY": {
        const tz = decision.params?.tz ?? defaultTimeZone();
        const parsed = computeDateQuery(message, now);
        if (!parsed) {
          return fail(intent, "date-time", "date_parse_failed", "I couldn't work out which date you meant.");
        }
        const info = getDateTimeInfo(parsed.target, tz);
        const isRelative =
          /\b(?:tomorrow|yesterday|day\s+after\s+tomorrow|day\s+before\s+yesterday|in\s+\d+\s+(?:days?|weeks?|months?|years?))\b/i.test(message);
        const answer = isRelative
          ? `${parsed.label} falls on ${info.dateText} (${info.tzName}, ${info.offsetLabel}).`
          : `${parsed.label} is ${formatCalendarWeekday(parsed.target)}.`;
        return {
          success: true,
          intent,
          tool: "date-time",
          answer,
          source: "date-time",
          timestamp: now.toISOString(),
          timezone: isRelative ? info.tzName : "UTC",
          details: { ...info, targetIso: parsed.target.toISOString(), label: parsed.label },
        };
      }

      case "WEATHER_CURRENT":
      case "WEATHER_FORECAST": {
        const location = decision.params?.location ?? "";
        const kind = decision.params?.weatherKind ?? (intent === "WEATHER_FORECAST" ? "forecast" : "current");
        const outcome = await fetchRealtimeWeather({
          location,
          kind,
          userId: input.userId,
          fetchImpl: input.fetchImpl,
        });
        if (!outcome.success) {
          return fail(
            intent,
            "weather",
            outcome.error?.code ?? "weather_error",
            outcome.error?.message ?? "Live weather isn't available right now."
          );
        }
        return {
          success: true,
          intent,
          tool: "weather",
          answer: outcome.answer ?? "",
          source: "weather",
          timestamp: new Date().toISOString(),
          timezone: defaultTimeZone(),
          details: outcome.details,
        };
      }

      case "CURRENCY_CONVERSION":
      case "EXCHANGE_RATE": {
        const result = await fetchRealtimeCurrency({
          from: decision.params?.from ?? "",
          to: decision.params?.to ?? "",
          amount: decision.params?.amount ?? 1,
          userId: input.userId,
          fetchImpl: input.fetchImpl,
        });
        if (!result.success) {
          return fail(
            intent,
            "currency",
            result.error?.code ?? "currency_error",
            result.error?.message ?? "Live exchange rates aren't available right now."
          );
        }
        return {
          success: true,
          intent,
          tool: "currency",
          answer: result.answer ?? "",
          source: "currency",
          timestamp: new Date().toISOString(),
          details: result.details,
        };
      }

      default:
        return fail(intent, "unknown", "not_handled", "I couldn't handle that right now.");
    }
  } catch {
    return fail(intent, "unknown", "realtime_error", "Something went wrong with that request. Please try again.");
  }
}

/**
 * Grounding block for when a Gemini explanation is built around a tool result:
 * the measured value is injected verbatim so Gemini never invents a date,
 * rate, price, temperature or result.
 */
export function buildRealtimeSystemInstruction(result: RealtimeToolResult): string {
  const valueLine = result.success
    ? `The tool's verified output is: ${result.answer}`
    : `The tool could not produce a verified value (error: ${result.error?.code ?? "unknown"}). ` +
      "Do NOT invent one; explain the failure briefly and safely.";
  return (
    "REAL-TIME TOOL RESULT\n\n" +
    `Tool: ${result.tool}\n` +
    `Retrieved: ${result.timestamp}${result.timezone ? `\nUsing timezone: ${result.timezone}` : ""}\n\n` +
    `${valueLine}\n\n` +
    "Rules: Use exactly the value above. Never recalculate, estimate, or substitute a " +
    "different figure. If the user asked a follow-up, keep the numbers/rates/dates verbatim."
  );
}