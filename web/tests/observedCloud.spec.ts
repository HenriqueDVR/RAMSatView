import { expect, test } from "@playwright/test";
import {
  bounds,
  cloudCover,
  decodeObservedCloud,
  hourSlice,
  loadObservedCloud,
  nearestHourIndex,
  observedCloudUrl,
  topAt,
  type ObservedCloudHeader,
} from "../lib/observedCloud";
import { imageCoordinates, rampColour, rgbaFrame } from "../lib/map/ObservedLayer";
import { RAMP_TOP_M, cloudTopColour } from "../lib/map/cloudTop";

/**
 * The observed field arrives as bare bytes, like the volume, but it carries a
 * heavier claim: it says what the sky *did*. The failures worth guarding
 * against are therefore the quiet ones - the field drawn half a cell off the
 * island, an hour of forecast passed off as an observation, or a hole in the
 * mosaic coloured in as clear sky.
 */

const TIMES = ["2026-08-27T04:00:00Z", "2026-08-27T05:00:00Z"];
const STEP_M = 50;

/** 2x2 cells with half-degree spacing, so the arithmetic is checkable by eye. */
function header(overrides: Partial<ObservedCloudHeader> = {}): ObservedCloudHeader {
  return {
    file: "cloud-observed.bin",
    generated_at: "2026-08-27T05:30:00Z",
    source: "NOAA GMGSI longwave infrared",
    lats: [33.0, 32.5],
    lons: [-17.0, -16.5],
    rows: 2,
    cols: 2,
    step_m: STEP_M,
    missing: 255,
    times: TIMES,
    bytes: TIMES.length * 4,
    ...overrides,
  };
}

/** North-west cell clouded in the first hour, north-east in the second. */
function bytes(): Uint8Array {
  return new Uint8Array([
    24, 0, 0, 255, // hour 0: 1200m top, clear, clear, hole
    0, 24, 0, 0, // hour 1: the cloud has moved east
  ]);
}

function observed() {
  return decodeObservedCloud(header(), bytes());
}

test("a blob of the wrong length is refused rather than read short", () => {
  expect(() => decodeObservedCloud(header(), new Uint8Array(6))).toThrow(
    /6 bytes, expected 8/
  );
});

test("a header that disagrees with itself is refused", () => {
  expect(() => decodeObservedCloud(header({ bytes: 6 }), bytes())).toThrow(
    /declares 6 bytes/
  );
});

test("a footprint that does not match the shape is refused", () => {
  expect(() =>
    decodeObservedCloud(header({ lats: [33.0, 32.5, 32.0] }), bytes())
  ).toThrow(/footprint/);
});

test("the blob is the document's sibling", () => {
  expect(observedCloudUrl(header(), "https://example.com/data/conditions.json")).toBe(
    "https://example.com/data/cloud-observed.bin"
  );
});

test("bounds run half a cell past the outermost centres", () => {
  // Centres are at 33.0/32.5 and -17.0/-16.5, so the box is a quarter degree
  // wider on every side. Stretching it between the centres instead would shift
  // the whole picture by four kilometres.
  expect(bounds(header())).toEqual([-17.25, 32.25, -16.25, 33.25]);
});

test("rows run north first", () => {
  const field = observed();
  expect(topAt(field, 0, 0, 0)).toBe(1200);
  expect(topAt(field, 0, 1, 0)).toBe(0);
});

test("an hour later is a different field", () => {
  const field = observed();
  expect(topAt(field, 1, 0, 0)).toBe(0);
  expect(topAt(field, 1, 0, 1)).toBe(1200);
});

test("hourSlice cuts one contiguous hour", () => {
  expect(Array.from(hourSlice(observed(), 1))).toEqual([0, 24, 0, 0]);
});

test("a hole is null, clear sky is zero, and they are not the same answer", () => {
  const field = observed();
  expect(topAt(field, 0, 1, 1)).toBeNull();
  expect(topAt(field, 0, 0, 1)).toBe(0);
});

