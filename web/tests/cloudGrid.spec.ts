import { expect, test } from "@playwright/test";
import {
  type CloudGridHeader,
  altitudeIndexFor,
  cellValue,
  cloudGridUrl,
  cloudTopAt,
  columnFor,
  columnProfile,
  decodeCloudGrid,
  envelopeProfile,
  hourSlice,
  loadCloudGrid,
  rowFor,
  sampleCloud,
  timeIndexFor,
} from "../lib/cloudGrid";

/**
 * The volume arrives as bare bytes with its shape described elsewhere, so the
 * failure this file guards against is not a crash - it is cloud drawn over the
 * wrong island, or an hour ahead, with nothing visibly wrong on screen.
 */

const ALTITUDES = [0, 250, 500, 750, 1000];
const TIMES = ["2026-08-26T09:00:00Z", "2026-08-26T10:00:00Z"];

/** 2x2 cells over a square degree, so lat/lon arithmetic is checkable by hand. */
function header(): CloudGridHeader {
  return {
    file: "cloud-grid.bin",
    generated_at: "2026-08-26T09:00:00Z",
    bbox: [-17, 32, -16, 33],
    cols: 2,
    rows: 2,
    altitudes_m: ALTITUDES,
    times: TIMES,
    bytes: TIMES.length * ALTITUDES.length * 4,
  };
}

/** `fill(time, altitudeIndex, row, col)` returns 0..255. */
function volume(
  fill: (t: number, a: number, row: number, col: number) => number
): Uint8Array {
  const values = new Uint8Array(TIMES.length * ALTITUDES.length * 4);
  let offset = 0;
  for (let t = 0; t < TIMES.length; t++) {
    for (let a = 0; a < ALTITUDES.length; a++) {
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 2; col++) values[offset++] = fill(t, a, row, col);
      }
    }
  }
  return values;
}

test("bytes are read back in the order the ingest wrote them", () => {
  // Every cell distinct, so a transposed axis cannot pass.
  const grid = decodeCloudGrid(
    header(),
    volume((t, a, row, col) => t * 100 + a * 10 + row * 2 + col)
  );
  expect(cellValue(grid, 1, 3, 1, 0) * 255).toBeCloseTo(132, 5);
  expect(cellValue(grid, 0, 0, 0, 1) * 255).toBeCloseTo(1, 5);
});

test("a blob of the wrong length is refused rather than read short", () => {
  expect(() => decodeCloudGrid(header(), new Uint8Array(39))).toThrow(
    /39 bytes, expected 40/
  );
});

test("a header that contradicts its own shape is refused", () => {
  const wrong = { ...header(), bytes: 39 };
  expect(() => decodeCloudGrid(wrong, new Uint8Array(40))).toThrow(
    /declares 39 bytes/
  );
});

test("one hour is a contiguous run, ready for texImage3D", () => {
  const grid = decodeCloudGrid(header(), volume((t) => (t === 1 ? 255 : 0)));
  const slice = hourSlice(grid, 1);
  expect(slice.length).toBe(ALTITUDES.length * 4);
  expect(Array.from(slice).every((byte) => byte === 255)).toBe(true);
});

test("row zero is the north edge", () => {
  const grid = header();
  expect(rowFor(grid, 33)).toBeCloseTo(0, 6);
  expect(rowFor(grid, 32)).toBeCloseTo(1, 6);
  expect(columnFor(grid, -17)).toBeCloseTo(0, 6);
  expect(columnFor(grid, -16)).toBeCloseTo(1, 6);
});

test("the altitude ladder is regular, so its index is arithmetic", () => {
  expect(altitudeIndexFor(header(), 375)).toBeCloseTo(1.5, 6);
  expect(altitudeIndexFor(header(), 1000)).toBeCloseTo(4, 6);
});

