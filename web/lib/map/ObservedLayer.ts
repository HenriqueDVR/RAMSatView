/**
 * The observed cloud field, painted flat over the map.
 *
 * Deliberately not volumetric. The forecast volume already draws cloud in
 * three dimensions, and stacking a second three-dimensional cloud on top of it
 * would produce a picture in which nobody could tell which body was the model
 * and which was the satellite. This layer is a plan view - a shape on the sea,
 * coloured by how high its top is - so the two read as what they are: a
 * prediction you fly through, and a measurement you look down on.
 *
 * Implemented as an image source rather than a custom WebGL layer for the same
 * reason: eighteen by fifteen cells do not need a shader, and MapLibre's own
 * `raster-resampling: linear` gives the smoothing for free.
 */

import type { Map as MapLibreMap, ImageSource } from "maplibre-gl";
import {
  bounds,
  cellsPerHour,
  hourSlice,
  type ObservedCloud,
} from "@/lib/observedCloud";
import { cloudTopColour } from "./cloudTop";

export const OBSERVED_SOURCE_ID = "observed-cloud";
export const OBSERVED_LAYER_ID = "observed-cloud";

/**
 * Opacity stops for the observed field, in metres.
 *
 * Only the opacity lives here. The *colour* is `cloudTopColour` from
 * ./cloudTop - the same ramp the heatmap and its legend are drawn from -
 * because both layers answer the identical question, "how high is the top",
 * and answering it in two different colour languages on one map is worse than
 * answering it twice. This layer used to carry its own cyan ramp keyed to the
 * HUD, and the result was a flat blue sheet: marine stratocumulus round
 * Madeira tops out between roughly 600m and 1500m, which was exactly the band
 * that ramp rendered as one bright cyan, so the entire measured field arrived
 * as a single colour carrying no information at all.
 *
 * Opacity still climbs with altitude, which is not decoration: a low top is a
 * shallow deck you can see terrain through, a high one is a body of cloud that
 * hides what is under it, and the picture should say so.
 */
const ALPHA: { m: number; alpha: number }[] = [
  { m: 0, alpha: 0 },
  { m: 1, alpha: 0.45 },
  { m: 900, alpha: 0.62 },
  { m: 1800, alpha: 0.72 },
  { m: 3000, alpha: 0.8 },
];

export type Rgba = [number, number, number, number];

function alphaFor(topM: number): number {
  if (topM <= 0) return 0;
  for (let index = 1; index < ALPHA.length; index++) {
    const upper = ALPHA[index];
    if (topM > upper.m) continue;
    const lower = ALPHA[index - 1];
    const span = upper.m - lower.m;
    const weight = span <= 0 ? 0 : (topM - lower.m) / span;
    return lower.alpha + (upper.alpha - lower.alpha) * weight;
  }
  return ALPHA[ALPHA.length - 1].alpha;
}

/** Colour for one cloud-top altitude, as 8-bit RGBA. */
export function rampColour(topM: number): Rgba {
  if (topM <= 0) return [0, 0, 0, 0];
  const [r, g, b] = cloudTopColour(topM);
  return [r, g, b, Math.round(255 * alphaFor(topM))];
}

/**
 * One hour of the field as RGBA bytes, row-major from the north-west corner -
 * the order ImageData wants, which is also the order the blob is already in.
 *
 * A cell with no retrieval comes out fully transparent, the same as clear sky.
 * They are different facts, and this is the one place the difference is
 * deliberately dropped: a hole in the mosaic drawn as anything at all would be
 * a claim about the sky that nothing measured.
 */
export function rgbaFrame(observed: ObservedCloud, timeIndex: number): Uint8ClampedArray {
  const { missing, step_m } = observed.header;
  const slice = hourSlice(observed, timeIndex);
  const pixels = new Uint8ClampedArray(cellsPerHour(observed.header) * 4);
  for (let index = 0; index < slice.length; index++) {
    const raw = slice[index];
    const colour: Rgba =
      raw === missing ? [0, 0, 0, 0] : rampColour(raw * step_m);
    pixels.set(colour, index * 4);
  }
  return pixels;
}

