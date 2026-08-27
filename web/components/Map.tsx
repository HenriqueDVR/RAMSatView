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
import { withBase } from "@/lib/basePath";
import { CloudDeckLayer, fieldFrame } from "@/lib/map/CloudDeckLayer";
import {
  envelopeProfile,
  hourSlice,
  type CloudGrid,
} from "@/lib/cloudGrid";
import {
  nearestHourIndex,
  type ObservedCloud,
} from "@/lib/observedCloud";
import { ObservedLayer } from "@/lib/map/ObservedLayer";
import { CloudTopLayer } from "@/lib/map/CloudTopLayer";
import { SkyLayer } from "@/lib/map/SkyLayer";
import { registerCleanDemProtocol } from "@/lib/map/demProtocol";
import { BOUNDS, CENTRE, DEM_SOURCE_ID, VIEW_BOUNDS } from "@/lib/map/sources";
import {
  HILLSHADE_FILL_LAYER_ID,
  HILLSHADE_LAYER_ID,
  SATELLITE_LAYER_ID,
  TERRAIN_EXAGGERATION,
  buildStyle,
} from "@/lib/map/style";
import { applyLighting, skyPalette } from "@/lib/map/lighting";
import { sunPosition, sunVector } from "@/lib/sun";
import { DEFAULT_LAYERS, type LayerState } from "@/lib/layers";

/**
 * MapLibre wrapper.
 *
 * MapLibre is imperative and owns its own canvas, so React's job here is only
 * to create it once, keep markers and the cloud deck in sync, and tear it
 * down. Everything that is not React lives in lib/map, so the WebGL can be
 * reasoned about without a component around it.
 */

const MAPLIBRE_WORKER_URL = withBase("/maplibre/maplibre-gl-worker.mjs");

/**
 * Pitched hard by default, and facing east.
 *
 * Flat overhead does not read as terrain, and facing anywhere else puts the
 * dawn horizon - the one thing the whole site is about - behind the camera.
 */
const DEFAULT_PITCH = 70;

/**
 * Vertical field of view, degrees.
 *
 * MapLibre's default is about 37, and at this pitch that puts the horizon
 * four degrees above the top edge of the screen - the sunrise this whole site
 * is about was being framed just out of shot. Widening to 48 brings the
 * horizon and the sky above it into the frame without going so wide that the
 * island distorts.
 */
const VERTICAL_FOV = 48;

/**
 * Past ~72 degrees the camera starts clipping into the terrain it is standing
 * on, and MapLibre has no collision handling for that: the ground folds up
 * over the view. Above zoom 15 both the imagery (10m/px) and the DEM run out
 * and the terrain turns to smooth dunes.
 *
 * The floor was 8.2, chosen when "the archipelago is a speck" was the only
 * thing zooming out could achieve. With a real sky and a horizon worth looking
 * at there is something to back off and see, so it goes down to 5.4 -
 * far enough that Madeira and Porto Santo sit together in an ocean. Anything
 * lower and the Sentinel mosaic has no tiles.
 */
const MAX_PITCH = 72;
const MIN_ZOOM = 5.4;
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

/**
 * How many cloud slices this device can afford.
 *
 * The volume is drawn as stacked full-screen sheets, so cost is slices x
 * pixels and nothing else. A phone at 3x pixel ratio is shading nine times the
 * fragments of a laptop for a screen a fifth the size, and the deck is the one
 * thing on the map that can be thinned without losing the answer.
 */
function sliceBudget(): number {
  if (typeof window === "undefined") return 22;
  const pixels = window.innerWidth * (window.devicePixelRatio || 1);
  if (window.innerWidth < 720) return 12;
  return pixels > 2600 ? 16 : 22;
}

/**
 * Room for the HUD, in pixels.
 *
 * MapLibre's padding moves the projection centre rather than cropping, so
 * reserving the top pushes the horizon down into the visible part of the
 * frame instead of leaving it behind the masthead.
 */
function hudPadding(): { top: number; bottom: number; left: number; right: number } {
  if (typeof window === "undefined") return { top: 0, bottom: 0, left: 0, right: 0 };
  const wide = window.innerWidth >= 1024;
  return {
    top: wide ? 150 : 0,
    bottom: wide ? 40 : 0,
    left: 0,
    right: 0,
  };
}

