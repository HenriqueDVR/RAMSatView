"use client";

import {
  ageMinutes,
  isStale,
  worstWarning,
  type Conditions,
} from "@/lib/conditions";
import {
  formatLocalDate,
  formatLocalTime,
  type Locale,
  type TranslationKey,
} from "@/lib/i18n";

/**
 * Freshness and official warnings, above everything else on the page.
 *
 * Two rules this component exists to enforce:
 *
 *  1. Never present data as current when it is not. Past stale_at the line
 *     says so, rather than letting a green score imply freshness.
 *  2. IPMA warnings are shown verbatim, before any of our own numbers, with a
 *     link to the official source. We relay the official position; we do not
 *     restate or soften it.
 *
 * Rule 1 used to be enforced with a single red "Data out of date" and nothing
 * else - no timestamp, no age. On a deployment whose hourly job has stopped
 * that is a permanent red badge that says the same thing on the first morning
 * as on the fortieth, and a warning that never changes is a warning nobody
 * reads. The instant the forecast was made and how long ago that was are now
 * always on screen; staleness colours that line rather than replacing it.
 */

const LEVEL_CLASS: Record<string, string> = {
  yellow: "warn-yellow",
  orange: "warn-orange",
  red: "warn-red",
};

/**
 * How far past its own use-by a document has to be before the wording stops
 * being "old" and starts being "abandoned".
 *
 * Six hours late is a job that missed a run. A day late is a pipeline that is
 * not running at all, and the two do not deserve the same colour.
 */
const DEAD_MINUTES = 24 * 60;

/** The age, in whichever unit does not read as a silly number of minutes. */
function ageLabel(
  minutes: number,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string {
  if (minutes < 90) return t("state.age_min", { n: minutes });
  if (minutes < DEAD_MINUTES) return t("state.age_h", { n: Math.round(minutes / 60) });
  return t("state.age_d", { n: Math.round(minutes / 1440) });
}

export default function StatusBar({
  conditions,
  fromCache,
  locale,
  t,
}: {
  conditions: Conditions;
  fromCache: boolean;
  locale: Locale;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}) {
  const stale = isStale(conditions);
  const age = ageMinutes(conditions);
  const dead = age >= DEAD_MINUTES;
  const warning = worstWarning(conditions.official.warnings);

  // Date as well as time. "Forecast from 23:15" on a document three days old
  // is worse than saying nothing: it reads as tonight.
  const stamp = `${formatLocalDate(conditions.generated_at, locale)} ${formatLocalTime(
    conditions.generated_at,
    locale,
  )}`;

  return (
    <div className="statusbar">
      <p
        className={
          dead ? "freshness dead" : stale ? "freshness stale" : "freshness"
        }
      >
        <span className="freshness-stamp">
          {t("state.generated", { time: stamp })}
        </span>
        <span className="freshness-age">{ageLabel(age, t)}</span>
        {stale && (
          <span className="freshness-note">{t("state.stale_note")}</span>
        )}
        {fromCache && (
          <span className="freshness-note">{t("state.offline")}</span>
        )}
      </p>

      {warning && (
        <aside
          className={`official ${LEVEL_CLASS[warning.level] ?? "warn-yellow"}`}
          role="alert"
        >
          <strong>
            {t("warning.official")}
            {warning.type ? ` · ${warning.type}` : ""}
          </strong>
          {warning.text && <p>{warning.text}</p>}
          <a
            href="https://www.ipma.pt/pt/otempo/prev-avisos/"
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("warning.source")}
          </a>
        </aside>
      )}
    </div>
  );
}
