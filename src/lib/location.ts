/**
 * Phase 7F — Location: shared, pure helpers (server-safe, no DOM).
 *
 * Location is an INPUT modality the user shares deliberately (a pinned button
 * in the composer — never a silent `navigator.geolocation` probe). Everything
 * here is deterministic and unit-testable, and nothing here ever logs raw
 * coordinates.
 */

/** A coarse, sanitized user location that may be sent to the API. */
export interface SharedLocation {
  /** Latitude rounded to ~2 decimal places (≈1.1 km). */
  latitude: number;
  /** Longitude rounded to ~2 decimal places (≈1.1 km). */
  longitude: number;
  /** Best-effort accuracy in meters, rounded to the nearest 100 m. */
  accuracy?: number;
}

/** Clamp + round for coarse sharing. Keeps a fixed degree of imprecision so
 *  the precise raw GPS reading never leaves the browser. */
function coarse(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * Validates and coarsens a raw geolocation reading. Returns null for anything
 * that is not a finite, in-range coordinate (invalid readings are never sent
 * to the API). Accuracy is rounded to the nearest 100 m and capped.
 */
export function sanitizeUserLocation(
  value:
    | { latitude?: unknown; longitude?: unknown; accuracy?: unknown }
    | null
    | undefined
): SharedLocation | null {
  if (!value) return null;
  const { latitude, longitude, accuracy } = value;
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude)
  ) {
    return null;
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return null;
  }
  const coarseAccuracy =
    typeof accuracy === "number" &&
    Number.isFinite(accuracy) &&
    accuracy > 0
      ? Math.min(Math.round(accuracy / 100) * 100, 10_000)
      : undefined;

  return {
    latitude: coarse(latitude, 2),
    longitude: coarse(longitude, 2),
    ...(coarseAccuracy !== undefined ? { accuracy: coarseAccuracy } : {}),
  };
}

/**
 * App-owned Google Maps lookup link for a shared location. The query is a
 * simple "<lat>+<lng>" pin (or an optional place hint appended to the coords);
 * the URL is built by the application — the model is never asked to fabricate
 * map URLs in its reply.
 */
export function buildGoogleMapsSearchLink(
  location: SharedLocation,
  placeHint?: string
): string {
  const pin = `${coarse(location.latitude, 6)},${coarse(location.longitude, 6)}`;
  const target = placeHint && placeHint.trim() ? `${pin} ${placeHint.trim()}` : pin;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(target)}`;
}

/**
 * "near me / around here / closest / nearby" phrasing — the only turn shapes
 * that need a shared location to answer well. Used to (a) inject the location
 * context note and (b) inject an honest "I don't have your location" note when
 * no coordinates were shared.
 */
export function nearMePhrase(message: string): boolean {
  return /\b(?:near\s+(?:me|my|here|us|by)|around\s+(?:me|here|us)|closest|closer|nearby|in\s+my\s+area|where\s+(?:can|do|does)\s+I|how\s+far)\b/i.test(
    message.trim()
  );
}

/** Client copy shown when a location pin is requested but unavailable. */
export const LOCATION_UNAVAILABLE_COPY =
  "Location couldn't be shared — check your browser's location permission.";