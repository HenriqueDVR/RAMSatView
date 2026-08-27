import { expect, test } from "@playwright/test";
import {
  SCHEMA_VERSION,
  cloudAt,
  deckVerdict,
  loadConditions,
  type ViewpointDay,
} from "../lib/conditions";
import { reasonText, translator } from "../lib/i18n";
import { selectSlabs } from "../lib/map/slabs";

/**
 * Unit tests, no browser. These cover the two pieces of judgement that sit
 * between the forecast and what the user is told: which altitudes get drawn,
 * and which of the three things the card says.
 */

function profile(baseM: number, topM: number): [number, number][] {
  const points: [number, number][] = [];
  for (let a = 0; a <= 3000; a += 100) {
    points.push([a, a >= baseM && a <= topM ? 0.9 : 0.02]);
  }
  return points;
}

function day(over: Partial<ViewpointDay>): ViewpointDay {
  return {
    date: "2026-08-26",
    sunrise_utc: "2026-08-26T06:38:00Z",
    visibility: {
      value: 90,
      confidence: 0.7,
      reasons: [{ code: "vis.clear_above" }],
    },
    cloud_sea: {
      value: 50,
      confidence: 0.7,
      reasons: [{ code: "sea.no_deck" }],
    },
    deck_base_m: null,
    deck_top_m: null,
    inversion_c: 0,
    temperature_c: 12,
    wind_kmh: 5,
    precipitation_mm: 0,
    profile: [],
    ...over,
  };
}

test("cloudAt interpolates between samples", () => {
  expect(
    cloudAt(
      [
        [0, 0],
        [1000, 1],
      ],
      500,
    ),
  ).toBeCloseTo(0.5, 5);
});

test("cloudAt clamps outside the profile rather than extrapolating", () => {
  const points: [number, number][] = [
    [500, 0.4],
    [1500, 0.8],
  ];
  expect(cloudAt(points, 0)).toBe(0.4);
  expect(cloudAt(points, 9000)).toBe(0.8);
});

test("a deck well below the summit reads as above the cloud", () => {
  const subject = day({ profile: profile(600, 1400), deck_top_m: 1400 });
  expect(deckVerdict(subject, 1818)).toBe("above");
});

test("cloud at the summit reads as inside it, whatever the deck top says", () => {
  const subject = day({ profile: profile(1600, 2400), deck_top_m: 2400 });
  expect(deckVerdict(subject, 1818)).toBe("inside");
});

test("a deck top within the margin of the summit is not called a cloud sea", () => {
  // 1750m against an 1818m summit is inside the model's dead zone: the
  // pressure levels are too far apart to tell those two apart.
  const subject = day({ profile: profile(600, 1750), deck_top_m: 1750 });
  expect(deckVerdict(subject, 1818)).toBe("none");
});

test("clear air reads as no deck", () => {
  const subject = day({ profile: profile(-1, -1) });
  expect(deckVerdict(subject, 1818)).toBe("none");
});

test("selectSlabs skips haze and spaces the slabs it keeps", () => {
  const slabs = selectSlabs(profile(600, 1400));
  expect(slabs.length).toBeGreaterThan(0);
  expect(slabs.every(([, fraction]) => fraction >= 0.12)).toBe(true);
  for (let index = 1; index < slabs.length; index++) {
    expect(slabs[index][0] - slabs[index - 1][0]).toBeGreaterThanOrEqual(200);
  }
});

test("selectSlabs draws nothing for a clear profile", () => {
  expect(selectSlabs(profile(-1, -1))).toEqual([]);
});

// --- the bilingual contract ----------------------------------------------

test("a code with no wording shows the code rather than an empty line", () => {
  // A score with an unexplained number beside it is what validate() refuses to
  // publish on the other side of the pipeline. A missing translation must look
  // wrong rather than silently drop the explanation.
  const t = translator("en");
  expect(reasonText(t, { code: "nothing.like.this" })).toBe(
    "nothing.like.this",
  );
});

test("a cached document from an older schema is discarded, not rendered", async () => {
  // The network path checks the version and throws; the catch then reaches for
  // the cache. An unchecked cache walked straight around the tripwire and
  // rendered a document from the previous schema - which is the one thing the
  // version check exists to stop.
  const CACHE_KEY = "conditions:last-good";
  const store = new Map<string, string>();
  const stale = { schema_version: SCHEMA_VERSION - 1, spots: [] };
  store.set(CACHE_KEY, JSON.stringify(stale));

  const window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
  const restore = globalThis.window;
  (globalThis as { window?: unknown }).window = window;
  const failing = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const original = globalThis.fetch;
  globalThis.fetch = failing;

  try {
    await expect(loadConditions()).rejects.toThrow();
    // And it is cleared, so it cannot be offered again on the next load.
    expect(store.has(CACHE_KEY)).toBe(false);
  } finally {
    globalThis.fetch = original;
    (globalThis as { window?: unknown }).window = restore;
  }
});
