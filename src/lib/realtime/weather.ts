// ---------------------------------------------------------------------------
// Phase 6A — Weather tool (provider-backed, safe).
//
//   - Provider: Open-Meteo (free/non-commercial, NO API key required).
//        Geocoding : https://geocoding-api.open-meteo.com/v1/search
//        Forecast  : https://api.open-meteo.com/v1/forecast
//   - Flow: resolve "Chennai" → coordinates (geocoding) → current/daily data.
//   - AbortController timeout + bounded retries (max 2 attempts). NO retry on
//     4xx (unknown city / rate limit / bad request) — surfaced once.
//   - Deterministic WMO weather_code → human-readable condition mapping (never
//     delegated to an LLM). No predictions are ever invented.
//   - Short-TTL LRU caches, keyed per user and coordinates:
//        geocode  : realtime:geocode:open-meteo:{userId}:{location}
//        forecast : realtime:openmeteo:{userId}:{kind}:{lat}:{lon}
//     The variable set is fixed for each kind (current vs daily), so the kind
//     + coordinates uniquely identify the cached payload.
//   - Safe error messages: no URLs, no internal shapes, no stack traces.
//       No location -> "Which location should I check?" (never invent user
//       location, never let Gemini guess coordinates).
// ---------------------------------------------------------------------------

import { dedupeInFlight, LRU } from "../cache";

export type WeatherKind = "current" | "forecast";

export interface WeatherToolInput {
  location: string;
  kind: WeatherKind;
  userId?: string;
  fetchImpl?: typeof fetch;
  /** Test knob — overrides the default provider timeout. */
  timeoutMs?: number;
  /** Test knob — overrides the default retry budget. */
  maxAttempts?: number;
  /** Test knob — overrides the default retry backoff. */
  backoffMs?: number;
}

export interface WeatherToolOutput {
  success: boolean;
  answer?: string;
  error?: { code: string; message: string };
  details: Record<string, unknown>;
}

export const WEATHER_TIMEOUT_MS = 6_000;
export const WEATHER_MAX_ATTEMPTS = 2;
export const WEATHER_CACHE_TTL_MS = 5 * 60 * 1000;
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedWeather {
  answer: string;
  timestamp: string;
  details: Record<string, unknown>;
}

interface GeoResult {
  name: string;
  country?: string;
  admin1?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
}

// ---------------------------------------------------------------------------
// WMO weather_code → human-readable condition (deterministic, shared by all
// Open-Meteo data: current + daily).
// ---------------------------------------------------------------------------

interface Condition {
  label: string;
  icon: string;
}

const WMO_CONDITIONS: Record<number, Condition> = {
  0: { label: "Clear sky", icon: "☀️" },
  1: { label: "Mainly clear", icon: "🌤️" },
  2: { label: "Partly cloudy", icon: "⛅" },
  3: { label: "Overcast", icon: "☁️" },
  45: { label: "Fog", icon: "🌫️" },
  48: { label: "Fog", icon: "🌫️" },
  51: { label: "Light drizzle", icon: "🌦️" },
  53: { label: "Drizzle", icon: "🌦️" },
  55: { label: "Heavy drizzle", icon: "🌦️" },
  56: { label: "Freezing drizzle", icon: "🌧️" },
  57: { label: "Freezing drizzle", icon: "🌧️" },
  61: { label: "Light rain", icon: "🌧️" },
  63: { label: "Rain", icon: "🌧️" },
  65: { label: "Heavy rain", icon: "🌧️" },
  66: { label: "Freezing rain", icon: "🌧️" },
  67: { label: "Freezing rain", icon: "🌧️" },
  71: { label: "Light snow", icon: "🌨️" },
  73: { label: "Snow", icon: "🌨️" },
  75: { label: "Heavy snow", icon: "🌨️" },
  77: { label: "Snow grains", icon: "🌨️" },
  80: { label: "Light rain showers", icon: "🌦️" },
  81: { label: "Rain showers", icon: "🌧️" },
  82: { label: "Violent rain showers", icon: "⛈️" },
  85: { label: "Snow showers", icon: "🌨️" },
  86: { label: "Snow showers", icon: "🌨️" },
  95: { label: "Thunderstorm", icon: "⛈️" },
  96: { label: "Thunderstorm with hail", icon: "⛈️" },
  99: { label: "Thunderstorm with hail", icon: "⛈️" },
};

