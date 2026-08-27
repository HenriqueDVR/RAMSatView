"use client";

import {
  ARIEIRO_M,
  RAMP_TOP_M,
  RUIVO_M,
  rampGradient,
} from "@/lib/map/cloudTop";
import type { Translate } from "@/lib/i18n";

/**
 * What the heatmap's colours mean, with the two summits marked on the bar.
 *
 * The summit marks are the point of the whole legend. "Yellow is 1800 metres"
 * is a number; "yellow is where the cloud top crosses Pico do Arieiro" is the
 * answer someone drove up a mountain at 5am for, and it is the same mark the
 * vertical profile in the sidebar draws.
 */
export default function CloudTopLegend({ t }: { t: Translate }) {
  const marks = [
    { altitude: ARIEIRO_M, label: t("legend.arieiro") },
    { altitude: RUIVO_M, label: t("legend.ruivo") },
  ];

  return (
    <figure className="legend hud-surface">
      <figcaption>{t("legend.title")}</figcaption>
      <div className="legend-body">
        <div className="legend-bar" style={{ background: rampGradient() }}>
          {marks.map((mark) => (
            <span
              key={mark.altitude}
              className="legend-mark"
              style={{ bottom: `${(mark.altitude / RAMP_TOP_M) * 100}%` }}
            >
              <span className="legend-mark-label">{mark.label}</span>
            </span>
          ))}
        </div>
        <ol className="legend-scale">
          <li>{RAMP_TOP_M} m</li>
          <li>1500 m</li>
          <li>0 m</li>
        </ol>
      </div>
    </figure>
  );
}