test("sampling blends across cells and levels", () => {
  // Cloud only in the north-west cell, only at 500m.
  const grid = decodeCloudGrid(
    header(),
    volume((_t, a, row, col) => (a === 2 && row === 0 && col === 0 ? 255 : 0))
  );
  expect(sampleCloud(grid, 0, -17, 33, 500)).toBeCloseTo(1, 3);
  // Halfway east: half the cloud. Halfway up to the next level: half again.
  expect(sampleCloud(grid, 0, -16.5, 33, 500)).toBeCloseTo(0.5, 2);
  expect(sampleCloud(grid, 0, -17, 33, 625)).toBeCloseTo(0.5, 2);
  // The other corner of the box is clear.
  expect(sampleCloud(grid, 0, -16, 32, 500)).toBeCloseTo(0, 3);
});

test("outside the box there is no forecast, and none is invented", () => {
  const grid = decodeCloudGrid(header(), volume(() => 255));
  expect(sampleCloud(grid, 0, -14, 33, 500)).toBe(0);
  expect(sampleCloud(grid, 0, -17, 40, 500)).toBe(0);
  // Above the ladder it clamps to the top level rather than dropping to zero:
  // cirrus above 3000m is not modelled, not known to be absent.
  expect(sampleCloud(grid, 0, -17, 33, 9000)).toBeCloseTo(1, 3);
});

test("the deck top is the highest level thick enough to stand above", () => {
  const grid = decodeCloudGrid(
    header(),
    // Solid to 500m, wisps at 750m that no one stands above.
    volume((_t, a) => (a <= 2 ? 230 : a === 3 ? 40 : 0))
  );
  expect(cloudTopAt(grid, 0, -16.5, 32.5)).toBe(500);
});

test("a clear sky has no deck at all", () => {
  const grid = decodeCloudGrid(header(), volume(() => 10));
  expect(cloudTopAt(grid, 0, -16.5, 32.5)).toBeNull();
});

test("the scrubber snaps to the nearest hour and clamps at the ends", () => {
  const grid = decodeCloudGrid(header(), volume(() => 0));
  expect(timeIndexFor(grid, new Date("2026-08-26T09:20:00Z"))).toBe(0);
  expect(timeIndexFor(grid, new Date("2026-08-26T09:40:00Z"))).toBe(1);
  expect(timeIndexFor(grid, new Date("2020-01-01T00:00:00Z"))).toBe(0);
  expect(timeIndexFor(grid, new Date("2030-01-01T00:00:00Z"))).toBe(1);
});

test("the blob is fetched as the document's sibling", () => {
  expect(cloudGridUrl(header(), "/conditions.json")).toBe("/cloud-grid.bin");
  expect(cloudGridUrl(header(), "https://cdn.example/v1/conditions.json")).toBe(
    "https://cdn.example/v1/cloud-grid.bin"
  );
});

test("a failed fetch reports the status rather than returning empty sky", async () => {
  const failing = (async () =>
    ({ ok: false, status: 404 }) as unknown as Response) as typeof fetch;
  await expect(
    loadCloudGrid(header(), "/conditions.json", failing)
  ).rejects.toThrow(/HTTP 404/);
});

test("the envelope keeps the worst cell, so a deck over one coast still gets slices", () => {
  const grid = decodeCloudGrid(
    header(),
    // Solid at 500m over the north-west corner only.
    volume((_t, a, row, col) => (a === 2 && row === 0 && col === 0 ? 255 : 0))
  );
  expect(envelopeProfile(grid, 0)).toEqual([
    [0, 0],
    [250, 0],
    [500, 1],
    [750, 0],
    [1000, 0],
  ]);
});

test("a column reads the ladder over one point", () => {
  const grid = decodeCloudGrid(header(), volume((_t, a) => (a === 4 ? 255 : 0)));
  const column = columnProfile(grid, 0, -16.5, 32.5);
  expect(column.map(([altitude]) => altitude)).toEqual(ALTITUDES);
  expect(column[4][1]).toBeCloseTo(1, 3);
  expect(column[0][1]).toBeCloseTo(0, 3);
});
