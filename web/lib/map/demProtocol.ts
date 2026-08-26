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
import { decode, despike, encode, flattenOcean } from "./demFilter";

export const CLEAN_DEM_PROTOCOL = "terrarium-clean";

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
  encode(flattenOcean(despike(decode(image.data, size), size)), image.data);
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
