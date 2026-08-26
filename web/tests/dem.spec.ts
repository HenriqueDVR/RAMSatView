import { expect, test } from "@playwright/test";
import {
  OCEAN_FLOOR_M,
  decode,
  despike,
  encode,
  flattenOcean,
} from "../lib/map/demFilter";

/**
 * Unit tests for the DEM filter, no browser.
 *
 * The ocean clamp is the one that matters: without it the map is correct at
 * z10 and wrong at z11, which is a bug that only appears while panning.
 */

function grid(size: number, fill: number): Float32Array {
  return new Float32Array(size * size).fill(fill);
}

test("a lone spike is pulled back to its neighbours", () => {
  const heights = grid(5, 800);
  heights[2 * 5 + 2] = 1400;
  expect(despike(heights, 5)[2 * 5 + 2]).toBe(800);
});

test("a real ridge is not a spike", () => {
  const heights = grid(5, 800);
  // A whole row raised is terrain: every sample agrees with two neighbours.
  for (let x = 0; x < 5; x++) heights[2 * 5 + x] = 1400;
  expect(despike(heights, 5)[2 * 5 + 2]).toBe(1400);
});

test("edge samples are left alone so tiles do not open seams", () => {
  const heights = grid(5, 800);
  heights[0] = 5000;
  expect(despike(heights, 5)[0]).toBe(5000);
});

test("sea level and everything under it is pushed below the sea plane", () => {
  // 0 is what Terrarium reports for open ocean above zoom 10; -2000 is what
  // it reports for the same water at zoom 10. Both must end up in the same
  // place, or the sea floor changes height as the user zooms.
  const heights = flattenOcean(new Float32Array([0, -2000, -0.4, 0.5]));
  expect(Array.from(heights)).toEqual([
    OCEAN_FLOOR_M,
    OCEAN_FLOOR_M,
    OCEAN_FLOOR_M,
    OCEAN_FLOOR_M,
  ]);
});

test("land is untouched", () => {
  const heights = flattenOcean(new Float32Array([1, 1862, 12.5]));
  expect(Array.from(heights)).toEqual([1, 1862, 12.5]);
});

test("a height survives a decode/encode round trip", () => {
  const pixels = new Uint8ClampedArray(4);
  encode(new Float32Array([1818.5]), pixels);
  expect(decode(pixels, 1)[0]).toBeCloseTo(1818.5, 2);
});

test("the ocean floor constant survives the round trip", () => {
  const pixels = new Uint8ClampedArray(4);
  encode(new Float32Array([OCEAN_FLOOR_M]), pixels);
  expect(decode(pixels, 1)[0]).toBeCloseTo(OCEAN_FLOOR_M, 2);
});
