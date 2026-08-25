/**
 * A MapLibre protocol that despikes Terrarium DEM tiles before MapLibre sees
 * them.
 *
 * Terrarium is open data and mostly excellent, but it carries occasional
 * single-pixel outliers - a lone sample hundreds of metres above its
 * neighbours. Flat on a 2D hillshade, they become needles once the DEM drives
 * a 3D mesh: sharp cones standing over the ridgelines, which is exactly the
 * kind of artefact that makes a viewer distrust everything else on screen.
 * They are in the data at every zoom, so capping maxzoom does not help.
 *
 * Each tile is decoded, compared against its neighbours, and re-encoded. The
 * cost is a few milliseconds per tile on the main thread, paid once - the
 * browser still caches the underlying HTTP request.
 */

import { addProtocol } from "maplibre-gl";

export const CLEAN_DEM_PROTOCOL = "terrarium-clean";

/** A sample this far from its neighbours is an artefact, not a mountain. */
const SPIKE_THRESHOLD_M = 120;

/** Terrarium: height = (R * 256 + G + B / 256) - 32768. */
const TERRARIUM_OFFSET = 32768;

function decode(pixels: Uint8ClampedArray, size: number): Float32Array {
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

function encode(
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
 * Replace samples that disagree sharply with all four neighbours.
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
      const middle = median4(
        heights[index - 1],
        heights[index + 1],
        heights[index - size],
        heights[index + size]
      );
      if (Math.abs(heights[index] - middle) > SPIKE_THRESHOLD_M) {
        output[index] = middle;
      }
    }
  }
  return output;
}

async function clean(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([buffer]));
  // Read the dimensions before closing the bitmap: close() zeroes them, and
  // getImageData with a height of zero throws.
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    return buffer;
  }

  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, width, height);
  const size = width;
  encode(despike(decode(image.data, size), size), image.data);
  context.putImageData(image, 0, 0);

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blob.arrayBuffer();
}

let registered = false;

export function registerCleanDemProtocol(): void {
  if (registered || typeof window === "undefined") return;
  registered = true;

  addProtocol(CLEAN_DEM_PROTOCOL, async (params, abortController) => {
    const url = params.url.replace(`${CLEAN_DEM_PROTOCOL}://`, "https://");
    const response = await fetch(url, { signal: abortController.signal });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();

    // Filtering is an improvement, not a requirement. A browser without
    // OffscreenCanvas gets the raw tile and a couple of needles rather than no
    // terrain at all.
    //
    // The counters are here because that fallback is silent by design, and a
    // bug that sent every tile down it looked exactly like no bug at all. The
    // e2e suite asserts on them.
    const stats = ((window as any).__demStats ??= {
      cleaned: 0,
      raw: 0,
      lastError: null as string | null,
    });
    if (typeof OffscreenCanvas === "undefined") {
      stats.raw++;
      return { data: buffer };
    }
    try {
      const data = await clean(buffer);
      stats.cleaned++;
      return { data };
    } catch (error) {
      stats.raw++;
      stats.lastError = String(error);
      return { data: buffer };
    }
  });
}
