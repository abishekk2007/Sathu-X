// ---------------------------------------------------------------------------
// Phase 8 — Shared Nominatim geocoder (single implementation).
//
// Extracted from `src/app/api/maps/geocode/route.ts` so both the maps HTTP
// route AND the Phase 8C MAP_LOOKUP tool-adapter invoke the SAME geocoder —
// there is exactly one Nominatim forwarder in the app. It never throws;
// network failures surface as a typed outcome so callers fail open.
// ---------------------------------------------------------------------------

import { normalizePlace, type MapPlace } from "@/lib/map-utils";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";

/** In-memory LRU-ish cache to respect public Nominatim usage limits (1 req/s). */
const cache = new Map<string, unknown>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE = 200;

function cacheGet(key: string): unknown | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  const entry = hit as { at: number; data: unknown };
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

function cacheSet(key: string, data: unknown) {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { at: Date.now(), data });
}

/** Input to a geocode call — the query plus an optional coarse-location bias. */
export interface GeocodeRequest {
  /** Free-text place query ("hospitals", "coffee shops in chennai", …). */
  q: string;
  /** Optional coarse coordinates to bias/bias results toward. */
  latitude?: number;
  longitude?: number;
  /** Max results (clamped 1..12, default 6). */
  limit?: number;
}

/** Typed outcome — never throws. */
export type GeocodeOutcome =
  | { ok: true; places: MapPlace[]; cached: boolean }
  | {
      ok: false;
      /** HTTP-ish status for the route (429 / 502). */
      status: number;
      /** Machine-safe code for callers. */
      code: "rate_limited" | "geocoder_error" | "bad_request";
    };

/**
 * Forward a place query to Nominatim and normalize the results. Shared by the
 * HTTP route and the Phase 8C MAP_LOOKUP tool — the ONLY geocoder in the app.
 */
export async function geocodePlaces(
  request: GeocodeRequest,
  fetchImpl: typeof fetch = fetch
): Promise<GeocodeOutcome> {
  const q = String(request.q ?? "").trim();
  if (!q) return { ok: false, status: 400, code: "bad_request" };

  const params = new URLSearchParams();
  params.set("format", "jsonv2");
  params.set("q", q);
  params.set("limit", String(clampLimit(request.limit)));
  const lat = request.latitude;
  const lon = request.longitude;
  if (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    typeof lon === "number" &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  ) {
    // Bias results to the user's coarse location when provided.
    params.set("lat", String(lat));
    params.set("lon", String(lon));
    params.set("addressdetails", "1");
  }
  const cacheKey = params.toString();

  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    return { ok: true, places: cached as MapPlace[], cached: true };
  }

  try {
    const res = await fetchImpl(`${NOMINATIM_BASE}?${params.toString()}`, {
      headers: {
        "User-Agent": "SpideyBot/1.0 (educational assistant)",
        Accept: "application/json",
      },
      next: { revalidate: 60 },
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status === 429 ? 429 : 502,
        code: res.status === 429 ? "rate_limited" : "geocoder_error",
      };
    }
    const raw: Array<{
      place_id?: number | string;
      display_name?: string;
      lat?: string;
      lon?: string;
      type?: string;
      category?: string;
      address?: Record<string, unknown>;
    }> = await res.json();

    // Normalize + validate every result; drop anything without valid coords.
    const places = raw
      .map((r) =>
        normalizePlace({
          id: String(r.place_id ?? ""),
          name: r.display_name,
          displayName: r.display_name,
          lat: r.lat ? Number(r.lat) : undefined,
          lon: r.lon ? Number(r.lon) : undefined,
          category: r.category ?? r.type,
          address: formatAddress(r.address),
        })
      )
      .filter((p): p is MapPlace => p !== null);

    cacheSet(cacheKey, places);
    return { ok: true, places, cached: false };
  } catch {
    return { ok: false, status: 502, code: "geocoder_error" };
  }
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 6;
  return Math.max(1, Math.min(12, Math.floor(limit)));
}

function formatAddress(
  address?: Record<string, unknown>
): string | undefined {
  if (!address) return undefined;
  const parts = [
    address.road,
    address.suburb,
    address.city,
    address.town,
    address.village,
    address.state,
    address.country,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  return parts.length > 0 ? parts.join(", ") : undefined;
}
