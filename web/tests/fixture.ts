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
    schema_version: 2,
    generated_at: new Date(now - 12 * 60_000).toISOString(),
    stale_at: new Date(now + 3 * 3600_000).toISOString(),
    attribution: ["Open-Meteo", "IPMA", "EOX Sentinel-2 cloudless"],
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
