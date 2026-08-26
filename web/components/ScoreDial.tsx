"use client";

import type { Score } from "@/lib/conditions";

/**
 * A score with its confidence made visible rather than hidden.
 *
 * The dashed outer ring is the confidence: a full ring means the model resolves
 * this situation well, a sparse one means it is guessing. Showing a bare number
 * would imply a precision the vertical resolution of the forecast does not
 * support, which is exactly how a forecast product loses trust.
 */

const SIZE = 104;
const STROKE = 9;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function bandColor(value: number): string {
  if (value >= 70) return "var(--good)";
  if (value >= 40) return "var(--mixed)";
  return "var(--poor)";
}

export default function ScoreDial({
  score,
  label,
  confidenceLabel,
}: {
  score: Score;
  label: string;
  confidenceLabel: string;
}) {
  const clamped = Math.max(0, Math.min(100, score.value));
  const filled = (clamped / 100) * CIRCUMFERENCE;
  const color = bandColor(clamped);
  const confidencePct = Math.round(score.confidence * 100);

  return (
    <figure className="dial">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`${label}: ${clamped.toFixed(0)} out of 100, ${confidenceLabel} ${confidencePct}%`}
      >
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="var(--track)"
            strokeWidth={STROKE}
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={STROKE}
            strokeLinecap="round"
            className="dial-arc"
            strokeDasharray={`${filled} ${CIRCUMFERENCE - filled}`}
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS - STROKE}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeDasharray="3 5"
            opacity={0.25 + 0.75 * score.confidence}
          />
        </g>
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          className="dial-value"
          fill="var(--fg)"
        >
          {clamped.toFixed(0)}
        </text>
      </svg>
      <figcaption>
        <strong>{label}</strong>
        <span className="muted">
          {confidenceLabel} {confidencePct}%
        </span>
      </figcaption>
    </figure>
  );
}
