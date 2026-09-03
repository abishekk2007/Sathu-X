/**
 * Phase 8 — Leaflet / OpenStreetMap: coordinate validation + place normalization.
 *
 * All coordinate validation reuses the same range checks as src/lib/location.ts
 * (latitude -90..90, longitude -180..180, finite numbers only). Nothing here
 * fabricates coordinates — invalid data is rejected, never patched.
 */

import { buildGoogleMapsSearchLink, type SharedLocation } from "@/lib/location";

/* -------------------------------------------------------------------------- */
/*  Coordinate validation                                                     */
/* -------------------------------------------------------------------------- */

export interface ValidCoordinate {
  latitude: number;
  longitude: number;
}

/**
 * Validates a raw coordinate pair. Returns null for anything that is not a
 * finite, in-range number — identical semantics to sanitizeUserLocation but
 * returns the raw pair instead of a coarsened SharedLocation.
 */
export function validateCoordinate(
  lat: unknown,
  lng: unknown
): ValidCoordinate | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { latitude: lat, longitude: lng };
}

/**
 * Coarsens a validated coordinate to the same precision as SharedLocation
 * (2 decimal places ≈ 1.1 km) for display on the map user-location marker.
 */
export function toSharedLocation(coord: ValidCoordinate): SharedLocation {
  const scale = 100;
  return {
    latitude: Math.round(coord.latitude * scale) / scale,
    longitude: Math.round(coord.longitude * scale) / scale,
  };
}

/* -------------------------------------------------------------------------- */
/*  Map place (normalised from any source)                                    */
/* -------------------------------------------------------------------------- */

export interface MapPlace {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  category?: string;
  address?: string;
  distanceMeters?: number;
  sourceUrl?: string;
  openInGoogleMaps?: string;
}

/**
 * Normalizes raw place data into a MapPlace. Returns null when the input
 * lacks valid coordinates — invalid data is never patched or invented.
 */
export function normalizePlace(
  raw: {
    id?: string;
    name?: string;
    displayName?: string;
    latitude?: number;
    longitude?: number;
    lat?: number;
    lon?: number;
    category?: string;
    type?: string;
    address?: string;
    distanceMeters?: number;
    sourceUrl?: string;
  } | null
    | undefined
): MapPlace | null {
  if (!raw) return null;
  const lat = raw.latitude ?? raw.lat;
  const lng = raw.longitude ?? raw.lon;
  const coord = validateCoordinate(lat, lng);
  if (!coord) return null;

  const name = raw.name ?? raw.displayName ?? "Unknown place";
  const sharedLoc = toSharedLocation(coord);

  return {
    id: raw.id ?? `place-${coord.latitude}-${coord.longitude}`,
    name,
    latitude: coord.latitude,
    longitude: coord.longitude,
    category: raw.category ?? raw.type,
    address: raw.address,
    distanceMeters: raw.distanceMeters,
    sourceUrl: raw.sourceUrl,
    openInGoogleMaps: buildGoogleMapsSearchLink(sharedLoc, name),
  };
}

/**
 * Filters a list of raw place objects to only those with valid coordinates.
 * Invalid entries are silently dropped — never reported to the user.
 */
export function filterValidPlaces(
  places: Array<Record<string, unknown>> | null | undefined
): MapPlace[] {
  if (!Array.isArray(places)) return [];
  return places
    .map((p) => normalizePlace(p as Parameters<typeof normalizePlace>[0]))
    .filter((p): p is MapPlace => p !== null);
}

/* -------------------------------------------------------------------------- */
/*  Marker icon factory                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Creates a Leaflet DivIcon for map markers. Uses a custom SVG circle
 * instead of the default blue pin image, avoiding the well-known webpack
 * marker-icon path issue with bundled leaflet assets.
 */
export function createMarkerIcon(
  color: string,
  size: number = 28
): string /* returns an SVG string used as DivIcon HTML */ {
  const r = size / 2;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${r}" cy="${r}" r="${r - 2}" fill="${color}" stroke="#fff" stroke-width="2"/>
  </svg>`;
}

/* -------------------------------------------------------------------------- */
/*  Place-query derivation (near-me phrasing)                                 */
/* -------------------------------------------------------------------------- */

const NEAR_ME_PATTERN =
  /\b(?:near\s+(?:me|my|here|us|by)|around\s+(?:me|here|us)|closest|closer|nearby|in\s+my\s+area|where\s+(?:can|do|does)\s+I|how\s+far)\b/i;

/**
 * Extracts a searchable place noun from a "find X near me" style query so the
 * app can geocode it via Nominatim. Returns null when the query isn't clearly
 * a near-me place search (so a map is not forced where it doesn't belong).
 *
 * Examples:
 *   "find hospitals near me"            -> "hospitals"
 *   "coffee shops around here"          -> "coffee shops"
 *   "closest pharmacy nearby"           -> "pharmacy"
 *   "what is the weather in chennai"    -> null (not a near-me place search)
 */
export function derivePlaceQuery(message: string): string | null {
  const text = (message || "").trim();
  if (!text) return null;
  // Only near-me queries produce a map — placement is never forced elsewhere.
  if (!NEAR_ME_PATTERN.test(text)) return null;

  // Strip near-me modifiers, then leading imperative verbs + optional filler
  // ("find hospitals", "show me cafés", "locate ATMs nearby", "where can I get
  // a pharmacy close by", …).
  const candidate = text
    .replace(
      /\b(?:near\s+(?:me|my|here|us|by)|around\s+(?:me|here|us)|closest|closer|nearby|in\s+my\s+area|where\s+(?:can|do|does)\s+I|how\s+far)\b/gi,
      " "
    )
    .replace(
      /^\s*(?:please\s+)?(?:find|show|get|list|locate|search|give|look\s+for)\s+(?:me|us|the|some)?\s*/i,
      ""
    )
    .trim();

  // Keep only letter/number tokens (Unicode-aware so accents survive).
  const tokens = candidate.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;

  // Drop leading filler words ("the", "best", "top", "a", "an", "some").
  const LEADING_STOPWORDS = new Set(["the", "best", "top", "a", "an", "some", "well"]);
  const start = tokens.findIndex((t) => !LEADING_STOPWORDS.has(t.toLowerCase()));
  const nounTokens = start === -1 ? [] : tokens.slice(start);
  if (nounTokens.length === 0) return null;

  const noun = nounTokens.join(" ");
  return noun.length > 0 ? noun : null;
}