/**
 * Run something once the style exists, rather than once everything has loaded.
 *
 * `load` waits for the first complete frame - style, sources *and* their
 * initial tiles. The Terrarium DEM goes through a re-encoding protocol on the
 * main thread and, on a cold cache behind a slow renderer, its tiles are still
 * arriving long after the map is usable; `map.isStyleLoaded()` is false for
 * the same reason, since it also waits on every source cache.
 *
 * Waiting on either of those meant the custom layers and the lighting were
 * never installed at all on a slow load, which is a bug that only appears on
 * someone else's machine. The style being parsed is the only precondition
 * that addLayer and setPaintProperty actually have.
 */
function whenStyleReady(instance: MapLibreMap, run: () => void): () => void {
  if (instance.style?.stylesheet) {
    run();
    return () => {};
  }
  const handler = () => run();
  instance.once("style.load", handler);
  return () => instance.off("style.load", handler);
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The sunrise this document is about, as the default lighting instant.
 *
 * Falling back to "now" would light the scene for 3pm on the afternoon
 * someone happens to be planning, which is a picture of a place they will
 * never see.
 */
function defaultTime(spots: SpotEntry[]): Date {
  for (const spot of spots) {
    const day = spot.days[0];
    if (day && isViewpointDay(day)) return new Date(day.sunrise_utc);
  }
  return new Date();
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
  layers = DEFAULT_LAYERS,
  grid = null,
  observed = null,
  timeIndex = 0,
  time,
}: {
  spots: SpotEntry[];
  locale: Locale;
  selectedId: string | null;
  onSelect: (id: string) => void;
  layers?: LayerState;
  /**
   * The forecast volume, when one was published. Null falls the deck back to
   * the selected viewpoint's column, which is the shape it had before the
   * gridded ingest existed.
   */
  grid?: CloudGrid | null;
  /**
   * The satellite cloud-top field, when one was published. It only covers the
   * hours already past, so scrubbing into the forecast leaves it empty rather
   * than holding the last scan on screen.
   */
  observed?: ObservedCloud | null;
  /** Which hour of the volume is being shown. Ignored without a grid. */
  timeIndex?: number;
  /**
   * The instant the scene is lit for. Defaults to the sunrise the forecast is
   * about, because that is the moment the whole product describes - not
   * whenever the page happens to be open.
   */
  time?: Date;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const deck = useRef<CloudDeckLayer | null>(null);
  const observedLayer = useRef<ObservedLayer | null>(null);
  const heatmap = useRef<CloudTopLayer | null>(null);
  const sky = useRef<SkyLayer | null>(null);
  // Once the DEM has failed there is nothing for the terrain switch to turn
  // back on, and asking for it again would put the broken globe back.
  const demFailed = useRef(false);
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

  // One sun for the whole scene: the sky gradient, both hillshades, the
  // cloud's self-shadowing and the glitter on the water all read from this.
  const sun = useMemo(() => {
    const instant = time ?? defaultTime(spots);
    return sunPosition(instant, CENTRE[1], CENTRE[0]);
  }, [time, spots]);

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
      // The camera's box, not the data's: MapLibre fits maxBounds inside the
      // viewport, so clamping this to BOUNDS also clamped how far out anyone
      // could zoom. See VIEW_BOUNDS in lib/map/sources.ts.
      maxBounds: [
        [VIEW_BOUNDS[0], VIEW_BOUNDS[1]],
        [VIEW_BOUNDS[2], VIEW_BOUNDS[3]],
      ],
      attributionControl: { compact: true },
    });
    // The masthead and the panels sit over the top of the map, so the
    // projection centre is pushed down to match. Without this the horizon -
    // and the sunrise, which is the entire subject - renders underneath the
    // title bar. Set after construction: v6's MapOptions has no padding field,
    // only the camera methods do.
    instance.setPadding(hudPadding());
    instance.setVerticalFieldOfView(VERTICAL_FOV);
    map.current = instance;
    // The end-to-end suite needs a handle on an imperative object React never
    // exposes. Read-only, and cheaper than instrumenting the component.
    (window as unknown as { __satappMap?: MapLibreMap }).__satappMap = instance;
    instance.addControl(new NavigationControl({ visualizePitch: true }), "top-right");

    const layer = new CloudDeckLayer({
      bounds: BOUNDS,
      exaggeration: TERRAIN_EXAGGERATION,
      animate: !prefersReducedMotion(),
      maxSlices: sliceBudget(),
    });
    deck.current = layer;

    whenStyleReady(instance, () => {
      // Bottom of the stack, and drawn at the far plane, so it fills only the
      // pixels nothing else claims.
      const dome = new SkyLayer();
      sky.current = dome;
      instance.addLayer(dome, SATELLITE_LAYER_ID);
      instance.addLayer(layer);
      // Over the basemap and the hillshade, under the forecast volume: a flat
      // picture of the sky belongs behind the one body with real geometry.
      // There is no beforeId because the deck is a custom layer and the
      // observed raster is not - style layers are drawn before custom ones
      // whatever order they were added in.
      observedLayer.current = new ObservedLayer(instance);
      // Last, so it is on top of the style stack: a draped raster follows the
      // terrain, and the whole point of it is to read the altitude off the
      // ridges rather than off a sheet floating over them.
      heatmap.current = new CloudTopLayer(instance);
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
      demFailed.current = true;
      instance.setTerrain(null);
      for (const id of [HILLSHADE_LAYER_ID, HILLSHADE_FILL_LAYER_ID]) {
        if (instance.getLayer(id)) instance.removeLayer(id);
      }
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
      sky.current = null;
      observedLayer.current = null;
      heatmap.current = null;
      pins.clear();
    };
    // Mount only. The deck and markers are kept current by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The deck's shape: from the volume where there is one, from the selected
  // viewpoint's column otherwise. Both paths end in setProfile because the
  // slices are cut from a profile either way - what the grid adds is the
  // per-pixel coverage the shader looks up, which the slices then vary across.
  useEffect(() => {
    const layer = deck.current;
    if (!layer) return;
    if (!grid) {
      layer.setField(null);
      layer.setProfile(profile);
      return;
    }
    const { bbox, altitudes_m, cols, rows } = grid.header;
    layer.setField(
      fieldFrame(bbox, altitudes_m, cols, rows, hourSlice(grid, timeIndex))
    );
    layer.setProfile(envelopeProfile(grid, timeIndex));
  }, [profile, grid, timeIndex]);

  // The heatmap reads the same volume and the same hour as the deck, which is
  // what lets the two be alternatives rather than two different forecasts.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    return whenStyleReady(instance, () => {
      heatmap.current?.setFrame(grid, timeIndex);
    });
  }, [grid, timeIndex]);

  // The observed field is matched to the scene's instant rather than to the
  // volume's hour index: the two axes are published by different sources over
  // different spans, and lining them up by position rather than by clock is
  // how last night's satellite ends up captioned as tomorrow morning.
  const observedIndex = useMemo(() => {
    if (!observed) return null;
    const instant = (time ?? defaultTime(spots)).getTime();
    return nearestHourIndex(observed, instant);
  }, [observed, time, spots]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    return whenStyleReady(instance, () => {
      const layer = observedLayer.current;
      if (!layer) return;
      layer.setFrame(observedIndex === null ? null : observed, observedIndex ?? 0);
    });
    // Visibility is left to the layer-switch effect below, which runs after
    // this one on the same commit and reads the same observedIndex.
  }, [observed, observedIndex]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const vector = sunVector(sun);
    const palette = skyPalette(sun.elevation);
    const apply = () => {
      applyLighting(instance, sun);
      deck.current?.setSun(vector, sun.elevation);
      sky.current?.setSun(vector, sun.elevation, palette);
    };
    return whenStyleReady(instance, apply);
  }, [sun]);

  // Layer switches. Each one is applied the cheapest way that survives being
  // flipped repeatedly: visibility rather than add/remove, so nothing is
  // rebuilt and no tile is fetched twice.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    const apply = () => {
      if (instance.getLayer(SATELLITE_LAYER_ID)) {
        instance.setLayoutProperty(
          SATELLITE_LAYER_ID,
          "visibility",
          layers.satellite ? "visible" : "none"
        );
      }
      if (!demFailed.current) {
        instance.setTerrain(
          layers.terrain
            ? { source: DEM_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION }
            : null
        );
      }
      deck.current?.setVisible(layers.cloud);
      // Only with a volume behind it: with no grid there is no cloud top to
      // colour, and an empty raster over the island says "clear" when what is
      // true is "not published".
      heatmap.current?.setVisible(layers.heatmap && grid !== null);
      // Only ever visible when there is an hour to show: outside the observed
      // window there is nothing measured, and the switch must not resurrect
      // the last frame that was.
      observedLayer.current?.setVisible(layers.observed && observedIndex !== null);
    };

    return whenStyleReady(instance, apply);
  }, [layers, observedIndex, grid]);

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
      // The pin body stays dark whatever the score - it is read against a dawn
      // sky and a cloud deck, and a saturated fill loses its own numerals at
      // 32px. The score colour drives the ring and the glow instead.
      element.style.setProperty("--pin", markerColor(score ? score.value : null));
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
