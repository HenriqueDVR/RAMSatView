import type { Conditions } from "../lib/conditions";

/**
 * A frozen conditions document.
 *
 * Snapshot tests cannot run against the live forecast: every ingest would
 * rewrite the numbers, the dates and the SVG geometry drawn from them, and the
 * snapshots would churn daily while catching nothing. This document holds the
 * two cases that matter - a viewpoint with a deck below the summit, and a
 * beach carrying an official warning - with every value fixed.
 *
 * `generated_at` and `stale_at` are the exception: they are relative to now,
 * because a fixed timestamp would put the page into its stale state a few
 * hours after this file was written. Nothing snapshotted reads them.
 */

const DATE = "2026-08-26";

function profile(baseM: number, topM: number): [number, number][] {
  const points: [number, number][] = [];
  for (let altitude = 0; altitude <= 3000; altitude += 100) {
    points.push([altitude, altitude >= baseM && altitude <= topM ? 0.9 : 0.02]);
  }
  return points;
}

export function fixtureConditions(now = Date.now()): Conditions {
  return {
    schema_version: 3,
    generated_at: new Date(now - 12 * 60_000).toISOString(),
    stale_at: new Date(now + 3 * 3600_000).toISOString(),
    attribution: ["Open-Meteo", "IPMA", "EOX Sentinel-2 cloudless"],
    // Snapshots stay on the profile-shaped fallback: a fixed volume would add
    // a quarter-megabyte of bytes to review for a picture the deck already
    // draws. The volume is exercised in cloudGrid.spec.ts instead.
    cloud_grid: null,
    // Same reasoning: the observed field is bytes, and observedCloud.spec.ts
    // is where its decoding and its colour ramp are pinned.
    cloud_observed: null,
    // And the same again for the per-spot hourly series. The snapshots are of
    // the day summary, which is what the panel shows when no hour is in play;
    // spotHours.spec.ts covers the decoding and hours.spec.ts the wiring.
    spot_hours: null,
    official: {
      source: "IPMA",
      issued_at: new Date(now - 40 * 60_000).toISOString(),
      warnings: [
        {
          area: "MPS",
          type: "Agitação Marítima",
          level: "yellow",
          severity: 2,
          text: "Ondas de nordeste com 2 a 3 metros.",
          start: `${DATE}T06:00:00Z`,
          end: `${DATE}T18:00:00Z`,
        },
      ],
      uv_index: { MRM: 8.5, MPS: 8.9 },
      fire_risk_available: false,
    },
    spots: [
      {
        id: "pico-arieiro",
        type: "viewpoint",
        name: { pt: "Pico do Areeiro", en: "Pico do Arieiro" },
        lat: 32.7357,
        lon: -16.9284,
        elevation_m: 1818,
        ipma_area: "MRM",
        notes: "Road access to summit. The classic sea-of-clouds sunrise spot.",
        days: [
          {
            date: DATE,
            sunrise_utc: `${DATE}T06:38:00Z`,
            visibility: {
              value: 92,
              confidence: 0.78,
              reasons: ["clear air above the summit"],
            },
            cloud_sea: {
              value: 81,
              confidence: 0.74,
              reasons: [
                "cloud deck forecast at 1400 m, below the summit",
                "temperature inversion present (+3.2 C)",
              ],
            },
            deck_base_m: 600,
            deck_top_m: 1400,
            inversion_c: 3.2,
            temperature_c: 11,
            wind_kmh: 8.4,
            precipitation_mm: 0,
            profile: profile(600, 1400),
          },
        ],
      },
      {
        id: "pico-ruivo",
        type: "viewpoint",
        name: { pt: "Pico Ruivo", en: "Pico Ruivo" },
        lat: 32.7581,
        lon: -16.9422,
        elevation_m: 1862,
        ipma_area: "MRM",
        notes: "Highest peak on the island, on foot only.",
        days: [
          {
            date: DATE,
            sunrise_utc: `${DATE}T06:38:00Z`,
            visibility: {
              value: 64,
              confidence: 0.6,
              reasons: ["thin cloud at summit level"],
            },
            cloud_sea: {
              value: 35,
              confidence: 0.6,
              reasons: ["deck top close to the summit"],
            },
            deck_base_m: 900,
            deck_top_m: 1700,
            inversion_c: 1.1,
            temperature_c: 9,
            wind_kmh: 22.0,
            precipitation_mm: 0,
            profile: profile(900, 1700),
          },
        ],
      },
      {
        id: "porto-santo-beach",
        type: "beach",
        name: { pt: "Praia de Porto Santo", en: "Porto Santo Beach" },
        lat: 33.0567,
        lon: -16.3383,
        elevation_m: 0,
        ipma_area: "MPS",
        notes: "9km of golden sand. The main draw of the island.",
        days: [
          {
            date: DATE,
            score: {
              value: 47.3,
              confidence: 0.9,
              reasons: ["moderate swell", "very high UV - shade and sunscreen"],
            },
            sst_c: 24.5,
            wave_height_m: 1.29,
            wave_period_s: 7.8,
            wind_kmh: 13.1,
            uv_index: 8.9,
            warnings: [
              {
                area: "MPS",
                type: "Agitação Marítima",
                level: "yellow",
                severity: 2,
                text: "Ondas de nordeste com 2 a 3 metros.",
                start: `${DATE}T06:00:00Z`,
                end: `${DATE}T18:00:00Z`,
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * A small forecast volume, for the scrubber and the shaped deck.
 *
 * Four columns by three rows rather than the real ten by eight: the tests care
 * that the axes are read in the right order and that the control moves through
 * hours, and a smaller volume makes the expected bytes checkable by hand.
 *
 * The hours straddle now, like the published volume does, so the "now" mark
 * and the archive half of the track both exist.
 */
export const FIXTURE_GRID = {
  cols: 4,
  rows: 3,
  altitudes: [
    0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000,
  ],
  hours: 7,
};

export function fixtureGridHeader(now = Date.now()) {
  const top = Math.floor(now / 3_600_000) * 3_600_000;
  const times: string[] = [];
  for (let hour = -3; hour < FIXTURE_GRID.hours - 3; hour++) {
    times.push(new Date(top + hour * 3_600_000).toISOString());
  }
  const cells = FIXTURE_GRID.cols * FIXTURE_GRID.rows;
  return {
    file: "cloud-grid.bin",
    generated_at: new Date(now - 12 * 60_000).toISOString(),
    bbox: [-17.5, 32.3, -16.2, 33.2] as [number, number, number, number],
    cols: FIXTURE_GRID.cols,
    rows: FIXTURE_GRID.rows,
    altitudes_m: FIXTURE_GRID.altitudes,
    times,
    bytes: times.length * FIXTURE_GRID.altitudes.length * cells,
  };
}

/**
 * Per-spot hourly series on the same clock as the grid above.
 *
 * The deck is driven *down* through the summits across the hours: the first
 * hours put its top well above Arieiro, the last well below. That is the one
 * transition the panel has to follow - a spot that reads "summit inside the
 * cloud" at one end of the scrubber and "above the cloud sea" at the other -
 * and a stuck readout shows up as a verdict that never changes.
 */
export function fixtureSpotHoursHeader(grid = fixtureGridHeader()) {
  const series = [
    { name: "deck_base_m", scale: 20, offset: 0 },
    { name: "deck_top_m", scale: 20, offset: 0 },
    { name: "cloud_at_summit", scale: 0.005, offset: 0 },
    { name: "temperature_c", scale: 0.25, offset: -25 },
    { name: "wind_kmh", scale: 0.5, offset: 0 },
    { name: "aod", scale: 0.01, offset: 0 },
  ];
  const spots = ["pico-arieiro", "pico-ruivo", "porto-santo-beach"];
  return {
    file: "spot-hours.bin",
    generated_at: grid.generated_at,
    t0: grid.times[0],
    step_h: 1,
    count: grid.times.length,
    spots,
    series,
    missing: 255,
    bytes: spots.length * series.length * grid.times.length,
  };
}

export function fixtureSpotHoursBytes(
  header = fixtureSpotHoursHeader(),
): Uint8Array {
  const values = new Uint8Array(header.bytes);
  const { count, spots, series } = header;
  let offset = 0;
  for (let spot = 0; spot < spots.length; spot++) {
    for (const channel of series) {
      for (let hour = 0; hour < count; hour++) {
        const through = count > 1 ? hour / (count - 1) : 0;
        // 2600m down to 900m: starts over both summits, ends under them.
        const top = 2600 - 1700 * through;
        let value: number;
        switch (channel.name) {
          case "deck_base_m":
            value = 400;
            break;
          case "deck_top_m":
            value = top;
            break;
          case "cloud_at_summit":
            // Cloudy at the summit only while the deck is still above it.
            value = top > 1900 ? 0.9 : 0.02;
            break;
          case "temperature_c":
            value = 8 + hour;
            break;
          case "aod":
            // Clean maritime air throughout. The calima wording is exercised
            // in spotHours.spec.ts; here it must simply not appear.
            value = 0.1;
            break;
          default:
            value = 5 + hour;
        }
        values[offset++] = Math.max(
          0,
          Math.min(254, Math.round((value - channel.offset) / channel.scale)),
        );
      }
    }
  }
  return values;
}

/**
 * A deck that thickens over the hours and lies over the north half of the box,
 * so a wrong axis or a stuck hour shows up as a picture that does not change.
 */
export function fixtureGridBytes(header = fixtureGridHeader()): Uint8Array {
  const { cols, rows, altitudes_m, times } = header;
  const values = new Uint8Array(header.bytes);
  let offset = 0;
  for (let hour = 0; hour < times.length; hour++) {
    for (let level = 0; level < altitudes_m.length; level++) {
      const altitude = altitudes_m[level];
      const inDeck = altitude >= 750 && altitude <= 1500;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const north = row < rows / 2;
          const growth = (hour + 1) / times.length;
          values[offset++] = inDeck && north ? Math.round(255 * growth) : 0;
        }
      }
    }
  }
  return values;
}
