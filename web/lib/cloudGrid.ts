/**
 * The gridded cloud volume: the forecast as a shape over the archipelago.
 *
 * Produced by ingest/sources/openmeteo_grid.py and shipped beside
 * conditions.json as a raw byte blob - one unsigned byte of cloud fraction per
 * cell, laid out [time][altitude][row][col] with row 0 at the *north* edge.
 * There is no header inside the file; everything needed to read it travels in
 * conditions.json, which is why the length check below is not optional.
 *
 * The layout is chosen so one hour is a contiguous run of bytes that can be
 * handed straight to texImage3D with width = cols, height = rows, depth =
 * altitudes. Nothing here rearranges it.
 */

export type CloudGridHeader = {
  file: string;
  generated_at: string;
  /** [west, south, east, north] - matches BOUNDS in lib/map/sources.ts. */
  bbox: [number, number, number, number];
  cols: number;
  rows: number;
  altitudes_m: number[];
  times: string[];
  bytes: number;
};

export type CloudGrid = {
  header: CloudGridHeader;
  values: Uint8Array;
  /** Epoch milliseconds for each hour, parsed once. */
  timesMs: number[];
};

export function cellsPerLevel(header: CloudGridHeader): number {
  return header.cols * header.rows;
}

export function cellsPerHour(header: CloudGridHeader): number {
  return header.altitudes_m.length * cellsPerLevel(header);
}

export function expectedBytes(header: CloudGridHeader): number {
  return header.times.length * cellsPerHour(header);
}

/**
 * Where the blob lives, relative to wherever the document was fetched from.
 *
 * The pair is published together - locally into web/public, in production into
 * the same R2 bucket - so the blob is always the document's sibling. Deriving
 * it rather than configuring it separately removes the way they could point at
 * two different runs.
 */
export function cloudGridUrl(header: CloudGridHeader, documentUrl: string): string {
  const base = documentUrl.slice(0, documentUrl.lastIndexOf("/") + 1);
  return `${base}${header.file}`;
}

/**
 * Fetch and check the volume.
 *
 * A blob of the wrong length is refused rather than read short: the renderer
 * has no way to notice, so a truncated file would draw a plausible-looking
 * volume with the last hours silently black.
 */
