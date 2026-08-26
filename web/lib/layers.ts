/**
 * What the map is currently drawing.
 *
 * Kept out of the Map component so the panel that toggles these and the map
 * that honours them agree on one shape, and so the defaults are stated once
 * rather than implied by whatever the map happened to be built with.
 */

export type LayerKey = "satellite" | "terrain" | "cloud" | "sea";

export type LayerState = Record<LayerKey, boolean>;

export const DEFAULT_LAYERS: LayerState = {
  satellite: true,
  terrain: true,
  cloud: true,
  sea: true,
};

/**
 * The order they appear in the panel: ground up, which is also the order they
 * are drawn in and the order someone would think about them.
 */
export const LAYER_ORDER: LayerKey[] = ["satellite", "terrain", "sea", "cloud"];
