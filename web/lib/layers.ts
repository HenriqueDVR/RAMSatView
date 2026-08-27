/**
 * What the map is currently drawing.
 *
 * Kept out of the Map component so the panel that toggles these and the map
 * that honours them agree on one shape, and so the defaults are stated once
 * rather than implied by whatever the map happened to be built with.
 */

export type LayerKey =
  | "satellite"
  | "terrain"
  | "cloud"
  | "heatmap"
  | "observed";

export type LayerState = Record<LayerKey, boolean>;

export const DEFAULT_LAYERS: LayerState = {
  satellite: true,
  terrain: true,
  cloud: true,
  // Off by default, and mutually exclusive with the volumetric deck: the two
  // answer the same question in two ways and stacking them is mud. See
  // exclusiveLayers below.
  heatmap: false,
  // On by default: it is the only layer here that is measured rather than
  // modelled, and a layer nobody switches on is a layer nobody sees.
  observed: true,
};

/**
 * The order they appear in the panel: ground up, which is also the order they
 * are drawn in and the order someone would think about them.
 */
export const LAYER_ORDER: LayerKey[] = [
  "satellite",
  "terrain",
  "cloud",
  "heatmap",
  "observed",
];

/**
 * Turning one of these on turns the other off.
 *
 * The volumetric cloud draws where the cloud *is*; the heatmap draws how high
 * its top *reaches*. Both are the same field, so on screen at once they cover
 * each other and the colour that carries the whole answer is read through a
 * translucent deck. Enforced here rather than in the panel so any caller that
 * sets a layer gets the same rule.
 */
export function exclusiveLayers(
  current: LayerState,
  key: LayerKey,
  value: boolean
): LayerState {
  const next = { ...current, [key]: value };
  if (!value) return next;
  if (key === "cloud") next.heatmap = false;
  if (key === "heatmap") next.cloud = false;
  return next;
}
