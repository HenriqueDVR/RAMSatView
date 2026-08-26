/**
 * Where the sun is.
 *
 * Everything that lights the scene reads from here: the sky gradient, the
 * hillshade illumination, the cloud's shadow direction, the glitter path on
 * the water. Before this they each held their own constant pointing roughly
 * east, which is why the scene looked the same at 04:00 and at noon and why
 * nothing in it agreed with anything else.
 *
 * The algorithm is NOAA's solar position calculation - the same spreadsheet
 * formulation used by their solar calculator. It is good to about a minute of
 * arc, which is far beyond what a lighting model needs, and it is a few dozen
 * lines with no dependencies.
 *
 * Angles in and out are degrees, because that is what MapLibre's hillshade
 * takes and what anyone checking this against an almanac will be reading.
 */

export type SunPosition = {
  /** Degrees clockwise from due north: 90 is east, 180 is south. */
  azimuth: number;
  /**
   * Degrees above the horizon, refraction-corrected. Negative before sunrise -
   * and the twilight range, roughly -6 to 0, is exactly when this site is
   * used, so it must stay meaningful rather than clamping at zero.
   */
  elevation: number;
};

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Days since the J2000 epoch, as a Julian day number. */
function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

/**
 * Atmospheric refraction, in degrees.
 *
 * Not a nicety at this latitude and this hour: refraction lifts the sun by
 * about half a degree at the horizon, which is more than its own diameter. It
 * is the difference between the sun having risen and not.
 */
function refraction(elevation: number): number {
  if (elevation > 85) return 0;
  const tan = Math.tan(elevation * RAD);
  if (elevation > 5) {
    return (58.1 / tan - 0.07 / tan ** 3 + 0.000086 / tan ** 5) / 3600;
  }
  if (elevation > -0.575) {
    return (
      (1735 +
        elevation *
          (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)))) /
      3600
    );
  }
  return -20.772 / tan / 3600;
}

export function sunPosition(date: Date, lat: number, lon: number): SunPosition {
  const century = (julianDay(date) - 2_451_545) / 36_525;

  const meanLongitude =
    (280.46646 + century * (36000.76983 + century * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + century * (35999.05029 - 0.0001537 * century);
  const eccentricity =
    0.016708634 - century * (0.000042037 + 0.0000001267 * century);

  const centre =
    Math.sin(meanAnomaly * RAD) *
      (1.914602 - century * (0.004817 + 0.000014 * century)) +
    Math.sin(2 * meanAnomaly * RAD) * (0.019993 - 0.000101 * century) +
    Math.sin(3 * meanAnomaly * RAD) * 0.000289;

  const trueLongitude = meanLongitude + centre;
  const apparentLongitude =
    trueLongitude -
    0.00569 -
    0.00478 * Math.sin((125.04 - 1934.136 * century) * RAD);

  const meanObliquity =
    23 +
    (26 +
      (21.448 -
        century * (46.815 + century * (0.00059 - century * 0.001813))) /
        60) /
      60;
  const obliquity =
    meanObliquity + 0.00256 * Math.cos((125.04 - 1934.136 * century) * RAD);

  const declination =
    Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparentLongitude * RAD)) *
    DEG;

  // Equation of time: the difference between clock noon and solar noon, which
  // reaches a quarter of an hour and would put sunrise visibly in the wrong
  // place if it were skipped.
  const varY = Math.tan((obliquity / 2) * RAD) ** 2;
  const equationOfTime =
    4 *
    DEG *
    (varY * Math.sin(2 * meanLongitude * RAD) -
      2 * eccentricity * Math.sin(meanAnomaly * RAD) +
      4 *
        eccentricity *
        varY *
        Math.sin(meanAnomaly * RAD) *
        Math.cos(2 * meanLongitude * RAD) -
      0.5 * varY * varY * Math.sin(4 * meanLongitude * RAD) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly * RAD));

  const minutesUtc =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60_000;
  // Everything is computed against UTC, so the longitude correction is the
  // whole of the local-time story - no time zone is involved anywhere.
  const trueSolarMinutes = (minutesUtc + equationOfTime + 4 * lon + 1440) % 1440;
  const hourAngle =
    trueSolarMinutes / 4 < 0
      ? trueSolarMinutes / 4 + 180
      : trueSolarMinutes / 4 - 180;

  const zenith =
    Math.acos(
      Math.sin(lat * RAD) * Math.sin(declination * RAD) +
        Math.cos(lat * RAD) *
          Math.cos(declination * RAD) *
          Math.cos(hourAngle * RAD)
    ) * DEG;

  const elevation = 90 - zenith;

  let azimuth: number;
  const denominator = Math.cos(lat * RAD) * Math.sin(zenith * RAD);
  if (Math.abs(denominator) < 1e-9) {
    // Sun directly overhead or the observer at a pole: azimuth is undefined
    // rather than wrong, and south is the least surprising answer.
    azimuth = 180;
  } else {
    const cosAzimuth =
      (Math.sin(lat * RAD) * Math.cos(zenith * RAD) - Math.sin(declination * RAD)) /
      denominator;
    const clamped = Math.min(1, Math.max(-1, cosAzimuth));
    azimuth = Math.acos(clamped) * DEG;
    azimuth = hourAngle > 0 ? (azimuth + 180) % 360 : (540 - azimuth) % 360;
  }

  return { azimuth, elevation: elevation + refraction(elevation) };
}

/**
 * The sun as a unit vector in the map's own frame: +x east, +y north, +z up.
 *
 * This is the form the shaders want. They work in mercator offsets, where x
 * grows east and y grows *south*, so the caller flips y - doing it here would
 * bake a rendering detail into a piece of astronomy.
 */
export function sunVector(position: SunPosition): [number, number, number] {
  const azimuth = position.azimuth * RAD;
  const elevation = position.elevation * RAD;
  const horizontal = Math.cos(elevation);
  return [
    horizontal * Math.sin(azimuth),
    horizontal * Math.cos(azimuth),
    Math.sin(elevation),
  ];
}
