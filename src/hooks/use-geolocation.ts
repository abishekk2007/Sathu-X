"use client";

/**
 * Phase 7F — Location: explicit-activation geolocation hook.
 *
 * Location is shared ONLY when the user presses the pin button in the composer
 * (an explicit user gesture) — this hook never probes `navigator.geolocation`
 * on its own. The raw reading is immediately coarsened (rounded to ~1.1 km)
 * by `sanitizeUserLocation` so the precise GPS value is discarded inside the
 * browser and only the coarse result is ever exposed to the app.
 */

import * as React from "react";
import {
  LOCATION_UNAVAILABLE_COPY,
  sanitizeUserLocation,
  type SharedLocation,
} from "@/lib/location";

export type GeolocationState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "active"; location: SharedLocation }
  | { status: "unavailable"; message: string };

const UNSUPPORTED_MESSAGE = "Location isn't supported in this browser.";

export interface GeolocationController {
  state: GeolocationState;
  /** Requests a fresh reading. Must be called from a user-gesture handler. */
  request: () => void;
  /** Drops the shared location back to idle. */
  clear: () => void;
}

export function useGeolocation(): GeolocationController {
  const [state, setState] = React.useState<GeolocationState>({ status: "idle" });

  const request = React.useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState({ status: "unavailable", message: UNSUPPORTED_MESSAGE });
      return;
    }
    setState({ status: "requesting" });
    // Explicit activation only — a single-shot coarse read, never a watch.
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location = sanitizeUserLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        setState(
          location
            ? { status: "active", location }
            : { status: "unavailable", message: LOCATION_UNAVAILABLE_COPY }
        );
      },
      (error) => {
        console.error("[geolocation] failed:", error.code);
        setState({ status: "unavailable", message: LOCATION_UNAVAILABLE_COPY });
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 }
    );
  }, []);

  const clear = React.useCallback(() => setState({ status: "idle" }), []);

  return { state, request, clear };
}