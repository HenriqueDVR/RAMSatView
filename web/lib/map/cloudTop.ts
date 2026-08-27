/**
 * Cloud-top altitude as a colour, and the legend's single source for it.
 *
 * The whole product is one question - is the deck below the summit or above it
 * - and the volumetric cloud answers it for the place you are looking at. This
 * answers it for the whole archipelago at once: the colour *is* the altitude
 * of the top of the cloud, so a morning where the deck sits at 1200m over the
 * north coast and 1900m over the south is one picture rather than eight cards.
 *
 * The ramp is keyed to the two summits that matter (Arieiro 1818m, Ruivo
 * 1862m) rather than being an evenly spaced gradient: the interesting question
 * is which side of ~1800m the top falls on, so the colour has to change fast
 * there and slowly everywhere else. Anything else looks prettier and says
 * less.
 */

export type Rgb = [number, number, number];

/** The summits the ramp is built around, in metres. */
export const ARIEIRO_M = 1818;
export const RUIVO_M = 1862;

/** Top of the altitude ladder the ingest publishes. */
export const RAMP_TOP_M = 3000;

const STOPS: { altitude: number; colour: Rgb }[] = [
  // Fog on the ground: every viewpoint is inside it.
  { altitude: 0, colour: [92, 60, 120] },
  { altitude: 600, colour: [58, 104, 178] },
  // The classic Madeira inversion: deck well below the levadas.
  { altitude: 1100, colour: [46, 158, 168] },
  { altitude: 1500, colour: [104, 190, 104] },
  // Just under the summits - the deck you drive up through and stand above.
  { altitude: 1800, colour: [232, 196, 84] },
  // Over them: the summit is in cloud and there is nothing to see.
  { altitude: 1950, colour: [226, 120, 62] },
  { altitude: 2400, colour: [198, 70, 74] },
  { altitude: RAMP_TOP_M, colour: [226, 226, 236] },
];

/** The colour for one cloud-top altitude. Clamped at both ends of the ladder. */
export function cloudTopColour(altitudeM: number): Rgb {
  if (altitudeM <= STOPS[0].altitude) return STOPS[0].colour;
  for (let index = 1; index < STOPS.length; index++) {
    const upper = STOPS[index];
    if (altitudeM > upper.altitude) continue;
    const lower = STOPS[index - 1];
    const t = (altitudeM - lower.altitude) / (upper.altitude - lower.altitude);
    return [
      Math.round(lower.colour[0] + (upper.colour[0] - lower.colour[0]) * t),
      Math.round(lower.colour[1] + (upper.colour[1] - lower.colour[1]) * t),
      Math.round(lower.colour[2] + (upper.colour[2] - lower.colour[2]) * t),
    ];
  }
  return STOPS[STOPS.length - 1].colour;
}

export function cloudTopCss(altitudeM: number): string {
  const [r, g, b] = cloudTopColour(altitudeM);
  return `rgb(${r}, ${g}, ${b})`;
}

/** The ramp as CSS stops, for the legend bar. Percentages of RAMP_TOP_M. */
export function rampGradient(): string {
  const stops = STOPS.map(
    ({ altitude, colour }) =>
      `rgb(${colour[0]}, ${colour[1]}, ${colour[2]}) ${(
        (altitude / RAMP_TOP_M) *
        100
      ).toFixed(1)}%`
  );
  return `linear-gradient(to top, ${stops.join(", ")})`;
}
