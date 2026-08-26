/**
 * A tileable 3D noise volume, generated once and uploaded as a texture.
 *
 * The cloud volume needs several noise lookups per fragment - the density
 * itself, plus taps along the light direction for self-shadowing - and it is
 * drawn as a stack of full-screen-ish slices, so a fragment can be shaded a
 * dozen times over. Evaluating fbm analytically at that rate is what turns a
 * phone into a hand warmer; a texture fetch is a handful of cycles and the
 * hardware interpolates for free.
 *
 * Tileable matters: the volume is sampled with REPEAT wrapping over an area
 * far larger than the texture, and any seam would draw a straight line across
 * the sky - which is exactly the artefact that made the old flat-quad deck
 * read as a printed sheet.
 *
 * Two channels, because clouds are self-similar at two scales that need to be
 * driven independently:
 *   R - low frequency. The shape of the deck: where the holes are.
 *   G - high frequency. The billows and the ragged edges, applied only where
 *       R already says there is cloud, so the detail erodes the shape rather
 *       than adding a second one.
 */

/** 64 is the smallest size where the low-frequency band does not visibly repeat. */
export const NOISE_SIZE = 64;

/**
 * Deterministic hash of a lattice point, wrapped to `period` so the field is
 * seamless. Integer-only in and float out: the usual sin()-based hash loses
 * precision at these magnitudes and starts returning bands.
 */
function latticeValue(x: number, y: number, z: number, period: number, seed: number): number {
  const xi = ((x % period) + period) % period;
  const yi = ((y % period) + period) % period;
  const zi = ((z % period) + period) % period;
  let h = xi * 374761393 + yi * 668265263 + zi * 2147483647 + seed * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Trilinear value noise on a lattice of `period` cells across the volume. */
function valueNoise(
  x: number,
  y: number,
  z: number,
  period: number,
  seed: number
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const fz = smooth(z - z0);

  let result = 0;
  for (let dz = 0; dz < 2; dz++) {
    const wz = dz === 0 ? 1 - fz : fz;
    for (let dy = 0; dy < 2; dy++) {
      const wy = dy === 0 ? 1 - fy : fy;
      for (let dx = 0; dx < 2; dx++) {
        const wx = dx === 0 ? 1 - fx : fx;
        result +=
          wx * wy * wz * latticeValue(x0 + dx, y0 + dy, z0 + dz, period, seed);
      }
    }
  }
  return result;
}

/**
 * Sum octaves whose lattice periods all divide the texture size, which is what
 * keeps the sum tileable. Returns roughly 0..1.
 */
function fbm(
  u: number,
  v: number,
  w: number,
  periods: number[],
  seed: number
): number {
  let total = 0;
  let amplitude = 0.5;
  let weight = 0;
  for (let octave = 0; octave < periods.length; octave++) {
    const period = periods[octave];
    total +=
      amplitude *
      valueNoise(u * period, v * period, w * period, period, seed + octave);
    weight += amplitude;
    amplitude *= 0.5;
  }
  return total / weight;
}

/**
 * RGBA8 data for a `NOISE_SIZE` cube, ready for `texImage3D`.
 *
 * B and A are left at zero rather than filled with two more bands: the shader
 * does not sample them today, and a 64-cube of RGBA is 1MB of VRAM whether
 * they carry anything or not.
 */
export function generateNoiseVolume(size = NOISE_SIZE): Uint8Array {
  const data = new Uint8Array(size * size * size * 4);
  const shapePeriods = [4, 8, 16];
  const detailPeriods = [8, 16, 32];

  let index = 0;
  for (let z = 0; z < size; z++) {
    const w = z / size;
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        data[index] = Math.round(255 * fbm(u, v, w, shapePeriods, 1));
        data[index + 1] = Math.round(255 * fbm(u, v, w, detailPeriods, 97));
        index += 4;
      }
    }
  }
  return data;
}
