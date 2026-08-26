import { expect, test } from "@playwright/test";
import { sunPosition, sunVector } from "../lib/sun";

/**
 * Solar position, checked against values that can be looked up independently.
 *
 * Tolerances are generous - a degree - because the point is that the geometry
 * is right, not that this replaces an ephemeris. A bug here would be an
 * hour-scale or hemisphere-scale error, and none of those survive a degree.
 */

const ARIEIRO = { lat: 32.7357, lon: -16.9284 };

test("the sun is in the east at sunrise over Madeira", () => {
  // 2026-08-26: the sun crosses the horizon at Pico do Arieiro at about 06:42
  // UTC, which is 07:42 local - Madeira is on WEST, UTC+1, in August. That
  // matches the published sunrise for Funchal to within a couple of minutes,
  // which is the check that this file is computing the real sky.
  const { azimuth, elevation } = sunPosition(
    new Date("2026-08-26T06:42:00Z"),
    ARIEIRO.lat,
    ARIEIRO.lon
  );
  expect(azimuth).toBeGreaterThan(70);
  expect(azimuth).toBeLessThan(100);
  expect(Math.abs(elevation)).toBeLessThan(2);
});

test("the sun is in the south and high at local solar noon", () => {
  // Solar noon at 16.93W is about 13:08 UTC, plus the equation of time.
  const { azimuth, elevation } = sunPosition(
    new Date("2026-08-26T13:10:00Z"),
    ARIEIRO.lat,
    ARIEIRO.lon
  );
  expect(azimuth).toBeGreaterThan(170);
  expect(azimuth).toBeLessThan(190);
  // Late August at 32.7N: declination ~+10, so elevation ~67.
  expect(elevation).toBeGreaterThan(60);
  expect(elevation).toBeLessThan(72);
});

test("the sun is in the west in the evening", () => {
  const { azimuth } = sunPosition(
    new Date("2026-08-26T18:30:00Z"),
    ARIEIRO.lat,
    ARIEIRO.lon
  );
  expect(azimuth).toBeGreaterThan(255);
  expect(azimuth).toBeLessThan(295);
});

test("the sun is below the horizon in the middle of the night", () => {
  const { elevation } = sunPosition(
    new Date("2026-08-26T02:00:00Z"),
    ARIEIRO.lat,
    ARIEIRO.lon
  );
  expect(elevation).toBeLessThan(-15);
});

test("declination flips between solstices", () => {
  const june = sunPosition(
    new Date("2026-06-21T13:00:00Z"),
    ARIEIRO.lat,
    ARIEIRO.lon
  ).elevation;
  const december = sunPosition(
    new Date("2026-12-21T13:00:00Z"),
    ARIEIRO.lat,
    ARIEIRO.lon
  ).elevation;
  // 47 degrees of obliquity swing, minus a little for the hour not being
  // exactly solar noon on both dates.
  expect(june - december).toBeGreaterThan(40);
});

test("twilight elevations stay negative rather than clamping", () => {
  // Half an hour before sunrise: civil twilight, the hour this site is opened
  // in. The value has to stay a real negative angle, because the sky gradient
  // is driven by how far below the horizon the sun is.
  const { elevation } = sunPosition(
    new Date("2026-08-26T06:10:00Z"),
    ARIEIRO.lat,
    ARIEIRO.lon
  );
  expect(elevation).toBeLessThan(0);
  expect(elevation).toBeGreaterThan(-10);
});

test("the vector points east at sunrise and up at noon", () => {
  const sunrise = sunVector(
    sunPosition(new Date("2026-08-26T06:42:00Z"), ARIEIRO.lat, ARIEIRO.lon)
  );
  expect(sunrise[0]).toBeGreaterThan(0.9); // east
  expect(Math.abs(sunrise[2])).toBeLessThan(0.05); // on the horizon

  const noon = sunVector(
    sunPosition(new Date("2026-08-26T13:10:00Z"), ARIEIRO.lat, ARIEIRO.lon)
  );
  expect(noon[2]).toBeGreaterThan(0.85); // high
  expect(noon[1]).toBeLessThan(0); // and to the south
});

test("the vector is a unit vector", () => {
  const [x, y, z] = sunVector(
    sunPosition(new Date("2026-08-26T09:00:00Z"), ARIEIRO.lat, ARIEIRO.lon)
  );
  expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
});