test("cells outside the window are null rather than wrapping around", () => {
  expect(topAt(observed(), 0, 2, 0)).toBeNull();
  expect(topAt(observed(), 0, 0, -1)).toBeNull();
});

test("the nearest hour is found within tolerance", () => {
  const field = observed();
  expect(nearestHourIndex(field, Date.parse("2026-08-27T04:50:00Z"))).toBe(1);
  expect(nearestHourIndex(field, Date.parse("2026-08-27T04:10:00Z"))).toBe(0);
});

test("scrubbing into the forecast finds nothing observed", () => {
  // There is no satellite image of tomorrow. Pinning the last scan here would
  // caption three-hour-old cloud as an observation of the future.
  const field = observed();
  expect(nearestHourIndex(field, Date.parse("2026-08-28T06:00:00Z"))).toBeNull();
});

test("cover counts clouded cells and ignores the holes", () => {
  // Hour 0 has one clouded cell, two clear and one hole: one in three of what
  // was actually seen.
  expect(cloudCover(observed(), 0)).toBeCloseTo(1 / 3, 5);
});

test("cover is zero when the satellite saw nothing at all", () => {
  const blind = decodeObservedCloud(
    header(),
    new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255])
  );
  expect(cloudCover(blind, 0)).toBe(0);
});

test("loading checks the length before the renderer ever sees it", async () => {
  const fetchImpl = (async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array(4).buffer,
  })) as unknown as typeof fetch;

  await expect(
    loadObservedCloud(header(), "https://example.com/conditions.json", fetchImpl)
  ).rejects.toThrow(/4 bytes, expected 8/);
});

// --- what gets drawn ------------------------------------------------------

test("clear sky is fully transparent, not a pale colour", () => {
  expect(rampColour(0)[3]).toBe(0);
});

test("a higher top is more opaque than a lower one", () => {
  const low = rampColour(400);
  const high = rampColour(2000);
  expect(high[3]).toBeGreaterThan(low[3]);
});

test("the colour is the heatmap's, so one legend reads both layers", () => {
  // Not merely "similar": if these two ever drift apart, the legend on screen
  // is lying about one of the layers it claims to key.
  for (const metres of [200, 900, 1500, 1800, 1950, 2400]) {
    expect(rampColour(metres).slice(0, 3)).toEqual(cloudTopColour(metres));
  }
});

test("the deck either side of the summits is not one colour", () => {
  // The failure this replaces: every marine top round Madeira lands between
  // 600m and 1500m, and the old cyan ramp rendered that whole band as one
  // shade, so the measured field arrived as a flat blue sheet.
  const below = rampColour(1100);
  const above = rampColour(1950);
  const distance =
    Math.abs(below[0] - above[0]) +
    Math.abs(below[1] - above[1]) +
    Math.abs(below[2] - above[2]);
  expect(distance).toBeGreaterThan(120);
});

test("tops above the ramp clamp instead of wrapping to black", () => {
  const colour = rampColour(20000);
  expect(colour[3]).toBeGreaterThan(200);
  expect(colour.slice(0, 3)).toEqual(cloudTopColour(RAMP_TOP_M));
});

test("a hole is drawn as nothing at all", () => {
  const pixels = rgbaFrame(observed(), 0);
  // The fourth cell of hour 0 is the hole.
  expect(Array.from(pixels.slice(12, 16))).toEqual([0, 0, 0, 0]);
  // And the first is the cloud, so the frame is not simply empty.
  expect(pixels[3]).toBeGreaterThan(0);
});

test("image corners are given top-left first, the order an image source wants", () => {
  expect(imageCoordinates(observed())).toEqual([
    [-17.25, 33.25],
    [-16.25, 33.25],
    [-16.25, 32.25],
    [-17.25, 32.25],
  ]);
});
