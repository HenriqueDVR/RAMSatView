"use client";

import {
  deckVerdict,
  headlineScore,
  hourVerdict,
  isViewpointDay,
  type SpotEntry,
} from "@/lib/conditions";
import type { Locale, Translate, TranslationKey } from "@/lib/i18n";
import type { SpotHour } from "@/lib/spotHours";

/**
 * The headline for one spot, anchored to its own pin.
 *
 * Clicking a pin already moved the sidebar, and on a wide screen the sidebar
 * is a column on the far left: the answer arrived somewhere other than where
 * the question was asked. This puts the short version back on the pin - which
 * spot, what score, and the one sentence that decides the morning - so the
 * eye never has to leave the map to find out whether the deck is under the
 * summit.
 *
 * Deliberately three lines and no more. The dial, the vertical profile and the
 * beach readout stay in the sidebar; a callout that carried them would cover
 * the very terrain it is describing. It answers "what about this one", and the
 * sidebar answers "and here is everything about it".
 *
 * Only ever rendered for the selected spot. Eight of these at the default
 * camera would overlap each other and the pins underneath them - Arieiro and
 * Ruivo are four kilometres apart on a map showing fifty-seven.
 */
function scoreClass(value: number | null): string {
  if (value === null) return "none";
  if (value >= 70) return "good";
  if (value >= 40) return "fair";
  return "poor";
}

export default function SpotCallout({
  spot,
  locale,
  t,
  hour = null,
}: {
  spot: SpotEntry;
  locale: Locale;
  t: Translate;
  /** The spot's own numbers at the hour the scrubber is on. The callout sits
   *  directly on the map, so a verdict here that disagreed with the deck drawn
   *  behind it would be the contradiction at its most visible. */
  hour?: SpotHour | null;
}) {
  const score = headlineScore(spot);
  const day = spot.days[0];
  const verdict =
    spot.type === "viewpoint" && day && isViewpointDay(day)
      ? ((hour && hourVerdict(hour, spot.elevation_m, spot.fog_is_the_view)) ??
        deckVerdict(day, spot.elevation_m, spot.fog_is_the_view))
      : null;

  return (
    // aria-hidden, and not because it does not matter: every word here is
    // already on the pin's own label and in the sidebar detail, and a screen
    // reader that met all three would hear the same spot announced three times
    // for one tap.
    <div className="callout" aria-hidden="true">
      <span
        className={`callout-score score-${scoreClass(score?.value ?? null)}`}
      >
        {score ? Math.round(score.value) : "?"}
      </span>
      <span className="callout-text">
        <span className="callout-name">
          {locale === "pt" ? spot.name.pt : spot.name.en}
        </span>
        <span className="callout-sub">
          {verdict
            ? t(`verdict.${verdict}` as TranslationKey)
            : `${spot.elevation_m.toFixed(0)} m`}
        </span>
      </span>
    </div>
  );
}
