import { z } from "zod";

import { geocodePlaces } from "@/lib/map-geocode";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const querySchema = z.object({
  q: z.string().trim().min(1).max(200),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  limit: z.coerce.number().int().min(1).max(12).default(6),
});

/**
 * GET /api/maps/geocode?q=...&lat=&lon=&limit=
 *
 * Server-side forwarder to Nominatim (OSM's public geocoder). Kept on the
 * server so (a) no public API key is ever needed, (b) Nominatim's usage
 * policy is respected with a shared cache, and (c) the user's coarse
 * coords are NOT a required part of a generic query (q or lat/lon).
 *
 * Results are normalised to MapPlace and returned in application terms. The
 * single shared geocoder implementation lives in @/lib/map-geocode (used by
 * both this HTTP route and the Phase 8C MAP_LOOKUP tool).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    q: url.searchParams.get("q"),
    lat: url.searchParams.get("lat"),
    lon: url.searchParams.get("lon"),
    limit: url.searchParams.get("limit"),
  });
  if (!parsed.success) return jsonError(400, "bad_request");
  const { q, lat, lon, limit } = parsed.data;

  const outcome = await geocodePlaces({
    q,
    latitude: lat,
    longitude: lon,
    limit,
  });

  if (!outcome.ok) {
    return jsonError(
      outcome.status,
      outcome.code === "rate_limited" ? "rate_limited" : "geocoder_error"
    );
  }

  // Preserve the old cached flag semantics for the client.
  return Response.json({ places: outcome.places, cached: outcome.cached });
}
