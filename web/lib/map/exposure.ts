/**
 * How bright the ground is allowed to be, as a function of the real light.
 *
 * A module of its own, and free of every maplibre import, for the same reason
 * demFilter.ts is split from demProtocol.ts: maplibre-gl touches `window` at
 * import time and cannot be pulled into a plain node test. These rules are
 * the part worth testing, so they live where a test can reach them.
 *
 * The rule they encode is counter-intuitive and worth stating once. Sentinel-2
 * cloudless is a *median composite of midday scenes*: a noon exposure is
 * already baked into every pixel. Drawing that at full brightness under a
 * midday sun, with a white highlight on top, is what made the island look
 * lacquered - a specular sheen on what should be rock and laurel. So as the
 * real sun climbs, the light this map adds comes down.
 */

export type ImageryPaint = {
  brightnessMax: number;
  contrast: number;
  saturation: number;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function imageryPaint(light: number): ImageryPaint {
  const t = clamp01(light);
  return {
    // Never below ~0.66: past that the island disappears into its own shadow.
    brightnessMax: 0.96 - 0.3 * t,
    // Contrast pulls the laurisilva and the bare ridges apart, and a bright
    // scene needs less of it than a dim one.
    contrast: 0.14 - 0.06 * t,
    // Median composites are already over-saturated for a landscape; midday is
    // where that reads as a postcard rather than as a place.
    saturation: -0.08 - 0.12 * t,
  };
}

/**
 * How hard the warm key light is allowed to hit.
 *
 * At dawn the sun colour is deep orange and a strong highlight is the whole
 * picture. At noon it is white, and the same strength is glare.
 */
export function highlightGain(light: number): number {
  return 0.62 - 0.3 * clamp01(light);
}
