"use client";

import {
  ARIEIRO_M,
  RAMP_TOP_M,
  RUIVO_M,
  rampGradient,
} from "@/lib/map/cloudTop";
import type { Translate } from "@/lib/i18n";

/**
 * What the coloured field's colours mean, with the two summits marked on the
 * bar.
 *
 * The summit marks are the point of the whole legend. "Yellow is 1800 metres"
 * is a number; "yellow is where the cloud top crosses Pico do Arieiro" is the
 * answer someone drove up a mountain at 5am for, and it is the same mark the
 * vertical profile in the sidebar draws.
 *
 * Two layers are drawn from this ramp - the forecast heatmap and the observed
 * satellite field - and the legend has to say which of them is on screen. It
 * used to say neither: the caption read "Cloud top" whatever was showing, and
 * because the observed layer is on by default the bar was permanently up
 * beside a white volumetric deck whose colours it does not explain.
 */
export default function CloudTopLegend({
  t,
  variant,
  scan,
}: {
  t: Translate;
  /** Which layer this is the key to. */
  variant: "forecast" | "observed";
  /**
   * The satellite scan the observed field is drawn from: when it was taken,
   * and how far that is from the hour the rest of the page is describing.
   *
   * This is the answer to "why does the observed cloud not match the
   * forecast cloud". The mosaic is published every three hours and the map
   * shows the nearest scan within ninety minutes, so at 04:00 the measured
   * field can be a picture of 03:00 - or of 05:00, since nearest goes both
   * ways. Said out loud it is a caveat; left unsaid it is a bug report.
   *
   * `gapHours` is signed: negative when the scan predates the hour on screen.
   */
  scan?: { time: string; gapHours: number };
}) {
  const marks = [
    { altitude: ARIEIRO_M, label: t("legend.arieiro") },
    { altitude: RUIVO_M, label: t("legend.ruivo") },
  ];

  return (
    <figure className={`legend hud-surface legend-${variant}`}>
      <figcaption>
        {t(
          variant === "observed"
            ? "legend.observed_title"
            : "legend.forecast_title",
        )}
      </figcaption>
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
      {scan && (
        <p className="legend-scan">
          {t("legend.observed_scan", { time: scan.time })}
          <span className="muted">
            {" · "}
            {Math.abs(scan.gapHours) < 1
              ? t("legend.observed_same")
              : t(
                  scan.gapHours < 0
                    ? "legend.observed_gap_before"
                    : "legend.observed_gap_after",
                  { n: Math.round(Math.abs(scan.gapHours)) },
                )}
          </span>
        </p>
      )}
    </figure>
  );
}
