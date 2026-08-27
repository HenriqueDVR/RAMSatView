/**
 * The cloud-top heatmap: a canvas source draped over the terrain.
 *
 * Deliberately not a custom WebGL layer, unlike the sky, the sea and the
 * cloud. A raster layer is draped onto the terrain mesh by MapLibre for free -
 * the colour follows the ridges and the ravines - whereas a custom quad is
 * flat and would float above the island like a sheet of paper. The field is
 * eight by ten cells, so drawing it on the CPU costs nothing and the texture
 * filtering does the interpolation the eye wants anyway.
 */

import type { Map as MapLibreMap } from "maplibre-gl";
import {
  DECK_THRESHOLD,
  cloudTopAt,
  type CloudGrid,
} from "@/lib/cloudGrid";
import { cloudTopColour } from "./cloudTop";

export const CLOUD_TOP_SOURCE_ID = "cloud-top";
export const CLOUD_TOP_LAYER_ID = "cloud-top";

/**
 * Samples per grid cell along each axis.
 *
 * The grid is ~0.13 degrees, which is coarse enough that bilinear filtering of
 * one texel per cell shows the cell boundaries as diamonds. Sampling the field
 * itself at 6x - which is trilinear in lon, lat and altitude - gives the
 * smooth field the data actually describes rather than a mosaic of it.
 */
const SUPERSAMPLE = 6;

/** How solid the heatmap is over the terrain. */
const ALPHA = 0.62;

export class CloudTopLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private added = false;
  private visible = false;

  constructor(private readonly map: MapLibreMap) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.context = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  /**
   * Draw one hour of the volume.
   *
   * Null removes the layer rather than leaving the last hour on screen: with
   * no volume there is nothing measured to show, and a stale field over a
   * fresh scrubber position is the one failure this whole pipeline is built to
   * avoid.
   */
  setFrame(grid: CloudGrid | null, timeIndex: number): void {
    if (!grid || !this.context) {
      this.remove();
      return;
    }

    const [west, south, east, north] = grid.header.bbox;
    const width = Math.max(2, grid.header.cols * SUPERSAMPLE);
    const height = Math.max(2, grid.header.rows * SUPERSAMPLE);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      // The source holds a reference to the element, but its texture is sized
      // on the first upload, so a resize has to start a new source.
      this.remove();
    }

    const image = this.context.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      // Row 0 of the canvas is the north edge, matching the blob's own layout.
      const lat = north - ((y + 0.5) / height) * (north - south);
      for (let x = 0; x < width; x++) {
        const lon = west + ((x + 0.5) / width) * (east - west);
        const top = cloudTopAt(grid, timeIndex, lon, lat);
        const offset = (y * width + x) * 4;
        if (top === null) {
          // Clear air. Transparent rather than a colour meaning "none": the
          // island underneath is the answer there.
          image.data[offset + 3] = 0;
          continue;
        }
        const [r, g, b] = cloudTopColour(top);
        image.data[offset] = r;
        image.data[offset + 1] = g;
        image.data[offset + 2] = b;
        image.data[offset + 3] = Math.round(ALPHA * 255);
      }
    }
    this.context.putImageData(image, 0, 0);

    this.ensureAdded(grid.header.bbox);
    this.reupload();
  }

  /**
   * Push the redrawn canvas into the source's texture.
   *
   * A canvas source uploads once and then only re-uploads while it is
   * "playing" - `animate: false` means it never is, and the scrubber would
   * move over a texture frozen on whichever hour happened to arrive first.
   * Playing for exactly one frame is the whole of the fix: `play` triggers a
   * repaint, the render pass re-uploads, and `pause` puts it back to costing
   * nothing. Animating permanently would upload 80x64 pixels sixty times a
   * second to show a field that changes when the user drags a slider.
   */
  private reupload(): void {
    const source = this.map.getSource(CLOUD_TOP_SOURCE_ID) as unknown as
      | { play?: () => void; pause?: () => void }
      | undefined;
    if (!source?.play) return;
    source.play();
    this.map.once("render", () => source.pause?.());
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!this.map.getLayer(CLOUD_TOP_LAYER_ID)) return;
    this.map.setLayoutProperty(
      CLOUD_TOP_LAYER_ID,
      "visibility",
      visible ? "visible" : "none"
    );
  }

  remove(): void {
    if (!this.added) return;
    if (this.map.getLayer(CLOUD_TOP_LAYER_ID)) {
      this.map.removeLayer(CLOUD_TOP_LAYER_ID);
    }
    if (this.map.getSource(CLOUD_TOP_SOURCE_ID)) {
      this.map.removeSource(CLOUD_TOP_SOURCE_ID);
    }
    this.added = false;
  }

  private ensureAdded(bbox: [number, number, number, number]): void {
    if (this.added) return;
    const [west, south, east, north] = bbox;
    this.map.addSource(CLOUD_TOP_SOURCE_ID, {
      type: "canvas",
      canvas: this.canvas,
      // Clockwise from the top left, as the source expects.
      coordinates: [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ],
      animate: false,
    });
    this.map.addLayer({
      id: CLOUD_TOP_LAYER_ID,
      type: "raster",
      source: CLOUD_TOP_SOURCE_ID,
      layout: { visibility: this.visible ? "visible" : "none" },
      paint: {
        "raster-opacity": 1,
        // The alpha is baked into the canvas; leaving resampling linear is
        // what turns eight by ten cells into a field.
        "raster-resampling": "linear",
        "raster-fade-duration": 0,
      },
    });
    this.added = true;
  }
}

/** Re-exported so the legend and the layer agree on the cut-off. */
export { DECK_THRESHOLD };