export async function loadCloudGrid(
  header: CloudGridHeader,
  documentUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<CloudGrid> {
  const url = cloudGridUrl(header, documentUrl);
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`cloud grid: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  return decodeCloudGrid(header, new Uint8Array(buffer));
}

export function decodeCloudGrid(
  header: CloudGridHeader,
  values: Uint8Array
): CloudGrid {
  const expected = expectedBytes(header);
  if (header.bytes !== expected) {
    throw new Error(
      `cloud grid header declares ${header.bytes} bytes for a ${expected}-byte volume`
    );
  }
  if (values.length !== expected) {
    throw new Error(
      `cloud grid is ${values.length} bytes, expected ${expected}`
    );
  }
  return {
    header,
    values,
    timesMs: header.times.map((time) => new Date(time).getTime()),
  };
}

/** One hour, contiguous, ready to upload as a 3D texture. */
export function hourSlice(grid: CloudGrid, timeIndex: number): Uint8Array {
  const stride = cellsPerHour(grid.header);
  const start = clampIndex(timeIndex, grid.timesMs.length) * stride;
  return grid.values.subarray(start, start + stride);
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(length - 1, Math.round(index)));
}

/** Cloud fraction 0..1 at exact grid coordinates. */
export function cellValue(
  grid: CloudGrid,
  timeIndex: number,
  altitudeIndex: number,
  row: number,
  col: number
): number {
  const { cols, rows, altitudes_m } = grid.header;
  const t = clampIndex(timeIndex, grid.timesMs.length);
  const a = clampIndex(altitudeIndex, altitudes_m.length);
  const r = clampIndex(row, rows);
  const c = clampIndex(col, cols);
  const offset = (t * altitudes_m.length + a) * cols * rows + r * cols + c;
  return grid.values[offset] / 255;
}

/**
 * The hour nearest a wall-clock instant, clamped to the ends of the volume.
 *
 * Clamped rather than wrapped or refused: the scrubber runs from a week back
 * to three days ahead, and asking for something outside that should show the
 * edge of what is known, not an empty sky.
 */
export function timeIndexFor(grid: CloudGrid, at: Date | number): number {
  const target = typeof at === "number" ? at : at.getTime();
  const times = grid.timesMs;
  if (!times.length) return 0;
  if (target <= times[0]) return 0;
  if (target >= times[times.length - 1]) return times.length - 1;

  // Hourly and regular, so the index is arithmetic; the scan is only a guard
  // against a gap in the model run.
  let best = 0;
  let bestGap = Infinity;
  for (let index = 0; index < times.length; index++) {
    const gap = Math.abs(times[index] - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = index;
    }
  }
  return best;
}

/** Fractional position of a longitude within the grid's columns. */
export function columnFor(header: CloudGridHeader, lon: number): number {
  const [west, , east] = header.bbox;
  const span = east - west;
  if (span === 0) return 0;
  return ((lon - west) / span) * (header.cols - 1);
}

/** Fractional row for a latitude. Row 0 is the north edge, as written. */
export function rowFor(header: CloudGridHeader, lat: number): number {
  const [, south, , north] = header.bbox;
  const span = north - south;
  if (span === 0) return 0;
  return ((north - lat) / span) * (header.rows - 1);
}

/** Fractional index on the altitude ladder, which is regular by construction. */
export function altitudeIndexFor(
  header: CloudGridHeader,
  altitudeM: number
): number {
  const ladder = header.altitudes_m;
  if (ladder.length < 2) return 0;
  const step = ladder[1] - ladder[0];
  return (altitudeM - ladder[0]) / step;
}

function lerp(a: number, b: number, weight: number): number {
  return a + (b - a) * weight;
}

/**
 * Cloud fraction at an arbitrary point, trilinear in lon, lat and altitude.
 *
 * Deliberately not interpolated in time: the scrubber snaps to whole hours, so
 * blending two of them would only smear the one thing the user is looking for,
 * which is when the deck arrives.
 */
export function sampleCloud(
  grid: CloudGrid,
  timeIndex: number,
  lon: number,
  lat: number,
  altitudeM: number
): number {
  const { header } = grid;
  const col = columnFor(header, lon);
  const row = rowFor(header, lat);
  const alt = altitudeIndexFor(header, altitudeM);

  // Outside the box there is no forecast, and extrapolated cloud is fiction -
  // the same rule the Python side applies above and below the profile.
  if (
    col < -0.5 ||
    col > header.cols - 0.5 ||
    row < -0.5 ||
    row > header.rows - 0.5
  ) {
    return 0;
  }
  if (alt <= 0) return sampleLevel(grid, timeIndex, 0, row, col);
  const top = header.altitudes_m.length - 1;
  if (alt >= top) return sampleLevel(grid, timeIndex, top, row, col);

  const lower = Math.floor(alt);
  return lerp(
    sampleLevel(grid, timeIndex, lower, row, col),
    sampleLevel(grid, timeIndex, lower + 1, row, col),
    alt - lower
  );
}

/** Bilinear within one altitude level. */
function sampleLevel(
  grid: CloudGrid,
  timeIndex: number,
  altitudeIndex: number,
  row: number,
  col: number
): number {
  const col0 = Math.floor(col);
  const row0 = Math.floor(row);
  const fx = col - col0;
  const fy = row - row0;
  const top = lerp(
    cellValue(grid, timeIndex, altitudeIndex, row0, col0),
    cellValue(grid, timeIndex, altitudeIndex, row0, col0 + 1),
    fx
  );
  const bottom = lerp(
    cellValue(grid, timeIndex, altitudeIndex, row0 + 1, col0),
    cellValue(grid, timeIndex, altitudeIndex, row0 + 1, col0 + 1),
    fx
  );
  return lerp(top, bottom, fy);
}

/**
 * Highest altitude where cloud is thick enough to stand above, or null.
 *
 * The threshold matches DECK_THRESHOLD in lib/conditions.ts and
 * ingest/scoring/inversion.py; a map that disagreed with the card beside it
 * would cost the user their trust in both.
 */
export const DECK_THRESHOLD = 0.35;

export function cloudTopAt(
  grid: CloudGrid,
  timeIndex: number,
  lon: number,
  lat: number
): number | null {
  const ladder = grid.header.altitudes_m;
  for (let index = ladder.length - 1; index >= 0; index--) {
    if (sampleCloud(grid, timeIndex, lon, lat, ladder[index]) >= DECK_THRESHOLD) {
      return ladder[index];
    }
  }
  return null;
}

/**
 * The volume flattened to one profile: the most cloud found at each altitude.
 *
 * This is what the deck's slices are built from. The slices span the whole box
 * and each one draws its coverage from the field per pixel, so what the
 * profile has to answer is not "how much cloud" but "at which altitudes is
 * there any cloud worth cutting a slice for" - and that is a maximum, not an
 * average. Averaging hid a solid deck over the north coast whenever the south
 * was clear, which is the most common morning on this island.
 */
export function envelopeProfile(
  grid: CloudGrid,
  timeIndex: number
): [number, number][] {
  const { cols, rows, altitudes_m } = grid.header;
  return altitudes_m.map((altitude, level) => {
    let peak = 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const value = cellValue(grid, timeIndex, level, row, col);
        if (value > peak) peak = value;
      }
    }
    return [altitude, peak] as [number, number];
  });
}

/** The forecast column over one point, in the same shape as a spot profile. */
export function columnProfile(
  grid: CloudGrid,
  timeIndex: number,
  lon: number,
  lat: number
): [number, number][] {
  return grid.header.altitudes_m.map((altitude) => [
    altitude,
    sampleCloud(grid, timeIndex, lon, lat, altitude),
  ]);
}
