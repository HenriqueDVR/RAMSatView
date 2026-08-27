/**
 * Each spot's own numbers, hour by hour.
 *
 * Without this the scrubber moved the map and nothing else: the volume, the
 * heatmap, the observed field and the sun all followed the hour, while the
 * sidebar, the sheet and the callout kept showing the *day* summary. Scrub to
 * 04:00 and the picture and the panel beside it were answering different
 * questions - which is the one failure this product cannot afford, because the
 * whole pitch is that the number and the picture agree.
 *
 * Shipped as a byte per sample beside conditions.json, for the reason stated
 * in ingest/scoring/spothours.py: as JSON the same series is sixty kilobytes
 * against a document that is meant to stay under thirty-five, and it is
 * fetched over mobile data on a mountain road.
 */

export type SpotHoursSeries = {
  name: string;
  /** `value = byte * scale + offset`. */
  scale: number;
  offset: number;
};

export type SpotHoursHeader = {
  file: string;
  generated_at: string;
  /** First hour, UTC. The series is contiguous from here at `step_h`. */
  t0: string;
  step_h: number;
  count: number;
  /** Order is the index: a spot's block is found by its position here. */
  spots: string[];
  series: SpotHoursSeries[];
  /** The byte that means "no value", to be read as null rather than as zero. */
  missing: number;
  bytes: number;
};

export type SpotHours = {
  header: SpotHoursHeader;
  values: Uint8Array;
  t0Ms: number;
};

/** What one hour says about one spot. Any field may be missing. */
export type SpotHour = {
  deckBaseM: number | null;
  deckTopM: number | null;
  cloudAtSummit: number | null;
  temperatureC: number | null;
  windKmh: number | null;
  /** Aerosol optical depth: Saharan dust, which hazes a view the vertical
   *  profile cannot see at all. */
  aod: number | null;
};

export function expectedBytes(header: SpotHoursHeader): number {
  return header.spots.length * header.series.length * header.count;
}

export function spotHoursUrl(
  header: SpotHoursHeader,
  documentUrl: string,
): string {
  const base = documentUrl.slice(0, documentUrl.lastIndexOf("/") + 1);
  return `${base}${header.file}`;
}

export function decodeSpotHours(
  header: SpotHoursHeader,
  values: Uint8Array,
): SpotHours {
  const expected = expectedBytes(header);
  if (header.bytes !== expected) {
    throw new Error(
      `spot hours header declares ${header.bytes} bytes for ${expected} samples`,
    );
  }
  if (values.length !== expected) {
    throw new Error(
      `spot hours is ${values.length} bytes, expected ${expected}`,
    );
  }
  return { header, values, t0Ms: new Date(header.t0).getTime() };
}

export async function loadSpotHours(
  header: SpotHoursHeader,
  documentUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotHours> {
  const response = await fetchImpl(spotHoursUrl(header, documentUrl), {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`spot hours: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  return decodeSpotHours(header, new Uint8Array(buffer));
}

/**
 * The index of the hour covering an instant, or null when it is outside what
 * was published.
 *
 * Null rather than the nearest edge. Both the forecast and the archive end,
 * and holding the last hour in place while the scrubber runs past it would
 * present one hour's weather as another's.
 */
export function hourIndexAt(hours: SpotHours, atMs: number): number | null {
  const step = hours.header.step_h * 3600_000;
  const index = Math.round((atMs - hours.t0Ms) / step);
  return index < 0 || index >= hours.header.count ? null : index;
}

function seriesValue(
  hours: SpotHours,
  spotIndex: number,
  seriesIndex: number,
  hourIndex: number,
): number | null {
  const { series, count, missing } = hours.header;
  const at =
    spotIndex * series.length * count + seriesIndex * count + hourIndex;
  const raw = hours.values[at];
  if (raw === missing) return null;
  return raw * series[seriesIndex].scale + series[seriesIndex].offset;
}

/**
 * Everything published for one spot at one instant, or null when that spot or
 * that hour is not in the blob.
 *
 * The series are looked up by name rather than by position, so the ingest can
 * add one without this reading the wrong channel until both sides are
 * redeployed.
 */
export function spotHourAt(
  hours: SpotHours,
  spotId: string,
  atMs: number,
): SpotHour | null {
  const spotIndex = hours.header.spots.indexOf(spotId);
  if (spotIndex < 0) return null;
  const hourIndex = hourIndexAt(hours, atMs);
  if (hourIndex === null) return null;

  const read = (name: string) => {
    const seriesIndex = hours.header.series.findIndex(
      (series) => series.name === name,
    );
    if (seriesIndex < 0) return null;
    return seriesValue(hours, spotIndex, seriesIndex, hourIndex);
  };

  return {
    deckBaseM: read("deck_base_m"),
    deckTopM: read("deck_top_m"),
    cloudAtSummit: read("cloud_at_summit"),
    temperatureC: read("temperature_c"),
    windKmh: read("wind_kmh"),
    aod: read("aod"),
  };
}

/** The span the blob covers, as epoch milliseconds. */
export function coverage(hours: SpotHours): { fromMs: number; toMs: number } {
  const step = hours.header.step_h * 3600_000;
  return {
    fromMs: hours.t0Ms,
    toMs: hours.t0Ms + (hours.header.count - 1) * step,
  };
}