/**
 * Corner coordinates in the order an image source wants them: top-left,
 * top-right, bottom-right, bottom-left.
 */
export function imageCoordinates(
  observed: ObservedCloud
): [[number, number], [number, number], [number, number], [number, number]] {
  const [west, south, east, north] = bounds(observed.header);
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

function toDataUrl(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("observed cloud: no 2d context");
  // Copied into a fresh buffer: ImageData will not take a view whose backing
  // buffer TypeScript cannot prove is a plain ArrayBuffer.
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Adds the field to a map and keeps it pointed at one hour.
 *
 * The source is created on the first frame and updated in place after that.
 * Adding and removing it per hour would restart the raster fade on every step
 * of the scrubber, which turns a smooth scrub into a strobe.
 */
export class ObservedLayer {
  private map: MapLibreMap;
  private beforeId: string | undefined;
  private added = false;
  private lastKey: string | null = null;

  /**
   * `beforeId` decides what this can cover. It belongs above the basemap and
   * the hillshade - it is a picture of the sky, not of the ground - and below
   * the forecast volume, which is a three-dimensional body that a flat raster
   * drawn last would paint straight over. Left unset in practice: the volume
   * is a custom layer, and custom layers are drawn after every style layer
   * whatever order they were added in.
   */
  constructor(map: MapLibreMap, beforeId?: string) {
    this.map = map;
    this.beforeId = beforeId;
  }

  /** Draw one hour. Pass null to leave the map with nothing observed on it. */
  setFrame(observed: ObservedCloud | null, timeIndex: number): void {
    if (!observed) {
      this.setVisible(false);
      this.lastKey = null;
      return;
    }
    const { rows, cols } = observed.header;
    const key = `${observed.header.generated_at}:${timeIndex}`;
    if (key === this.lastKey) return;

    const url = toDataUrl(rgbaFrame(observed, timeIndex), cols, rows);
    const coordinates = imageCoordinates(observed);

    if (!this.added) {
      this.map.addSource(OBSERVED_SOURCE_ID, {
        type: "image",
        url,
        coordinates,
      });
      this.map.addLayer(
        {
          id: OBSERVED_LAYER_ID,
          type: "raster",
          source: OBSERVED_SOURCE_ID,
          paint: {
            "raster-opacity": 1,
            // Smooths eight-kilometre cells into something that reads as cloud
            // rather than as a spreadsheet.
            "raster-resampling": "linear",
            // No cross-fade: the scrubber steps whole hours and a fade would
            // show two hours of weather at once, halfway between them.
            "raster-fade-duration": 0,
          },
        },
        this.beforeId && this.map.getLayer(this.beforeId)
          ? this.beforeId
          : undefined
      );
      this.added = true;
    } else {
      const source = this.map.getSource(OBSERVED_SOURCE_ID) as
        | ImageSource
        | undefined;
      source?.updateImage({ url, coordinates });
    }
    this.lastKey = key;
  }

  setVisible(visible: boolean): void {
    if (!this.added) return;
    if (!this.map.getLayer(OBSERVED_LAYER_ID)) return;
    this.map.setLayoutProperty(
      OBSERVED_LAYER_ID,
      "visibility",
      visible ? "visible" : "none"
    );
  }

  remove(): void {
    if (!this.added) return;
    if (this.map.getLayer(OBSERVED_LAYER_ID)) {
      this.map.removeLayer(OBSERVED_LAYER_ID);
    }
    if (this.map.getSource(OBSERVED_SOURCE_ID)) {
      this.map.removeSource(OBSERVED_SOURCE_ID);
    }
    this.added = false;
    this.lastKey = null;
  }
}
