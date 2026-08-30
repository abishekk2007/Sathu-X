// ---------------------------------------------------------------------------
// Phase 6B Extended — Domain weather data layer (Open-Meteo, keyless).
//
// Shared provider for the ADVICE domains (agriculture / aviation / smart-city /
// travel / outdoor). Mirrors the Phase 6A provider conventions exactly:
//   - Geocoding via the free Open-Meteo geocoding API (no API key).
//   - Bounded AbortController timeouts + max 2 attempts, never retrying 4xx.
//   - Short-TTL LRU caches per user, distinguishing provider / data type /
//     latitude/longitude / forecast horizon / requested variable set
//     (a "Chennai" entry can never be served to a "Mumbai" request).
//   - Deterministic WMO code → condition mapping (no LLM).
//   - Safe error messages with no URLs / keys / stack traces.
//
// This module deliberately does NOT touch `weather.ts` (Phase 6A). It fetches
// the richer hourly/multi-variable surface needed for domain advisories while
// reusing the same patterns the codebase already repeats in weather/currency.
// ---------------------------------------------------------------------------

import { dedupeInFlight, LRU } from "../cache";

export interface GeocodedLocation {
  name: string;
  country?: string;
  admin1?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
}

export interface DomainWeatherInput {
  location: string;
  /** Open-Meteo hourly variable names (only what the domain needs). */
  hourly: string[];
  /** Number of forecast days (bounded ≤ 7). */
  forecastDays: number;
  userId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  /** Stable id included in the cache key (provider+kind+domain). */
  cacheTag: string;
}

export interface DomainWeatherOutput {
  success: boolean;
  geo?: GeocodedLocation;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
  details: Record<string, unknown>;
}

export const DOMAIN_WEATHER_TIMEOUT_MS = 6_000;
export const DOMAIN_WEATHER_MAX_ATTEMPTS = 2;
const DOMAIN_WEATHER_CACHE_TTL_MS = 5 * 60 * 1000;
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const weatherCache = new LRU<string, Record<string, unknown>>(200, DOMAIN_WEATHER_CACHE_TTL_MS);
const geocodeCache = new LRU<string, GeocodedLocation>(200, GEOCODE_CACHE_TTL_MS);

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
  opts: { timeoutMs: number; maxAttempts: number; fetchImpl?: typeof fetch; backoffMs?: number }
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
  return { code, message: "Live weather information isn't available right now. Please try again shortly." };
}

