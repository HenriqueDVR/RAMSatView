"use client";

import { useId, useMemo } from "react";
import type { Translate } from "@/lib/i18n";
import {
  dayMarks,
  formatDay,
  formatHour,
  nearestIndex,
  relativeHour,
} from "@/lib/timeline";

/**
 * The time control: a week back, three days forward, one hour per step.
 *
 * A range input rather than a custom track. It is a single value on a
 * continuous scale, which is exactly what the native control is, and it
 * arrives with keyboard steps, page steps, touch dragging and screen-reader
 * announcement already correct - none of which a div would have.
 *
 * The slider alone is not enough to *aim* with, and that is not a styling
 * problem. Ten days at one hour a step is about 250 positions; on a 360px
 * phone that is well under two pixels per hour, and a thumb covers eight of
 * them. So the track is for travelling and the two step buttons beside it are
 * for arriving, and the two instants anyone actually wants - now, and the
 * sunrise the forecast is about - are buttons rather than pixels to hunt for.
 *
 * The label above it is deliberately large: on a phone at 5am, held at arm's
 * length in the car, the hour is the only thing that has to be legible.
 */
export default function TimeScrubber({
  times,
  index,
  onChange,
  locale,
  t,
  sunriseIndex,
  observedRange,
  onHide,
  now = new Date(),
}: {
  /** Every hour in the volume, in order. */
  times: Date[];
  index: number;
  onChange: (index: number) => void;
  locale: string;
  t: Translate;
  /** The morning the forecast is about, marked on the track. */
  sunriseIndex?: number;
  /**
   * First and last hour the satellite covers, as indices into `times`. Drawn
   * as a band so it is obvious why the observed layer stops - it ran out of
   * observation, rather than breaking.
   */
  observedRange?: { from: number; to: number };
  /**
   * Put the control away. Someone who only ever wants the sunrise has no use
   * for a ten-day slider across the bottom of the map, and on a phone it is
   * the single largest thing standing between them and the picture.
   */
  onHide?: () => void;
  now?: Date;
}) {
  const sliderId = useId();
  const marks = useMemo(() => dayMarks(times, locale), [times, locale]);
  const nowIndex = useMemo(() => nearestIndex(times, now), [times, now]);

  if (times.length < 2) return null;

  const current = times[Math.min(Math.max(index, 0), times.length - 1)];
  const last = times.length - 1;
  const percent = (value: number) => (value / last) * 100;
  const step = (by: number) =>
    onChange(Math.max(0, Math.min(last, index + by)));

  return (
    <div className="scrubber">
      <div className="scrubber-readout">
        <span className="scrubber-hour">{formatHour(current, locale)}</span>
        <span className="scrubber-day">{formatDay(current, locale)}</span>
        <span className="scrubber-offset">{relativeHour(current, locale, now)}</span>
        {sunriseIndex !== undefined && sunriseIndex >= 0 && (
          <button
            type="button"
            className="scrubber-jump"
            title={t("time.to_sunrise")}
            onClick={() => onChange(sunriseIndex)}
            disabled={index === sunriseIndex}
          >
            {t("time.sunrise")}
          </button>
        )}
        <button
          type="button"
          className="scrubber-jump scrubber-now"
          onClick={() => onChange(nowIndex)}
          disabled={index === nowIndex}
        >
          {t("time.now")}
        </button>
        {onHide && (
          <button
            type="button"
            className="scrubber-hide"
            aria-label={t("time.hide")}
            title={t("time.hide")}
            onClick={onHide}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>

      <div className="scrubber-controls">
        {/* The aiming device. A hit target of its own, at the size a cold
            thumb needs, rather than a pixel and a half of slider track. */}
        <button
          type="button"
          className="scrubber-step"
          aria-label={t("time.back")}
          title={t("time.back")}
          onClick={() => step(-1)}
          disabled={index <= 0}
        >
          <span aria-hidden="true">‹</span>
        </button>

        <div className="scrubber-track">
          {/*
            The ticks are decoration over the input, not part of it: pointer
            events stay with the slider so a thumb dragged across a day boundary
            is not interrupted by a label.
          */}
          <div className="scrubber-marks" aria-hidden="true">
            {observedRange && observedRange.to >= observedRange.from && (
              <span
                className="scrubber-observed"
                style={{
                  left: `${percent(observedRange.from)}%`,
                  width: `${percent(observedRange.to) - percent(observedRange.from)}%`,
                }}
                title={t("time.observed")}
              />
            )}
            {marks.map((mark) => (
              <span
                key={mark.index}
                className="scrubber-mark"
                style={{ left: `${percent(mark.index)}%` }}
              >
                <span className="scrubber-mark-label">{mark.label}</span>
              </span>
            ))}
            {nowIndex >= 0 && (
              <span
                className="scrubber-mark scrubber-mark-now"
                style={{ left: `${percent(nowIndex)}%` }}
              />
            )}
            {sunriseIndex !== undefined && sunriseIndex >= 0 && (
              <span
                className="scrubber-mark scrubber-mark-sunrise"
                style={{ left: `${percent(sunriseIndex)}%` }}
                title={t("time.sunrise")}
              />
            )}
          </div>

          <input
            id={sliderId}
            className="scrubber-input"
            type="range"
            min={0}
            max={last}
            step={1}
            value={index}
            aria-label={t("time.scrub")}
            // The thumb position says which hour; the value on its own would be
            // read out as "43", which means nothing.
            aria-valuetext={`${formatDay(current, locale)} ${formatHour(current, locale)}`}
            onChange={(event) => onChange(Number(event.target.value))}
          />
        </div>

        <button
          type="button"
          className="scrubber-step"
          aria-label={t("time.forward")}
          title={t("time.forward")}
          onClick={() => step(1)}
          disabled={index >= last}
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>
    </div>
  );
}
