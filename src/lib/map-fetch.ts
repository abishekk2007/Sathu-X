"use client";

/**
 * Phase 8 — client fetcher for the server-side Nominatim forwarder.
 *
 * The chat calls this only when a place search is actually needed (after a
 * "find X near me" turn with a shared location), and it is debounced upstream
 * — never an uncontrolled request loop. Results are normalised MapPlace[].
 */

import type { SharedLocation } from "@/lib/location";
import type { MapPlace } from "@/lib/map-utils";

export interface GeocodeResult {
  ok: boolean;
  places: MapPlace[];
  cached?: boolean;
  error?: "rate_limited" | "geocoder_error" | "bad_request";
}

export async function fetchNearbyPlaces(
  query: string,
  location?: SharedLocation,
  limit: number = 6
): Promise<GeocodeResult> {
  const params = new URLSearchParams();
  params.set("q", query.trim());
  params.set("limit", String(limit));
  if (location) {
    params.set("lat", String(location.latitude));
    params.set("lon", String(location.longitude));
  }
  try {
    const res = await fetch(`/api/maps/geocode?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const code = body.error;
      return {
        ok: false,
        places: [],
        error:
          code === "rate_limited"
            ? "rate_limited"
            : code === "bad_request"
              ? "bad_request"
              : "geocoder_error",
      };
    }
    const body = (await res.json()) as { places?: MapPlace[]; cached?: boolean };
    return {
      ok: true,
      places: Array.isArray(body.places) ? body.places : [],
      cached: body.cached,
    };
  } catch {
    return { ok: false, places: [], error: "geocoder_error" };
  }
}
