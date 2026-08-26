/**
 * Where the camera actually is.
 *
 * MapLibre's public API answers questions about the *target*: `getCenter`,
 * `getCameraTargetElevation`. Two things here need the eye itself - the water
 * fades with distance from it, and the cloud slices have to be composited in
 * the order the eye sees them - and v6 exposes that only on the transform.
 *
 * `map.transform` is typed as a public getter in the d.ts but is not present
 * on the built instance; the transform lives on the camera the Map inherits
 * from. Both routes are tried and the whole thing is optional: every caller
 * has to work without it, because this is the kind of internal that moves
 * between minor versions without notice.
 */

import type { LngLat, Map as MapLibreMap } from "maplibre-gl";

type Transform = {
  getCameraAltitude?: () => number;
  getCameraLngLat?: () => LngLat;
};

type MapInternals = {
  transform?: Transform;
  _camera?: { transform?: Transform };
};

export type CameraState = {
  /** Metres above sea level. */
  altitude: number;
  lngLat: LngLat;
};

export function cameraState(map: MapLibreMap): CameraState | null {
  try {
    const internals = map as unknown as MapInternals;
    const transform = internals.transform ?? internals._camera?.transform;
    const altitude = transform?.getCameraAltitude?.();
    const lngLat = transform?.getCameraLngLat?.();
    if (altitude === undefined || !Number.isFinite(altitude)) return null;
    if (!lngLat) return null;
    return { altitude, lngLat };
  } catch {
    return null;
  }
}
