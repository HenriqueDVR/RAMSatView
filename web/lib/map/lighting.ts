/**
 * One sun, applied to everything the map draws.
 *
 * The sky gradient, the two hillshade layers, the cloud volume and the water
 * all have to agree about where the light is coming from and what colour it
 * is, or the scene reads as a collage. This module owns that agreement: the
 * palette lives here, and `applyLighting` pushes it into MapLibre.
 *
 * Everything is keyed off the sun's *elevation*, because that single number is
 * what makes a sky look like night, twilight, sunrise or midday - and off its
 * azimuth, which is what makes the light come from a direction rather than
 * from everywhere.
 */

import type { Map as MapLibreMap } from "maplibre-gl";
import type { SunPosition } from "@/lib/sun";
import { HILLSHADE_FILL_LAYER_ID, HILLSHADE_LAYER_ID } from "./style";

type Rgb = [number, number, number];

export type SkyPalette = {
  /** Overhead. */
  zenith: Rgb;
  /** At the horizon, in the sun's direction. */
  horizon: Rgb;
  /** Haze on distant terrain. Meets the horizon colour so there is no seam. */
  fog: Rgb;
  /** Direct sunlight, for anything shaded by hand. */
  sun: Rgb;
};

/**
 * Keyframes by solar elevation in degrees.
 *
 * The interesting range is tiny and almost all of it is below the horizon:
 * -18 is the end of astronomical twilight, -6 is when the first colour
 * arrives, 0 is the sun on the horizon, and by +12 it is simply daytime. A
 * uniform ramp across that would spend most of its resolution on midday,
 * which is the one case this site does not care about.
 */
const KEYFRAMES: { elevation: number; palette: SkyPalette }[] = [
  {
    elevation: -18,
    palette: {
      zenith: [0.006, 0.012, 0.035],
      horizon: [0.02, 0.04, 0.09],
      fog: [0.03, 0.05, 0.1],
      sun: [0, 0, 0],
    },
  },
  {
    elevation: -8,
    palette: {
      zenith: [0.015, 0.03, 0.08],
      horizon: [0.12, 0.1, 0.19],
      fog: [0.07, 0.09, 0.16],
      sun: [0.12, 0.08, 0.09],
    },
  },
  {
    elevation: -3,
    palette: {
      zenith: [0.03, 0.06, 0.15],
      horizon: [0.55, 0.29, 0.28],
      fog: [0.13, 0.15, 0.24],
      sun: [0.5, 0.26, 0.2],
    },
  },
  {
    elevation: 0,
    palette: {
      zenith: [0.05, 0.1, 0.24],
      horizon: [0.95, 0.5, 0.3],
      fog: [0.2, 0.22, 0.31],
      sun: [1, 0.6, 0.36],
    },
  },
  {
    elevation: 6,
    palette: {
      zenith: [0.09, 0.19, 0.4],
      horizon: [1, 0.75, 0.55],
      fog: [0.31, 0.35, 0.44],
      sun: [1, 0.87, 0.72],
    },
  },
  {
    elevation: 30,
    palette: {
      zenith: [0.13, 0.3, 0.62],
      horizon: [0.68, 0.79, 0.92],
      fog: [0.55, 0.63, 0.74],
      sun: [1, 0.98, 0.94],
    },
  },
];

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function skyPalette(elevationDegrees: number): SkyPalette {
  const first = KEYFRAMES[0];
  if (elevationDegrees <= first.elevation) return first.palette;
  for (let index = 1; index < KEYFRAMES.length; index++) {
    const upper = KEYFRAMES[index];
    if (elevationDegrees > upper.elevation) continue;
    const lower = KEYFRAMES[index - 1];
    const t =
      (elevationDegrees - lower.elevation) / (upper.elevation - lower.elevation);
    return {
      zenith: mix(lower.palette.zenith, upper.palette.zenith, t),
      horizon: mix(lower.palette.horizon, upper.palette.horizon, t),
      fog: mix(lower.palette.fog, upper.palette.fog, t),
      sun: mix(lower.palette.sun, upper.palette.sun, t),
    };
  }
  return KEYFRAMES[KEYFRAMES.length - 1].palette;
}

export function css(colour: Rgb): string {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) * 255);
  return `rgb(${channel(colour[0])}, ${channel(colour[1])}, ${channel(colour[2])})`;
}

/**
 * How much light is actually arriving. 0 through the night, 1 once the sun is
 * properly up, and a continuous ramp across dawn so scrubbing does not step.
 */
export function daylight(elevationDegrees: number): number {
  return Math.min(1, Math.max(0, (elevationDegrees + 6) / 14));
}

/**
 * Push the sun into the map.
 *
 * Two hillshade layers rather than one multidirectional layer: the style spec
 * documents a `hillshade-method` property, but MapLibre 6.6 - the latest
 * release - does not actually ship it, and passing an array of directions
 * without it is not honoured. Two layers with different lights is the same
 * idea in a form this version supports, and it separates the warm key from the
 * cool fill so they can be coloured independently.
 */
export function applyLighting(map: MapLibreMap, sun: SunPosition): void {
  const palette = skyPalette(sun.elevation);
  const light = daylight(sun.elevation);

  map.setSky({
    "sky-color": css(palette.zenith),
    "horizon-color": css(palette.horizon),
    "fog-color": css(palette.fog),
    // Aerial perspective: distant ridges wash towards the fog colour while
    // near ones keep their contrast. Most of the depth in the scene is this.
    "fog-ground-blend": 0.72,
    "horizon-fog-blend": 0.62,
    // The default 0.8 stops blending the horizon colour partway up the sky,
    // and at a 71-degree pitch the sky is a thin strip at the top of the
    // frame - so the whole gradient collapsed into one hard band.
    "sky-horizon-blend": 1,
    "atmosphere-blend": 0.8,
  });

  if (map.getLayer(HILLSHADE_LAYER_ID)) {
    // The key light. Kept a few degrees above the true elevation when the sun
    // is on or below the horizon: at 0 degrees a hillshade has no gradient to
    // work with at all and the terrain goes flat black.
    map.setPaintProperty(
      HILLSHADE_LAYER_ID,
      "hillshade-illumination-direction",
      sun.azimuth
    );
    map.setPaintProperty(
      HILLSHADE_LAYER_ID,
      "hillshade-illumination-altitude",
      Math.max(6, Math.min(85, sun.elevation))
    );
    map.setPaintProperty(
      HILLSHADE_LAYER_ID,
      "hillshade-highlight-color",
      css([
        0.35 + 0.65 * palette.sun[0],
        0.35 + 0.6 * palette.sun[1],
        0.35 + 0.55 * palette.sun[2],
      ])
    );
    map.setPaintProperty(
      HILLSHADE_LAYER_ID,
      "hillshade-exaggeration",
      0.35 + 0.35 * light
    );
  }

  if (map.getLayer(HILLSHADE_FILL_LAYER_ID)) {
    // The fill, from the opposite side and higher up: this is skylight, not
    // sunlight, so it is cool, weak, and never casts a hard shadow. Without it
    // every slope facing away from the sun is a silhouette.
    map.setPaintProperty(
      HILLSHADE_FILL_LAYER_ID,
      "hillshade-illumination-direction",
      (sun.azimuth + 180) % 360
    );
    map.setPaintProperty(
      HILLSHADE_FILL_LAYER_ID,
      "hillshade-highlight-color",
      css(mix(palette.zenith, [0.5, 0.62, 0.8], 0.55))
    );
  }
}
