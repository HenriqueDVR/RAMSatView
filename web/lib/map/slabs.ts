/**
 * Choosing which altitudes of the forecast get drawn as cloud.
 *
 * Split out of CloudDeckLayer so it can be tested without a browser: that
 * module imports maplibre-gl, which touches window at import time.
 */

/** [altitude_m, cloud_fraction], as published by the ingest. */
export type ProfilePoint = [number, number];

/** Below this the layer is haze, not deck, and drawing it just fogs the view. */
export const MIN_VISIBLE_FRACTION = 0.12;

/** Vertical spacing between drawn slabs. Finer than this reads as solid. */
export const SLAB_STEP_M = 200;

/** Fill rate, not memory, is the constraint on a phone. */
export const MAX_SLABS = 10;

/** A slab at full cloud fraction is still see-through. */
export const MAX_SLAB_OPACITY = 0.34;

// The matrix MapLibre hands a custom layer (the transform's _viewProjMatrix)
// does NOT take 0..1 mercator coordinates - that is _mercatorMatrix, which is
// what v4 passed and what the shipped docstring example still shows. It takes
// world PIXELS in x and y (mercator x worldSize, so zoom-dependent) and
// METRES in z, because it scales z by pixelsPerMetre itself.
//
// Geometry is therefore stored zoom-independently as mercator + altitude, and
// scaled here each frame. Getting this wrong is silent: the quads project to a
// single off-screen point behind the far plane and nothing is ever drawn.
/**
 * Pick the altitudes worth drawing.
 *
 * Exported because the choice of what counts as a deck is a modelling decision
 * and deserves tests of its own, not a debugger session inside a render loop.
 */
export function selectSlabs(
  profile: ProfilePoint[],
  stepM = SLAB_STEP_M
): ProfilePoint[] {
  const slabs: ProfilePoint[] = [];
  let nextAltitude = -Infinity;
  for (const [altitude, fraction] of profile) {
    if (fraction < MIN_VISIBLE_FRACTION) continue;
    if (altitude < nextAltitude) continue;
    slabs.push([altitude, fraction]);
    nextAltitude = altitude + stepM;
  }
  if (slabs.length <= MAX_SLABS) return slabs;
  // Keep the ends and thin the middle: the base and the top of the deck are
  // the two altitudes the user is actually comparing against the summit.
  const stride = slabs.length / MAX_SLABS;
  const thinned: ProfilePoint[] = [];
  for (let index = 0; index < MAX_SLABS; index++) {
    thinned.push(slabs[Math.min(slabs.length - 1, Math.round(index * stride))]);
  }
  return thinned;
}
