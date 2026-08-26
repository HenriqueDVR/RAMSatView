import { expect, test } from "@playwright/test";
import { cloudAt, deckVerdict, type ViewpointDay } from "../lib/conditions";
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
    visibility: { value: 90, confidence: 0.7, reasons: ["clear"] },
    cloud_sea: { value: 50, confidence: 0.7, reasons: ["deck"] },
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
  expect(cloudAt([[0, 0], [1000, 1]], 500)).toBeCloseTo(0.5, 5);
});

test("cloudAt clamps outside the profile rather than extrapolating", () => {
  const points: [number, number][] = [[500, 0.4], [1500, 0.8]];
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
