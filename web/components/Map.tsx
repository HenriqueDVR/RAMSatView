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
  deckVerdict,
  headlineScore,
  isViewpointDay,
  type ProfilePoint,
  type SpotEntry,
} from "@/lib/conditions";
import type { Locale } from "@/lib/i18n";
import { CloudDeckLayer } from "@/lib/map/CloudDeckLayer";
import { SEA_LAYER_ID, SeaLayer } from "@/lib/map/SeaLayer";
import { registerCleanDemProtocol } from "@/lib/map/demProtocol";
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

/**
 * Pitched hard by default, and facing east.
 *
 * Flat overhead does not read as terrain, and facing anywhere else puts the
 * dawn horizon - the one thing the whole site is about - behind the camera.
 */
const DEFAULT_PITCH = 71;

/**
 * Past ~72 degrees the camera starts clipping into the terrain it is standing
 * on, and MapLibre has no collision handling for that: the ground folds up
 * over the view. Below zoom 8.2 the archipelago is a speck; above 15 both the
 * imagery (10m/px) and the DEM run out and the terrain turns to smooth dunes.
 */
const MAX_PITCH = 72;
const MIN_ZOOM = 8.2;
const MAX_ZOOM = 15;
const DEFAULT_BEARING = 72;
// Close enough that the massif has presence and the dawn sky is in frame.
// Framed on the whole archipelago the island is a speck on black water.
const DEFAULT_ZOOM = 10.6;

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
  // because the parent passed a new function identity. Written in an effect
  // rather than during render: a ref write during render is invisible to React
  // and runs twice under StrictMode.
  const select = useRef(onSelect);
  useEffect(() => {
    select.current = onSelect;
  }, [onSelect]);

  const profile = useMemo(
    () => activeProfile(spots, selectedId),
    [spots, selectedId]
  );

  useEffect(() => {
    if (!container.current || map.current) return;

    // Copied into public/ by scripts/copy-maplibre-worker.mjs. Without this
    // the worker URL webpack baked in points at the build machine's disk.
    setWorkerUrl(MAPLIBRE_WORKER_URL);
    registerCleanDemProtocol();

    const instance = new MapLibreMap({
      container: container.current,
      style: buildStyle(),
      center: CENTRE,
      zoom: DEFAULT_ZOOM,
      pitch: DEFAULT_PITCH,
      bearing: DEFAULT_BEARING,
      maxPitch: MAX_PITCH,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
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
      // The sea goes in first: it must occlude the bathymetry before anything
      // translucent is blended over it.
      instance.addLayer(new SeaLayer());
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
      // Without terrain the raster layers are drawn flat at zero, which is
      // exactly where the sea plane sits - and being a depth-writing 3D layer
      // it would win, leaving the user staring at an empty blue rectangle.
      if (instance.getLayer(SEA_LAYER_ID)) instance.removeLayer(SEA_LAYER_ID);
      instance.easeTo({ pitch: 0 });
    };
    instance.on("error", onError);

    // Captured here rather than read in the cleanup: by the time cleanup
    // runs, markers.current may already point at a different Map.
    const pins = markers.current;
    return () => {
      instance.off("error", onError);
      instance.remove();
      map.current = null;
      deck.current = null;
      pins.clear();
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

  // Markers are rebuilt for the spot list and the locale only. Selection is
  // applied by the effect below, because rebuilding eight pins - each one a
  // DOM node, a listener and a MapLibre Marker - every time the user taps a
  // card is real work for a class name.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    for (const marker of markers.current.values()) marker.remove();
    markers.current.clear();

    for (const spot of spots) {
      const score = headlineScore(spot);
      const element = document.createElement("button");
      element.type = "button";
      element.className = "map-pin";
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
  }, [spots, locale]);

  useEffect(() => {
    for (const [id, marker] of markers.current) {
      marker.getElement().classList.toggle("selected", id === selectedId);
    }
  }, [selectedId, spots]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !selectedId) return;
    const spot = spots.find((candidate) => candidate.id === selectedId);
    if (!spot) return;

    // A beach is looked down on. A viewpoint is framed against the cloud, and
    // where that cloud sits decides the framing: a deck below the summit is
    // seen from above, while a deck overhead has to be pulled back and looked
    // up at or it sits outside the frustum entirely and the summit appears
    // clear when the forecast says it is socked in.
    const day = spot.days[0];
    const verdict =
      spot.type === "viewpoint" && day && isViewpointDay(day)
        ? deckVerdict(day, spot.elevation_m)
        : null;

    if (verdict === null) {
      instance.flyTo({
        center: [spot.lon, spot.lat],
        zoom: 12.8,
        pitch: 40,
        bearing: 0,
        speed: 1.1,
      });
      return;
    }

    const overhead = verdict === "inside";
    instance.flyTo({
      center: [spot.lon, spot.lat],
      zoom: overhead ? 11.4 : 12.2,
      pitch: overhead ? MAX_PITCH : MAX_PITCH - 4,
      bearing: 80,
      speed: 1.1,
    });
  }, [selectedId, spots]);

  return <div ref={container} className="map" aria-label="Map of spots" />;
}
