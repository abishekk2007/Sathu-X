"use client";

/**
 * Phase 8 — Leaflet / OpenStreetMap interactive map.
 *
 * Client-only. This module imports react-leaflet which pulls in Leaflet, and
 * Leaflet touches `window` at module scope — so it MUST NOT be rendered (or
 * even imported) during server-side rendering. The assistant message imports
 * this component via `next/dynamic` with `ssr: false`, deferring the import
 * to the browser. A lightweight placeholder is shown while Leaflet loads, and
 * errors / missing coordinates are handled without crashing the chat.
 */

import { useEffect, useState, type ComponentType } from "react";
import { MapPinIcon } from "lucide-react";

import type {
  MapContainerProps,
  MarkerProps,
  PopupProps,
  TileLayerProps,
} from "react-leaflet";
import type * as LeafletNamespace from "leaflet";

import type { SharedLocation } from "@/lib/location";
import { createMarkerIcon } from "@/lib/map-utils";
import type { MapPlace } from "@/lib/map-utils";

export interface LeafletMapProps {
  /** The user's real, coarse shared location (validated upstream). */
  userLocation?: SharedLocation;
  /** Normalised place results with validated coordinates (may be empty). */
  places?: MapPlace[];
  /** Optional height override (CSS px / rem / %). */
  height?: string;
}

/* Dynamically load react-leaflet & leaflet css only in the browser. */
const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const USER_MARKER_COLOR = "#3b82f6";
const PLACE_MARKER_COLOR = "#ef4444";

/**
 * The actual map. Rendered only client-side (this is reached after a client
 * hydration-gated dynamic import). Renders null until `window` exists.
 */
function InteractiveMap({ userLocation, places, height }: LeafletMapProps) {
  const [MapContainer, setMapContainer] =
    useState<ComponentType<MapContainerProps> | null>(null);
  const [mapModules, setMapModules] = useState<{
    TileLayer: ComponentType<TileLayerProps>;
    Marker: ComponentType<MarkerProps>;
    Popup: ComponentType<PopupProps>;
    L: typeof LeafletNamespace;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [reactLeaflet, leaflet] = await Promise.all([
          import("react-leaflet"),
          import("leaflet"),
        ]);
        if (cancelled) return;
        setMapModules({
          TileLayer: reactLeaflet.TileLayer,
          Marker: reactLeaflet.Marker,
          Popup: reactLeaflet.Popup,
          L: leaflet,
        });
        setMapContainer(() => reactLeaflet.MapContainer);
        // Ensure Leaflet CSS is present (idempotent, client-only).
        if (typeof document !== "undefined" && !document.getElementById("leaflet-css")) {
          await import("leaflet/dist/leaflet.css");
        }
      } catch {
        if (!cancelled) setError("Could not initialize the map.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div
        className="flex w-full items-center justify-center rounded-md bg-muted text-xs text-muted-foreground"
        style={{ height: height ?? "16rem" }}
        role="alert"
      >
        <span className="flex items-center gap-1.5">
          <MapPinIcon className="size-3.5" />
          {error}
        </span>
      </div>
    );
  }

  if (!MapContainer || !mapModules) {
    return (
      <div
        className="flex w-full items-center justify-center rounded-md bg-muted text-xs text-muted-foreground"
        style={{ height: height ?? "16rem" }}
        aria-busy="true"
      >
        Loading map…
      </div>
    );
  }

  const center: [number, number] = userLocation
    ? [userLocation.latitude, userLocation.longitude]
    : places?.[0]
      ? [places[0].latitude, places[0].longitude]
      : [20, 0];

  const { TileLayer, Marker, Popup } = mapModules;

  return (
    <MapContainer
      center={center}
      zoom={11}
      scrollWheelZoom={false}
      style={{ height: height ?? "16rem", width: "100%", borderRadius: "0.5rem" }}
      className="z-0"
    >
      <TileLayer attribution={OSM_ATTRIBUTION} url={OSM_TILE_URL} />

      {userLocation ? (
        <Marker
          position={[userLocation.latitude, userLocation.longitude]}
          icon={mapModules.L.divIcon({
            className: "",
            html: createMarkerIcon(USER_MARKER_COLOR),
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          })}
        >
          <Popup>
            <strong>You are (approximately) here</strong>
          </Popup>
        </Marker>
      ) : null}

      {places?.map((place) => (
        <Marker
          key={place.id}
          position={[place.latitude, place.longitude]}
          icon={mapModules.L.divIcon({
            className: "",
            html: createMarkerIcon(PLACE_MARKER_COLOR),
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          })}
        >
          <Popup>
            <div className="min-w-[10rem] max-w-[16rem]">
              <strong>{place.name}</strong>
              {place.category ? (
                <div className="text-xs text-muted-foreground">{place.category}</div>
              ) : null}
              {place.address ? (
                <div className="mt-1 text-xs text-muted-foreground">{place.address}</div>
              ) : null}
              {place.distanceMeters != null ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  {(place.distanceMeters / 1000).toFixed(1)} km away
                </div>
              ) : null}
              {place.openInGoogleMaps ? (
                <a
                  href={place.openInGoogleMaps}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary"
                >
                  Open in Google Maps
                </a>
              ) : null}
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}

export default InteractiveMap;
