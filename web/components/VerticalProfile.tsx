"use client";

import { cloudAt, type ProfilePoint } from "@/lib/conditions";

/**
 * The forecast as a cross-section: altitude up the side, cloud across.
 *
 * This is the most explanatory thing on the page. "Sea of clouds 48" is a
 * number a user has to take on faith; a band of cloud sitting below a marked
 * summit line is an argument they can check against the sky when they get
 * there. It is also the only place the confidence in the vertical is legible:
 * a deck edge drawn in the gap between two pressure levels looks soft, because
 * it is.
 *
 * Pure SVG. A chart library would be several times the weight of everything
 * this draws.
 */

const WIDTH = 148;
const HEIGHT = 168;
const PAD_LEFT = 30;
const PAD_RIGHT = 10;
const PAD_TOP = 10;
const PAD_BOTTOM = 18;

/**
 * Fixed rather than fitted to each spot's data, so the same altitude sits at
 * the same height on every card and the cards can be compared at a glance.
 */
const CEILING_M = 3000;
const TICKS_M = [0, 1000, 2000, 3000];

const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;

function y(altitudeM: number): number {
  const clamped = Math.max(0, Math.min(CEILING_M, altitudeM));
  return PAD_TOP + (1 - clamped / CEILING_M) * PLOT_HEIGHT;
}

function x(fraction: number): number {
  return PAD_LEFT + Math.max(0, Math.min(1, fraction)) * PLOT_WIDTH;
}

export default function VerticalProfile({
  profile,
  summitM,
  deckTopM,
  summitLabel,
  caption,
  readout,
}: {
  profile: ProfilePoint[];
  summitM: number;
  deckTopM: number | null;
  summitLabel: string;
  caption: string;
  /** Rendered under the chart: the one number the chart is there to justify. */
  readout: (summitCloudPct: number) => string;
}) {
  if (!profile.length) return null;

  const points = profile.filter(([altitude]) => altitude <= CEILING_M);
  const band = [
    `${PAD_LEFT},${y(points[0][0])}`,
    ...points.map(([altitude, fraction]) => `${x(fraction)},${y(altitude)}`),
    `${PAD_LEFT},${y(points[points.length - 1][0])}`,
  ].join(" ");

  const summitY = y(summitM);
  const summitCloud = Math.round(cloudAt(profile, summitM) * 100);

  return (
    <figure className="profile">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="profile-svg"
        role="img"
        aria-label={caption}
      >
        <defs>
          <linearGradient id="cloud-band" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--cloud)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--cloud)" stopOpacity="0.85" />
          </linearGradient>
        </defs>

        {TICKS_M.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={y(tick)}
              y2={y(tick)}
              className="profile-grid"
            />
            <text x={PAD_LEFT - 6} y={y(tick) + 3} className="profile-tick">
              {tick / 1000}k
            </text>
          </g>
        ))}

        <polygon points={band} fill="url(#cloud-band)" />

        {deckTopM !== null && deckTopM <= CEILING_M && (
          <line
            x1={PAD_LEFT}
            x2={WIDTH - PAD_RIGHT}
            y1={y(deckTopM)}
            y2={y(deckTopM)}
            className="profile-deck"
          />
        )}

        {/* The summit is the reference the whole chart is read against, so it
            is drawn last and heaviest. */}
        <line
          x1={PAD_LEFT - 4}
          x2={WIDTH - PAD_RIGHT}
          y1={summitY}
          y2={summitY}
          className="profile-summit"
        />
        <text
          x={WIDTH - PAD_RIGHT}
          y={Math.max(PAD_TOP + 8, summitY - 5)}
          textAnchor="end"
          className="profile-summit-label"
        >
          {summitLabel} {summitM.toFixed(0)}m
        </text>
      </svg>
      <figcaption className="muted">{readout(summitCloud)}</figcaption>
    </figure>
  );
}
