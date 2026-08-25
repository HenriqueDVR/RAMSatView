"use client";

import { useEffect, useRef } from "react";
import maplibregl, { Map as MapLibreMap, Marker } from "maplibre-gl";
import { headlineScore, type SpotEntry } from "@/lib/conditions";
import type { Locale } from "@/lib/i18n";

/**
 * MapLibre wrapper.
 *
 * MapLibre is imperative and owns its own canvas, so React's job here is only
 * to create it once, keep markers in sync, and tear it down. Deliberately no
 * react-map-gl: it is another ~30KB to wrap an API we touch in three places.
 *
 * Basemap: the MapLibre demo style needs no API key, which keeps the project
 * dependency-free for now. It is low detail and not intended for production
 * traffic - before launch, swap in self-hosted PMTiles (a Madeira extract is a
 * few tens of MB and sits happily in the same R2 bucket as conditions.json).
 */

const BASEMAP_STYLE = "https://demotiles.maplibre.org/style.json";

// Archipelago bounds, so the map cannot be panned off into the Atlantic.
const BOUNDS: [number, number, number, number] = [-17.5, 32.3, -16.2, 33.2];
const CENTRE: [number, number] = [-16.92, 32.75];

function markerColor(value: number | null): string {
  if (value === null) return "#94a3b8";
  if (value >= 70) return "#16a34a";
  if (value >= 40) return "#d97706";
  return "#dc2626";
}

export default function MapView({
  spots,
  locale,
  selectedId,
  onSelect,
}: {
  spots: SpotEntry[];
  locale: Locale;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  // Kept in a ref so re-renders do not force the marker layer to rebuild just
  // because the parent passed a new function identity.
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    if (!container.current || map.current) return;

    map.current = new maplibregl.Map({
      container: container.current,
      style: BASEMAP_STYLE,
      center: CENTRE,
      zoom: 8.5,
      maxBounds: [
        [BOUNDS[0], BOUNDS[1]],
        [BOUNDS[2], BOUNDS[3]],
      ],
      attributionControl: { compact: true },
    });
    map.current.addControl(new maplibregl.NavigationControl(), "top-right");

    return () => {
      map.current?.remove();
      map.current = null;
      markers.current.clear();
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    for (const marker of markers.current.values()) marker.remove();
    markers.current.clear();

    for (const spot of spots) {
      const score = headlineScore(spot);
      const element = document.createElement("button");
      element.type = "button";
      element.className =
        spot.id === selectedId ? "map-pin selected" : "map-pin";
      element.style.background = markerColor(score ? score.value : null);
      element.textContent = score ? String(Math.round(score.value)) : "?";
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        select.current(spot.id);
      });

      const marker = new maplibregl.Marker({ element })
        .setLngLat([spot.lon, spot.lat])
        .addTo(instance);

      // Set the label after addTo: the Marker constructor stamps its own
      // generic "Map marker" aria-label onto the element, which would
      // otherwise replace the spot name and score for screen readers.
      element.setAttribute(
        "aria-label",
        `${locale === "pt" ? spot.name.pt : spot.name.en}: ${
          score ? Math.round(score.value) : "no data"
        }`
      );

      markers.current.set(spot.id, marker);
    }
  }, [spots, selectedId, locale]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !selectedId) return;
    const spot = spots.find((candidate) => candidate.id === selectedId);
    if (spot) {
      instance.flyTo({ center: [spot.lon, spot.lat], zoom: 11, speed: 1.2 });
    }
  }, [selectedId, spots]);

  return <div ref={container} className="map" aria-label="Map of spots" />;
}
