// ---------------------------------------------------------------------------
// Phase 6A — Real-Time Intelligence. Shared types.
// Every real-time tool returns structured data (never throws) so callers can
// render a safe, deterministic answer or a safe failure message.
// ---------------------------------------------------------------------------

/** Intentions the real-time layer can answer deterministically without Gemini. */
export type RealtimeIntent =
  | "NONE"
  | "CURRENT_DATE"
  | "CURRENT_TIME"
  | "DATE_QUERY"
  | "WEATHER_CURRENT"
  | "WEATHER_FORECAST"
  | "CURRENCY_CONVERSION"
  | "EXCHANGE_RATE"
  | "CALCULATION";

/** Parsed parameters extracted by the deterministic router. */
export interface RealtimeParams {
  expression?: string;
  tz?: string;
  location?: string;
  weatherKind?: "current" | "forecast";
  from?: string;
  to?: string;
  amount?: number;
}

export interface RealtimeDecision {
  intent: RealtimeIntent;
  /** Whether the real-time layer should answer this message directly. */
  handled: boolean;
  reason: string;
  params?: RealtimeParams;
}

export interface RealtimeToolError {
  code: string;
  message: string;
}

/** Structured output for a handled real-time intent. */
export interface RealtimeToolResult {
  success: boolean;
  intent: RealtimeIntent;
  /** Stable tool id — internal only, never shown verbatim to users. */
  tool: string;
  /** The direct, grounded answer text (safe for the UI). */
  answer: string;
  /** Human-safe attribution label used internally (provider/tool name). */
  source: string;
  /** ISO timestamp of when the tool ran. */
  timestamp: string;
  /** IANA timezone used when the tool is time/date sensitive. */
  timezone?: string;
  details?: Record<string, unknown>;
  error?: RealtimeToolError;
}