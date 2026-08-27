/**
 * Observed cloud-top altitude: the only layer on this map that was measured.
 *
 * Produced by ingest/scoring/cloudtop.py from NOAA's geostationary infrared
 * mosaic and shipped beside conditions.json as a raw byte blob - one unsigned
 * byte per cell, laid out [time][row][col] with row 0 at the *north* edge, each
 * byte a multiple of `step_m` metres. 255 is not an altitude: it means the
 * mosaic had no retrieval for that cell, and a renderer that drew it as cloud
 * would put a 12km tower wherever two satellites overlap badly.
 *
 * Where the forecast volume answers "how much cloud, at what height, when",
 * this answers only "how high is the top of what the satellite can see". That
 * is less, and it is worth having anyway, because it is not a model's opinion.
 */

export type ObservedCloudHeader = {
  file: string;
  generated_at: string;
  source: string;
  /** Cell centres, north to south. Shipped explicitly: the mosaic's rows are
   *  evenly spaced in its own projection, not in latitude. */
  lats: number[];
  /** Cell centres, west to east. */
  lons: number[];
  rows: number;
  cols: number;
  /** Metres per stored unit. */
  step_m: number;
  /** The byte that means "no retrieval", to be left as a hole. */
  missing: number;
  times: string[];
  bytes: number;
};

export type ObservedCloud = {
  header: ObservedCloudHeader;
  values: Uint8Array;
  /** Epoch milliseconds for each hour, parsed once. */
  timesMs: number[];
};

export function cellsPerHour(header: ObservedCloudHeader): number {
  return header.rows * header.cols;
}

export function expectedBytes(header: ObservedCloudHeader): number {
  return header.times.length * cellsPerHour(header);
}

/**
 * The box the cells cover, as [west, south, east, north].
 *
 * Half a cell wider than the outermost centres in each direction, because a
 * cell is an area and its centre is not its edge. Drawing the field stretched
 * between the centres would shift the whole picture by four kilometres.
 */
export function bounds(
  header: ObservedCloudHeader
): [number, number, number, number] {
  const { lats, lons } = header;
  const latStep = lats.length > 1 ? Math.abs(lats[0] - lats[1]) : 0;
  const lonStep = lons.length > 1 ? Math.abs(lons[1] - lons[0]) : 0;
  return [
    lons[0] - lonStep / 2,
    lats[lats.length - 1] - latStep / 2,
    lons[lons.length - 1] + lonStep / 2,
    lats[0] + latStep / 2,
  ];
}

export function observedCloudUrl(
  header: ObservedCloudHeader,
  documentUrl: string
): string {
  const base = documentUrl.slice(0, documentUrl.lastIndexOf("/") + 1);
  return `${base}${header.file}`;
}

export function decodeObservedCloud(
  header: ObservedCloudHeader,
  values: Uint8Array
): ObservedCloud {
  const expected = expectedBytes(header);
  if (header.bytes !== expected) {
    throw new Error(
      `observed cloud header declares ${header.bytes} bytes for ${expected} cells`
    );
  }
  if (values.length !== expected) {
    throw new Error(`observed cloud is ${values.length} bytes, expected ${expected}`);
  }
  if (header.lats.length !== header.rows || header.lons.length !== header.cols) {
    throw new Error("observed cloud footprint does not match its shape");
  }
  return {
    header,
    values,
    timesMs: header.times.map((time) => new Date(time).getTime()),
  };
}

export async function loadObservedCloud(
  header: ObservedCloudHeader,
  documentUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<ObservedCloud> {
  const url = observedCloudUrl(header, documentUrl);
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`observed cloud: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  return decodeObservedCloud(header, new Uint8Array(buffer));
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(length - 1, Math.round(index)));
}

/** One hour, contiguous, row 0 north. */
export function hourSlice(observed: ObservedCloud, timeIndex: number): Uint8Array {
  const stride = cellsPerHour(observed.header);
  const start = clampIndex(timeIndex, observed.timesMs.length) * stride;
  return observed.values.subarray(start, start + stride);
}

/**
 * Cloud-top metres at a cell, `null` where the satellite saw nothing usable
 * and `0` where it saw clear sky. The two are different answers and the caller
 * has to be able to tell them apart.
 */
export function topAt(
  observed: ObservedCloud,
  timeIndex: number,
  row: number,
  col: number
): number | null {
  const { rows, cols, step_m, missing } = observed.header;
  if (row < 0 || row >= rows || col < 0 || col >= cols) return null;
  const raw = hourSlice(observed, timeIndex)[row * cols + col];
  return raw === missing ? null : raw * step_m;
}

/**
 * Nearest observed hour to a wall-clock instant, or null when the request is
 * outside what was published.
 *
 * Observation only ever reaches backwards - there is no satellite image of
 * tomorrow - so scrubbing into the forecast has to return nothing rather than
 * pinning the last scan in place and passing three-hour-old cloud off as an
 * observation of the future.
 */
export function nearestHourIndex(
  observed: ObservedCloud,
  atMs: number,
  toleranceMs = 90 * 60 * 1000
): number | null {
  let best = -1;
  let bestGap = Infinity;
  observed.timesMs.forEach((time, index) => {
    const gap = Math.abs(time - atMs);
    if (gap < bestGap) {
      bestGap = gap;
      best = index;
    }
  });
  return best >= 0 && bestGap <= toleranceMs ? best : null;
}

/**
 * Fraction of the window the satellite actually saw cloud over, ignoring holes.
 *
 * The one number worth putting in words beside the map: it is what tells
 * someone at 4am whether the deck they are driving up to see is really there.
 */
export function cloudCover(observed: ObservedCloud, timeIndex: number): number {
  const slice = hourSlice(observed, timeIndex);
  const { missing, step_m } = observed.header;
  let seen = 0;
  let clouded = 0;
  for (const raw of slice) {
    if (raw === missing) continue;
    seen += 1;
    if (raw * step_m > 0) clouded += 1;
  }
  return seen === 0 ? 0 : clouded / seen;
}
