/**
 * The pure half of the DEM pipeline: decode, filter, re-encode.
 *
 * Split from demProtocol.ts because that module imports maplibre-gl, which
 * touches `window` at import time and so cannot be pulled into a plain node
 * test. These are the parts worth testing.
 */

/** A sample this far from its neighbours is an artefact, not a mountain. */
const SPIKE_THRESHOLD_M = 120;

/** Terrarium: height = (R * 256 + G + B / 256) - 32768. */
const TERRARIUM_OFFSET = 32768;

export function decode(pixels: Uint8ClampedArray, size: number): Float32Array {
  const heights = new Float32Array(size * size);
  for (let index = 0; index < heights.length; index++) {
    const offset = index * 4;
    heights[index] =
      pixels[offset] * 256 +
      pixels[offset + 1] +
      pixels[offset + 2] / 256 -
      TERRARIUM_OFFSET;
  }
  return heights;
}

export function encode(
  heights: Float32Array,
  pixels: Uint8ClampedArray
): void {
  for (let index = 0; index < heights.length; index++) {
    const value = heights[index] + TERRARIUM_OFFSET;
    const offset = index * 4;
    pixels[offset] = Math.floor(value / 256);
    pixels[offset + 1] = Math.floor(value) % 256;
    pixels[offset + 2] = Math.round((value - Math.floor(value)) * 256);
    pixels[offset + 3] = 255;
  }
}

function median4(a: number, b: number, c: number, d: number): number {
  const sorted = [a, b, c, d].sort((x, y) => x - y);
  return (sorted[1] + sorted[2]) / 2;
}

/**
 * Replace samples that disagree sharply with every one of their neighbours.
 *
 * Comparing against the *extremes* rather than the median is deliberate.
 * Madeira's ridges are genuinely knife-edged: at z11 a real arete is often one
 * sample wide, and its two along-ridge neighbours are as high as it is. A
 * median test calls that a spike and shaves 300m off every crest on the
 * island. Requiring the sample to stand clear of its highest neighbour, not
 * its typical one, removes lone needles and leaves ridges alone.
 *
 * Edge pixels are left alone on purpose: they are shared with the adjacent
 * tile, which is filtered with a different neighbourhood, and rewriting them
 * would open seams along every tile boundary.
 */
export function despike(heights: Float32Array, size: number): Float32Array {
  const output = Float32Array.from(heights);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const index = y * size + x;
      const west = heights[index - 1];
      const east = heights[index + 1];
      const north = heights[index - size];
      const south = heights[index + size];
      const value = heights[index];
      const highest = Math.max(west, east, north, south);
      const lowest = Math.min(west, east, north, south);
      if (value > highest + SPIKE_THRESHOLD_M || value < lowest - SPIKE_THRESHOLD_M) {
        output[index] = median4(west, east, north, south);
      }
    }
  }
  return output;
}

/**
 * Terrarium's bathymetry stops at zoom 10.
 *
 * Below the sea it is ETOPO-derived and only baked into the low zooms; from
 * z11 up the ocean is simply zero, because those levels come from land
 * elevation datasets. That is not a detail - at the zooms this map actually
 * uses, the sea floor is a flat plateau at exactly 0m, which sits *above* the
 * sea plane and renders as a hard-edged wedge of dark ocean imagery lying on
 * top of the water. Pan across a zoom boundary and tiles swap between real
 * bathymetry and that plateau, which is the flicker.
 *
 * So: everything at or below sea level is pushed to one constant just beneath
 * the sea plane. Shallow, not deep: the water above it is now transparent in
 * the near field, so the imagery draped on this floor is on screen, and a
 * floor hundreds of metres down would slide the coastline visibly away from
 * where the land meets it at a steep pitch. The sea floor is never drawn - the sea plane hides it either
 * way - and the only thing that matters about it is that it stays hidden at
 * every zoom, which a constant guarantees and the source data does not.
 */
export const OCEAN_FLOOR_M = -30;

/** Anything at or below this is sea, not shoreline. */
const SHORE_THRESHOLD_M = 0.5;

export function flattenOcean(heights: Float32Array): Float32Array {
  for (let index = 0; index < heights.length; index++) {
    if (heights[index] <= SHORE_THRESHOLD_M) heights[index] = OCEAN_FLOOR_M;
  }
  return heights;
}