function conditionFor(code: unknown): Condition {
  const value = typeof code === "number" ? code : Number(code);
  return WMO_CONDITIONS[value] ?? { label: "Mixed conditions", icon: "🌡️" };
}

const weatherCache = new LRU<string, CachedWeather>(200, WEATHER_CACHE_TTL_MS);
const geocodeCache = new LRU<string, GeoResult>(200, GEOCODE_CACHE_TTL_MS);

const NON_RETRY_STATUS = new Set([400, 404, 422, 429]);

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await (fetchImpl ?? globalThis.fetch)(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}

interface RequestOutcome {
  ok: boolean;
  status?: number;
  attempts: number;
  timedOut?: boolean;
  response?: Response;
}

async function requestWithRetry(
  url: string,
  opts: {
    timeoutMs: number;
    maxAttempts: number;
    fetchImpl?: typeof fetch;
    backoffMs?: number;
  }
): Promise<RequestOutcome> {
  const backoffBase = opts.backoffMs ?? 200;
  let outcome: RequestOutcome = { ok: false, attempts: 0 };

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url, opts.timeoutMs, opts.fetchImpl);
      if (!res.ok) {
        outcome = { ok: false, status: res.status, attempts: attempt };
        if (NON_RETRY_STATUS.has(res.status) || attempt === opts.maxAttempts) {
          return outcome;
        }
      } else {
        return { ok: true, status: res.status, attempts: attempt, response: res };
      }
    } catch (error) {
      outcome = {
        ok: false,
        attempts: attempt,
        timedOut: error instanceof Error && error.name === "AbortError",
      };
      if (attempt === opts.maxAttempts) return outcome;
    }
    if (attempt < opts.maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, backoffBase * attempt));
    }
  }

  return outcome;
}

function safeError(code: string): { code: string; message: string } {
  return { code, message: "Live weather isn't available right now. Please try again shortly." };
}

function statusToError(status: number): { code: string; message: string } {
  if (status === 429) {
    return { code: "weather_rate_limited", message: "Live weather is temporarily busy. Try again in a minute." };
  }
  return safeError("weather_upstream_error");
}

