/**
 * The hours the scrubber can move through.
 *
 * The volume carries a week of archive and three days of forecast, which is
 * far too many hours to be a row of buttons, so the timeline is reduced here
 * to the two things the control needs: how to say an hour out loud, and where
 * the days break so the track can be marked.
 *
 * Everything is rendered in island time, never the viewer's. Someone planning
 * a sunrise from Lisbon or from London is planning it in Madeira's morning,
 * and a scrubber that said 06:00 while the sun came up at 07:42 would be
 * quietly lying about the one moment the product is about.
 */

export const ISLAND_TIME_ZONE = "Atlantic/Madeira";

export type TimelineMark = {
  /** Index into the hour list where this local day starts. */
  index: number;
  /** Short day label, e.g. "Wed 27". */
  label: string;
};

function formatter(locale: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: ISLAND_TIME_ZONE,
    ...options,
  });
}

/** "07:00" - the hour itself, which is what the eye lands on first. */
export function formatHour(time: Date, locale: string): string {
  return formatter(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(time);
}

/** "Wed 27 Aug" - enough to know which morning without reading a date. */
export function formatDay(time: Date, locale: string): string {
  return formatter(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(time);
}

/** The local calendar day, as a sortable key rather than a Date. */
function dayKey(time: Date, locale: string): string {
  return formatter(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(time);
}

/**
 * Where each local day begins, for the ticks under the track.
 *
 * Computed from the island's calendar rather than by dividing by 24: the
 * volume starts at whatever hour the ingest ran, and Madeira changes clocks
 * twice a year.
 */
export function dayMarks(times: Date[], locale: string): TimelineMark[] {
  const marks: TimelineMark[] = [];
  let previous: string | null = null;
  times.forEach((time, index) => {
    const key = dayKey(time, locale);
    if (key !== previous) {
      marks.push({ index, label: formatDay(time, locale) });
      previous = key;
    }
  });
  return marks;
}

/**
 * The hour nearest now, clamped into the timeline.
 *
 * Returns -1 for an empty timeline so a caller can tell "no timeline" from
 * "the first hour", which are different states for the control.
 */
export function nearestIndex(times: Date[], at: Date = new Date()): number {
  if (!times.length) return -1;
  const target = at.getTime();
  let best = 0;
  let bestGap = Infinity;
  for (let index = 0; index < times.length; index++) {
    const gap = Math.abs(times[index].getTime() - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = index;
    }
  }
  return best;
}

/**
 * How far an hour is from now, in whole hours: negative is archive.
 *
 * The scrubber says this beside the clock, because "in 14 hours" is the thing
 * being decided and "Thursday 06:00" is only how it is spelled.
 */
export function hoursFromNow(time: Date, now: Date = new Date()): number {
  return Math.round((time.getTime() - now.getTime()) / 3_600_000);
}

/**
 * The relative phrase for that offset, in the page's language.
 *
 * Uses Intl rather than a table of strings: it already knows that Portuguese
 * wants "há 3 horas" and English wants "3 hours ago", and getting that wrong
 * in one of the two languages is the sort of thing nobody notices for months.
 */
export function relativeHour(
  time: Date,
  locale: string,
  now: Date = new Date()
): string {
  const offset = hoursFromNow(time, now);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (offset === 0) return format.format(0, "hour");
  return format.format(offset, "hour");
}
