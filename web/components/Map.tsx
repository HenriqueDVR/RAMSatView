"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  type ErrorEvent as MapErrorEvent,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import {
  headlineScore,
  isViewpointDay,
  type ProfilePoint,
  type SpotEntry,
} from "@/lib/conditions";
import type { Locale } from "@/lib/i18n";
import { CloudDeckLayer } from "@/lib/map/CloudDeckLayer";
import { BOUNDS, CENTRE, DEM_SOURCE_ID } from "@/lib/map/sources";
import { HILLSHADE_LAYER_ID, TERRAIN_EXAGGERATION, buildStyle } from "@/lib/map/style";

/**
 * MapLibre wrapper.
 *
 * MapLibre is imperative and owns its own canvas, so React's job here is only
 * to create it once, keep markers and the cloud deck in sync, and tear it
 * down. Everything that is not React lives in lib/map, so the WebGL can be
 * reasoned about without a component around it.
 */

const MAPLIBRE_WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";

/** Pitched by default. Flat overhead does not read as terrain. */
const DEFAULT_PITCH = 60;
const DEFAULT_BEARING = -25;
const DEFAULT_ZOOM = 9.6;

function markerColor(value: number | null): string {
  if (value === null) return "#94a3b8";
  if (value >= 70) return "#16a34a";
  if (value >= 40) return "#d97706";
  return "#dc2626";
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The profile the deck is drawn from: the selected viewpoint, else the highest. */
function activeProfile(
  spots: SpotEntry[],
  selectedId: string | null
): ProfilePoint[] {
  const viewpoints = spots.filter((spot) => spot.type === "viewpoint");
  const selected = viewpoints.find((spot) => spot.id === selectedId);
  const spot =
    selected ??
    [...viewpoints].sort((a, b) => b.elevation_m - a.elevation_m)[0];
  const day = spot?.days[0];
  return day && isViewpointDay(day) ? day.profile : [];
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
  const deck = useRef<CloudDeckLayer | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  // Kept in a ref so re-renders do not force the marker layer to rebuild just
  // because the parent passed a new function identity.
  const select = useRef(onSelect);
  select.current = onSelect;

  const profile = useMemo(
    () => activeProfile(spots, selectedId),
    [spots, selectedId]
  );

  useEffect(() => {
    if (!container.current || map.current) return;

    // Copied into public/ by scripts/copy-maplibre-worker.mjs. Without this
    // the worker URL webpack baked in points at the build machine's disk.
    setWorkerUrl(MAPLIBRE_WORKER_URL);

    const instance = new MapLibreMap({
      container: container.current,
      style: buildStyle(),
      center: CENTRE,
      zoom: DEFAULT_ZOOM,
      pitch: DEFAULT_PITCH,
      bearing: DEFAULT_BEARING,
      maxPitch: 80,
      maxBounds: [
        [BOUNDS[0], BOUNDS[1]],
        [BOUNDS[2], BOUNDS[3]],
      ],
      attributionControl: { compact: true },
    });
    map.current = instance;
    // The end-to-end suite needs a handle on an imperative object React never
    // exposes. Read-only, and cheaper than instrumenting the component.
    (window as unknown as { __satappMap?: MapLibreMap }).__satappMap = instance;
    instance.addControl(new NavigationControl({ visualizePitch: true }), "top-right");

    const layer = new CloudDeckLayer({
      bounds: BOUNDS,
      exaggeration: TERRAIN_EXAGGERATION,
      animate: !prefersReducedMotion(),
    });
    deck.current = layer;

    instance.on("load", () => {
      instance.addLayer(layer);
      layer.setProfile(activeProfile(spots, selectedId));
    });

    // Terrarium is open data with no SLA behind it. If the DEM goes away the
    // map must fall back to flat 2D rather than showing a broken globe, so
    // nothing but the terrain and the hillshade may depend on it.
    // MapLibre tags source failures with sourceId, but does not put it on the
    // ErrorEvent type, so it is read off the event rather than declared.
    const onError = (event: MapErrorEvent) => {
      const sourceId = (event as MapErrorEvent & { sourceId?: string }).sourceId;
      if (sourceId !== DEM_SOURCE_ID || !instance.getTerrain()) return;
      instance.setTerrain(null);
      if (instance.getLayer(HILLSHADE_LAYER_ID)) {
        instance.removeLayer(HILLSHADE_LAYER_ID);
      }
      instance.easeTo({ pitch: 0 });
    };
    instance.on("error", onError);

    return () => {
      instance.off("error", onError);
      instance.remove();
      map.current = null;
      deck.current = null;
      markers.current.clear();
    };
    // Mount only. The deck and markers are kept current by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    deck.current?.setProfile(profile);
  }, [profile]);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const sync = () => deck.current?.setAnimate(!query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
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

      const marker = new Marker({ element })
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
    if (!spot) return;

    // A viewpoint is framed from below and to the side, so the deck and the
    // summit are seen against each other. A beach is looked down on.
    const viewpoint = spot.type === "viewpoint";
    instance.flyTo({
      center: [spot.lon, spot.lat],
      zoom: viewpoint ? 12.2 : 12.8,
      pitch: viewpoint ? 70 : 40,
      bearing: viewpoint ? -35 : 0,
      speed: 1.1,
    });
  }, [selectedId, spots]);

  return <div ref={container} className="map" aria-label="Map of spots" />;
}