function statusToError(status: number): { code: string; message: string } {
  if (status === 429) {
    return { code: "domain_weather_rate_limited", message: "Live weather is temporarily busy. Try again in a minute." };
  }
  return safeError("domain_weather_upstream_error");
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

function pickGeoResult(results: GeocodedLocation[], query: string): GeocodedLocation | null {
  if (!Array.isArray(results) || results.length === 0) return null;
  const q = query.toLowerCase();
  let best: GeocodedLocation | null = null;
  let bestScore = -1;
  for (const r of results) {
    if (!r || typeof r.name !== "string") continue;
    if (asNumber(r.latitude) == null || asNumber(r.longitude) == null) continue;
    let score = 1;
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
export async function resolveDomainLocation(
  location: string,
  opts: {
    userId?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxAttempts?: number;
    backoffMs?: number;
  }
): Promise<{ ok: true; geo: GeocodedLocation } | { ok: false; error: { code: string; message: string }; attempts: number; timedOut: boolean }> {
  const cacheKey = `realtime:domain-geocode:open-meteo:${opts.userId ?? "anon"}:${location.toLowerCase()}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached) return { ok: true, geo: cached };

  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=5&language=en&format=json`;

  const outcome = await requestWithRetry(url, {
    timeoutMs: opts.timeoutMs ?? DOMAIN_WEATHER_TIMEOUT_MS,
    maxAttempts: opts.maxAttempts ?? DOMAIN_WEATHER_MAX_ATTEMPTS,
    fetchImpl: opts.fetchImpl,
    backoffMs: opts.backoffMs ?? 200,
  });

  if (!outcome.ok) {
    if (typeof outcome.status === "number") {
      return { ok: false, error: statusToError(outcome.status), attempts: outcome.attempts, timedOut: Boolean(outcome.timedOut) };
    }
    return {
      ok: false,
      error: safeError("domain_weather_timeout_or_unreachable"),
      attempts: outcome.attempts,
      timedOut: Boolean(outcome.timedOut),
    };
  }

  const payload = await parseJson(outcome.response);
  const results = payload?.results as GeocodedLocation[] | undefined;
  const best = pickGeoResult(results ?? [], location);
  if (!best) {
    return {
      ok: false,
      error: {
        code: "location_not_found",
        message: "I couldn't find live information for that place. Try a city name like Chennai, Mumbai or London.",
      },
      attempts: outcome.attempts,
      timedOut: false,
    };
  }

  geocodeCache.set(cacheKey, best);
  return { ok: true, geo: best };
}

/**
 * Fetches a bounded hourly Open-Meteo forecast for a resolved location using
 * only the requested variables. Never throws; never invents values.
 */
export async function fetchDomainWeather(input: DomainWeatherInput): Promise<DomainWeatherOutput> {
  const location = input.location.trim();
  if (!location) {
    return {
      success: false,
      error: { code: "location_required", message: "Which location should I check? Try \"weather in Chennai\"." },
      details: { provider: "open-meteo", cacheTag: input.cacheTag },
    };
  }
  const forecastDays = Math.min(Math.max(Math.trunc(input.forecastDays) || 1, 1), 7);
  const hourly = input.hourly.filter(Boolean);
  if (hourly.length === 0) {
    return {
      success: false,
      error: { code: "domain_weather_no_variables", message: "No weather variables were requested." },
      details: { provider: "open-meteo" },
    };
  }

  const opts = {
    timeoutMs: input.timeoutMs ?? DOMAIN_WEATHER_TIMEOUT_MS,
    maxAttempts: input.maxAttempts ?? DOMAIN_WEATHER_MAX_ATTEMPTS,
    fetchImpl: input.fetchImpl,
    backoffMs: input.backoffMs ?? 200,
    userId: input.userId,
  };

  const resolved = await resolveDomainLocation(location, opts);
  if (!resolved.ok) {
    return {
      success: false,
      error: resolved.error,
      details: { provider: "open-meteo", attempts: resolved.attempts, timedOut: resolved.timedOut, cacheTag: input.cacheTag },
    };
  }
  const geo = resolved.geo;

  const varSignature = [...hourly].sort().join(",");
  const cacheKey =
    `realtime:domain:${input.cacheTag}:${opts.userId ?? "anon"}:${geo.latitude}:${geo.longitude}:${forecastDays}:${varSignature}`;
  const cached = weatherCache.get(cacheKey);
  if (cached) {
    return { success: true, geo, payload: cached, details: { provider: "open-meteo", cached: true, cacheTag: input.cacheTag } };
  }

  const endpoint =
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}` +
    `&hourly=${encodeURIComponent(hourly.join(","))}&forecast_days=${forecastDays}&timezone=auto`;

  try {
    const outcome = await dedupeInFlight(cacheKey, () => requestWithRetry(endpoint, opts));

    if (!outcome.ok) {
      const base = { provider: "open-meteo", attempts: outcome.attempts, timedOut: Boolean(outcome.timedOut), cacheTag: input.cacheTag };
      if (typeof outcome.status === "number") {
        const mapped = statusToError(outcome.status);
        return { success: false, error: mapped, details: { ...base, status: outcome.status } };
      }
      return { success: false, error: safeError("domain_weather_timeout_or_unreachable"), details: base };
    }

    const payload = await parseJson(outcome.response);
    if (!payload || !payload.hourly || typeof payload.hourly !== "object") {
      return {
        success: false,
        error: safeError("domain_weather_malformed"),
        details: { provider: "open-meteo", attempts: outcome.attempts, cacheTag: input.cacheTag },
      };
    }

    weatherCache.set(cacheKey, payload);
    return { success: true, geo, payload, details: { provider: "open-meteo", attempts: outcome.attempts, cacheTag: input.cacheTag } };
  } catch {
    return { success: false, error: safeError("domain_weather_error"), details: { provider: "open-meteo", cacheTag: input.cacheTag } };
  }
}

// ---------------------------------------------------------------------------
// Deterministic WMO weather_code → human-readable condition (shared by all
// domain modules; compact copy of the Phase 6A table — that module stays
// untouched, this one is data-only).
// ---------------------------------------------------------------------------

const WMO_CONDITIONS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Rain showers",
  82: "Violent rain showers",
  85: "Snow showers",
  86: "Snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with hail",
};

export function conditionFor(code: number | null): string {
  if (code === null || !Number.isFinite(code)) return "Not available";
  return WMO_CONDITIONS[code] ?? "Mixed conditions";
}