/**
 * The map style, built in code rather than fetched as JSON.
 *
 * Two reasons it is not a static file: the imagery licence switch in
 * sources.ts has to reach the style, and the sky is dawn-coloured rather than
 * midday-blue because the only time anyone opens this is around sunrise.
 */

import type { StyleSpecification } from "maplibre-gl";
import {
  DEM_SOURCE_ID,
  SATELLITE_SOURCE_ID,
  demSource,
  satelliteSource,
  type ImageryLicence,
} from "./sources";

export const SATELLITE_LAYER_ID = "satellite";
export const HILLSHADE_LAYER_ID = "hillshade";

/**
 * Modest. Madeira rises 1800m out of the sea in 5km, which is already extreme
 * enough that pushing this further reads as a video game rather than a place.
 */
export const TERRAIN_EXAGGERATION = 1.3;

export function buildStyle(licence?: ImageryLicence): StyleSpecification {
  return {
    version: 8,
    // Stated explicitly: the cloud deck places flat quads in Mercator space,
    // so a globe projection would bend geometry that must stay flat.
    projection: { type: "mercator" },
    sources: {
      [SATELLITE_SOURCE_ID]: satelliteSource(licence),
      [DEM_SOURCE_ID]: demSource(),
    },
    sky: {
      // Pre-dawn: deep blue overhead, warm at the horizon where the sun is
      // about to arrive.
      "sky-color": "#0b1a33",
      "horizon-color": "#f0a868",
      // Was a pale grey, which rendered as a white band along the whole
      // horizon where the terrain mesh ends. Dark and cool reads as distance.
      "fog-color": "#1b2740",
      "fog-ground-blend": 0.6,
      "horizon-fog-blend": 0.5,
    },
    light: { anchor: "map", position: [1.5, 200, 30], intensity: 0.3 },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#05070d" } },
      {
        id: SATELLITE_LAYER_ID,
        type: "raster",
        source: SATELLITE_SOURCE_ID,
        paint: {
          // Sentinel-2 mosaics are shot at midday. Darkened and cooled a
          // little so the terrain does not look like noon under a dawn sky.
          "raster-brightness-max": 0.85,
          "raster-saturation": -0.15,
        },
      },
      {
        id: HILLSHADE_LAYER_ID,
        type: "hillshade",
        source: DEM_SOURCE_ID,
        paint: {
          "hillshade-exaggeration": 0.4,
          "hillshade-shadow-color": "#040814",
          "hillshade-highlight-color": "#ffd9a8",
        },
      },
    ],
    terrain: { source: DEM_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION },
  };
}
