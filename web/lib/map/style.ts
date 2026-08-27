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
 * The second, cooler hillshade: skylight from the far side, so slopes facing
 * away from the sun keep some form instead of going to silhouette. Both are
 * re-aimed every time the displayed hour changes - see lighting.ts.
 */
export const HILLSHADE_FILL_LAYER_ID = "hillshade-fill";

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
      "sky-color": "#071122",
      "horizon-color": "#e8a26a",
      // Was a pale grey, which rendered as a white band along the whole
      // horizon where the terrain mesh ends. Dark and cool reads as distance.
      "fog-color": "#2a3550",
      // Aerial perspective: distant ridges wash out towards the fog colour,
      // near ones stay contrasty. This is most of what gives the scene depth.
      "fog-ground-blend": 0.72,
      "horizon-fog-blend": 0.62,
      // The default 0.8 stops blending the horizon colour into the sky partway
      // up, and at a 71-degree pitch the sky is a 30px strip at the top of the
      // frame - so the whole gradient collapsed into one hard orange band.
      // At 1.0 the warm light carries all the way to the zenith colour and the
      // strip reads as sky rather than as a painted stripe.
      "sky-horizon-blend": 1,
      // Only meaningful under globe, but harmless and explicit.
      "atmosphere-blend": 0.8,
    },
    // Low and from the east-north-east: the sun is on the horizon, which is
    // the whole premise. A high light source flattens exactly the ravines the
    // hillshade above is there to show.
    light: { anchor: "map", position: [1.5, 95, 12], intensity: 0.42 },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#05070d" } },
      {
        id: SATELLITE_LAYER_ID,
        type: "raster",
        source: SATELLITE_SOURCE_ID,
        paint: {
          // Sentinel-2 mosaics are shot at midday. Darkened and cooled a
          // little so the terrain does not look like noon under a dawn sky.
          // Only the first frame's value: lighting.ts re-exposes this for the
          // displayed hour, and takes it further down the higher the sun is.
          "raster-brightness-max": 0.96,
          // Lifts the deepest shadows off pure black. Sentinel-2 over
          // laurisilva is nearly black to begin with and two hillshade layers
          // multiply it further; without this the north side of the island is
          // a hole in the picture.
          "raster-brightness-min": 0.06,
          "raster-saturation": -0.08,
          // Sentinel-2 mosaics are median composites, which is exactly the
          // operation that flattens local contrast. Putting some back is what
          // stops the laurisilva and the bare ridges reading as one green mat.
          "raster-contrast": 0.12,
        },
      },
      {
        // Skylight fill, drawn under the key so the warm light wins where the
        // two overlap.
        id: HILLSHADE_FILL_LAYER_ID,
        type: "hillshade",
        source: DEM_SOURCE_ID,
        paint: {
          "hillshade-exaggeration": 0.28,
          "hillshade-illumination-direction": 250,
          "hillshade-illumination-altitude": 55,
          "hillshade-shadow-color": "#0b1526",
          "hillshade-highlight-color": "#5d7ba6",
          "hillshade-accent-color": "#0d1a30",
        },
      },
      {
        id: HILLSHADE_LAYER_ID,
        type: "hillshade",
        source: DEM_SOURCE_ID,
        paint: {
          // The imagery already carries midday shading of its own, so this is
          // relief rather than a light source - but at 0.4 the ravines that
          // make Madeira legible from the air were washing out entirely.
          "hillshade-exaggeration": 0.55,
          // Aimed at the real sun on the first frame that knows the time.
          "hillshade-illumination-direction": 90,
          "hillshade-illumination-altitude": 8,
          "hillshade-shadow-color": "#0a1020",
          "hillshade-highlight-color": "#ffd9a8",
          // Picks out ridge lines regardless of which way they face. Without
          // it only the two slopes facing the light source have any structure.
          "hillshade-accent-color": "#12203a",
        },
      },
    ],
    terrain: { source: DEM_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION },
  };
}
