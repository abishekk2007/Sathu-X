// ---------------------------------------------------------------------------
// Phase 6B Extended — Marine tool (Open-Meteo Marine API, keyless).
//
//   - Provider: https://marine-api.open-meteo.com/v1/marine (free, no key).
//   - Flow: location → geocoding → coordinates → marine API (ordered — never
//     parallelized; coordinates must resolve before the marine request).
//   - Same bounded timeout / max-2-attempt retry / short-TTL user-scoped LRU
//     conventions as the Phase 6A provider modules.
//   - Requested variables are limited to the marine question (wave height,
//     wave period, swell, sea surface temperature + relevant atmospheric wind
//     and precipitation). No unnecessary data is fetched.
//   - Safe errors: no invented coordinates, no URLs/keys/stack traces.
// ---------------------------------------------------------------------------

import { dedupeInFlight, LRU } from "../cache";
import { resolveDomainLocation, type GeocodedLocation } from "./domain-weather";

export const MARINE_TIMEOUT_MS = 6_000;
export const MARINE_MAX_ATTEMPTS = 2;
const MARINE_CACHE_TTL_MS = 10 * 60 * 1000;

const marineCache = new LRU<string, Record<string, unknown>>(200, MARINE_CACHE_TTL_MS);

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
        if (NON_RETRY_STATUS.has(res.status) || attempt === opts.maxAttempts) return outcome;
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
  return { code, message: "Live marine information isn't available right now. Please try again shortly." };
}

function statusToError(status: number): { code: string; message: string } {
  if (status === 429) {
    return { code: "marine_rate_limited", message: "The marine service is temporarily busy. Try again in a minute." };
  }
  return safeError("marine_upstream_error");
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

export interface MarineInput {
  location: string;
  /** Number of forecast days (bounded ≤ 7). */
  forecastDays: number;
  userId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
}

export interface MarineOutput {
  success: boolean;
  geo?: GeocodedLocation;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
  details: Record<string, unknown>;
}

/**
 * Fetches a bounded marine forecast (wave/swell/SST + atmospheric wind and
 * precipitation) for a coastal location. Never throws; never invents values.
 * Geocoding and the marine request are strictly ordered.
 */
export async function fetchMarineConditions(input: MarineInput): Promise<MarineOutput> {
  const location = input.location.trim();
  if (!location) {
    return {
      success: false,
      error: { code: "location_required", message: "Which coastal location should I check? Try \"the Chennai coast\"." },
      details: { provider: "open-meteo-marine" },
    };
  }
  const forecastDays = Math.min(Math.max(Math.trunc(input.forecastDays) || 1, 1), 7);

  const opts = {
    timeoutMs: input.timeoutMs ?? MARINE_TIMEOUT_MS,
    maxAttempts: input.maxAttempts ?? MARINE_MAX_ATTEMPTS,
    fetchImpl: input.fetchImpl,
    backoffMs: input.backoffMs ?? 200,
    userId: input.userId,
  };

  const resolved = await resolveDomainLocation(location, opts);
  if (!resolved.ok) {
    return {
      success: false,
      error: resolved.error,
      details: { provider: "open-meteo-marine", attempts: resolved.attempts, timedOut: resolved.timedOut },
    };
  }
  const geo = resolved.geo;

  const cacheKey =
    `realtime:marine:open-meteo:${input.userId ?? "anon"}:${geo.latitude}:${geo.longitude}:${forecastDays}`;
  const cached = marineCache.get(cacheKey);
  if (cached) {
    return { success: true, geo, payload: cached, details: { provider: "open-meteo-marine", cached: true } };
  }

  const dailyVars = [
    "wave_height_max",
    "wave_direction_dominant",
    "wave_period_max",
    "wind_wave_height_max",
    "wind_wave_direction_dominant",
    "wind_wave_period_max",
    "swell_wave_height_max",
    "swell_wave_direction_dominant",
    "swell_wave_period_max",
    "sea_surface_temperature_max",
  ].join(",");
  const hourlyVars = [
    "wind_speed_10m",
    "wind_gusts_10m",
    "precipitation_probability",
    "ocean_current_velocity",
  ].join(",");

  const endpoint =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${geo.latitude}&longitude=${geo.longitude}` +
    `&daily=${dailyVars}&hourly=${hourlyVars}&forecast_days=${forecastDays}&timezone=auto`;

  try {
    const outcome = await dedupeInFlight(cacheKey, () => requestWithRetry(endpoint, opts));

    if (!outcome.ok) {
      const base = { provider: "open-meteo-marine", attempts: outcome.attempts, timedOut: Boolean(outcome.timedOut) };
      if (typeof outcome.status === "number") {
        const mapped = statusToError(outcome.status);
        return { success: false, error: mapped, details: { ...base, status: outcome.status } };
      }
      return { success: false, error: safeError("marine_timeout_or_unreachable"), details: base };
    }

    const payload = await parseJson(outcome.response);
    if (!payload || !payload.daily || typeof payload.daily !== "object") {
      return {
        success: false,
        error: safeError("marine_malformed"),
        details: { provider: "open-meteo-marine", attempts: outcome.attempts },
      };
    }

    marineCache.set(cacheKey, payload);
    return { success: true, geo, payload, details: { provider: "open-meteo-marine", attempts: outcome.attempts } };
  } catch {
    return { success: false, error: safeError("marine_error"), details: { provider: "open-meteo-marine" } };
  }
}