async function parseJson(response: Response | undefined): Promise<Record<string, unknown> | null> {
  if (!response) return null;
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickGeoResult(results: GeoResult[], query: string): GeoResult | null {
  if (!Array.isArray(results) || results.length === 0) return null;
  const q = query.toLowerCase();
  let best: GeoResult | null = null;
  let bestScore = -1;
  for (const r of results) {
    if (!r || typeof r.name !== "string") continue;
    if (asNumber(r.latitude) == null || asNumber(r.longitude) == null) continue;
    let score = asNumber(r.latitude) != null && asNumber(r.longitude) != null ? 1 : 0;
    const name = r.name.toLowerCase();
    if (name === q) score += 4;
    else if (name.startsWith(q)) score += 2;
    if (typeof r.admin1 === "string" && r.admin1) score += 1;
    if (typeof r.country === "string" && r.country) score += 1;
    if (typeof r.timezone === "string" && r.timezone) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/** Geocodes a free-text location to coordinates + display metadata. */
async function geocode(
  location: string,
  opts: { timeoutMs: number; maxAttempts: number; fetchImpl?: typeof fetch; backoffMs?: number; userId?: string }
): Promise<{ ok: true; geo: GeoResult } | { ok: false; error: { code: string; message: string }; attempts: number; timedOut: boolean }> {
  const cacheKey = `realtime:geocode:open-meteo:${opts.userId ?? "anon"}:${location.toLowerCase()}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached) return { ok: true, geo: cached };

  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=5&language=en&format=json`;

  const outcome = await requestWithRetry(url, opts);

  if (!outcome.ok) {
    if (typeof outcome.status === "number") {
      const mapped = statusToError(outcome.status);
      return { ok: false, error: mapped, attempts: outcome.attempts, timedOut: Boolean(outcome.timedOut) };
    }
    return {
      ok: false,
      error: safeError("weather_timeout_or_unreachable"),
      attempts: outcome.attempts,
      timedOut: Boolean(outcome.timedOut),
    };
  }

  const payload = await parseJson(outcome.response);
  const results = payload?.results as GeoResult[] | undefined;
  const best = pickGeoResult(results ?? [], location);
  if (!best) {
    return {
      ok: false,
      error: {
        code: "location_not_found",
        message: "I couldn't find live weather for that place. Try a city name like Chennai, Mumbai or London.",
      },
      attempts: outcome.attempts,
      timedOut: false,
    };
  }

  geocodeCache.set(cacheKey, best);
  return { ok: true, geo: best };
}

// ---------------------------------------------------------------------------
// Answer builders
// ---------------------------------------------------------------------------

function headline(geo: GeoResult): string {
  const parts = [geo.name];
  if (typeof geo.admin1 === "string" && geo.admin1) parts.push(geo.admin1);
  if (typeof geo.country === "string" && geo.country) parts.push(geo.country);
  return parts.join(", ");
}

function fmtNumber(value: number, digits = 1): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function describeCurrent(
  payload: Record<string, unknown>,
  geo: GeoResult
): { answer: string; details: Record<string, unknown> } | null {
  const current = payload.current as Record<string, unknown> | undefined;
  if (!current || typeof current !== "object") return null;

  const temp = asNumber(current.temperature_2m);
  const feels = asNumber(current.apparent_temperature);
  const humidity = asNumber(current.relative_humidity_2m);
  const precip = asNumber(current.precipitation);
  const code = current.weather_code;
  const wind = asNumber(current.wind_speed_10m);
  const time = typeof current.time === "string" ? current.time : "";
  if (temp == null || feels == null || humidity == null || precip == null || code == null || wind == null) {
    return null;
  }

  const condition = conditionFor(code);
  const timezone = typeof payload.timezone === "string" ? payload.timezone : "";
  const checked = time ? `${time} local` : "";

  const answer = [
    `Currently in ${headline(geo)}:`,
    `🌡️ Temperature: ${Math.round(temp)}°C (feels like ${Math.round(feels)}°C)`,
    `${condition.icon} Condition: ${condition.label}`,
    `💧 Humidity: ${Math.round(humidity)}%`,
    `💨 Wind: ${Math.round(wind)} km/h`,
    `🌧️ Precipitation: ${fmtNumber(precip)} mm`,
    "",
    checked ? `Checked: ${checked}${timezone ? ` (${timezone})` : ""}` : "",
    "Source: Open-Meteo",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    answer,
    details: {
      city: geo.name,
      country: geo.country ?? "",
      admin1: geo.admin1 ?? "",
      latitude: geo.latitude,
      longitude: geo.longitude,
      timezone,
      tempC: Math.round(temp),
      apparentTempC: Math.round(feels),
      condition: condition.label,
      humidity: Math.round(humidity),
      precipitationMm: precip,
      windKph: Math.round(wind),
      checkedLocal: checked,
    },
  };
}

interface DayEntry {
  date: string;
  weekdayLabel: string;
  hi: number;
  lo: number;
  condition: string;
  icon: string;
  precipProb: number | null;
  windKph: number | null;
}

function describeForecast(
  payload: Record<string, unknown>,
  geo: GeoResult
): { answer: string; details: Record<string, unknown> } | null {
  const daily = payload.daily as Record<string, unknown> | undefined;
  if (!daily || typeof daily !== "object") return null;

  const dates = Array.isArray(daily.time) ? (daily.time as string[]) : [];
  const codes = Array.isArray(daily.weather_code) ? (daily.weather_code as unknown[]) : [];
  const highs = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
  const lows = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
  const probs = Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max : [];
  const winds = Array.isArray(daily.wind_speed_10m_max) ? daily.wind_speed_10m_max : [];
  if (dates.length === 0) return null;

  const timezone = typeof payload.timezone === "string" ? payload.timezone : "";
  const weekdayFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  const entries: DayEntry[] = [];
  for (let i = 0; i < Math.min(dates.length, 5); i += 1) {
    const date = dates[i];
    const hi = asNumber(highs[i]);
    const lo = asNumber(lows[i]);
    if (hi == null || lo == null || typeof date !== "string") continue;
    const condition = conditionFor(codes[i]);
    const parsed = new Date(`${date}T00:00:00Z`);
    entries.push({
      date,
      weekdayLabel: Number.isNaN(parsed.getTime()) ? date : weekdayFormatter.format(parsed),
      hi: Math.round(hi),
      lo: Math.round(lo),
      condition: condition.label,
      icon: condition.icon,
      precipProb: asNumber(probs[i]),
      windKph: asNumber(winds[i]),
    });
  }
  if (entries.length === 0) return null;

  const lines = entries.map((e) => {
    const rain = e.precipProb != null ? `, ${e.precipProb}% rain chance` : "";
    return `${e.weekdayLabel} — ${e.hi}°/${e.lo}°, ${e.icon} ${e.condition}${rain}`;
  });

  const checked = payload.current && typeof payload.current === "object" && typeof (payload.current as { time?: unknown }).time === "string"
    ? ((payload.current as { time: string }).time + " local")
    : "";
  const answer = [
    `Forecast for ${headline(geo)} (next ${entries.length} days):`,
    ...lines,
    "",
    checked ? `Checked: ${checked}${timezone ? ` (${timezone})` : ""}` : "",
    "Source: Open-Meteo",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    answer,
    details: {
      city: geo.name,
      country: geo.country ?? "",
      admin1: geo.admin1 ?? "",
      latitude: geo.latitude,
      longitude: geo.longitude,
      timezone,
      days: entries,
    },
  };
}

/**
 * Fetches live weather for `location` (current or 5-day forecast) using
 * Open-Meteo (no API key). Never throws; never invents values; always returns
 * a structured result.
 */
export async function fetchRealtimeWeather(input: WeatherToolInput): Promise<WeatherToolOutput> {
  const location = input.location.trim();
  if (!location) {
    return {
      success: false,
      error: { code: "location_required", message: "Which location should I check? Try \"weather in Chennai\"." },
      details: { provider: "open-meteo" },
    };
  }

  const opts = {
    timeoutMs: input.timeoutMs ?? WEATHER_TIMEOUT_MS,
    maxAttempts: input.maxAttempts ?? WEATHER_MAX_ATTEMPTS,
    fetchImpl: input.fetchImpl,
    backoffMs: input.backoffMs ?? 200,
    userId: input.userId,
  };

  const resolved = await geocode(location, opts);
  if (!resolved.ok) {
    return {
      success: false,
      error: resolved.error,
      details: { provider: "open-meteo", attempts: resolved.attempts, timedOut: resolved.timedOut },
    };
  }
  const geo = resolved.geo;

  const cacheKey =
    `realtime:openmeteo:${input.userId ?? "anon"}:${input.kind}:${geo.latitude}:${geo.longitude}`;
  const cached = weatherCache.get(cacheKey);
  if (cached) {
    return { success: true, answer: cached.answer, details: { ...cached.details, cached: true } };
  }

  const currentVars =
    "current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m";
  const dailyVars =
    "daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max&forecast_days=5";
  const endpoint =
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}` +
    `&${currentVars}&${dailyVars}&timezone=auto`;

  try {
    const outcome = await dedupeInFlight(cacheKey, () =>
      requestWithRetry(endpoint, opts)
    );

    if (!outcome.ok) {
      const base = { provider: "open-meteo", attempts: outcome.attempts, timedOut: Boolean(outcome.timedOut) };
      if (typeof outcome.status === "number") {
        const mapped = statusToError(outcome.status);
        return { success: false, error: mapped, details: { ...base, status: outcome.status } };
      }
      return { success: false, error: safeError("weather_timeout_or_unreachable"), details: base };
    }

    const payload = await parseJson(outcome.response);
    if (!payload) {
      return {
        success: false,
        error: safeError("weather_malformed"),
        details: { provider: "open-meteo", attempts: outcome.attempts },
      };
    }

    const described =
      input.kind === "forecast" ? describeForecast(payload, geo) : describeCurrent(payload, geo);
    if (!described) {
      return {
        success: false,
        error: safeError("weather_malformed"),
        details: { provider: "open-meteo", attempts: outcome.attempts },
      };
    }

    const details: Record<string, unknown> = {
      ...described.details,
      attempts: outcome.attempts,
      provider: "open-meteo",
      timestamp: new Date().toISOString(),
    };
    weatherCache.set(cacheKey, {
      answer: described.answer,
      timestamp: new Date().toISOString(),
      details: described.details,
    });
    return { success: true, answer: described.answer, details };
  } catch {
    // Absorb any unexpected failure so the caller always gets a structured result.
    return { success: false, error: safeError("weather_error"), details: { provider: "open-meteo" } };
  }
}