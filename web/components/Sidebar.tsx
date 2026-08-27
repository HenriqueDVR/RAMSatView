"use client";

import { useEffect, useRef } from "react";
import SpotDetail from "@/components/SpotDetail";
import {
  deckVerdict,
  headlineScore,
  isViewpointDay,
  type SpotEntry,
} from "@/lib/conditions";
import type { Locale, Translate, TranslationKey } from "@/lib/i18n";

/**
 * The list of spots and the one that is selected, beside the map.
 *
 * This replaces the grid of cards the page used to end in. Two reasons it is a
 * sidebar and not a grid: a grid of eight equal cards says every spot is
 * equally the answer, when the whole product exists to say *which* one is; and
 * on desktop the grid pushed the map - the thing that actually shows the
 * answer - into a band at the top of the screen. Here the map keeps the
 * viewport and the numbers sit next to it, for the spot in question.
 *
 * On a phone this is a sheet under the map rather than a column beside it. The
 * layout is CSS; the markup is the same either way.
 */
function scoreClass(value: number | null): string {
  if (value === null) return "none";
  if (value >= 70) return "good";
  if (value >= 40) return "fair";
  return "poor";
}

export default function Sidebar({
  spots,
  selectedId,
  onSelect,
  locale,
  t,
}: {
  spots: SpotEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  locale: Locale;
  t: Translate;
}) {
  // Nothing selected means the map is showing everything, so the detail shows
  // the best spot on the list - which is the one the sort has already put
  // first, and the one somebody opening this at 5am is asking about.
  const shown = spots.find((spot) => spot.id === selectedId) ?? spots[0] ?? null;
  const listRef = useRef<HTMLOListElement | null>(null);

  // Selecting a pin on the map has to move the list too, or the selected row
  // is somewhere off-screen in a column of eight.
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const row = listRef.current.querySelector(`#row-${CSS.escape(selectedId)}`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  if (!spots.length) return null;

  return (
    <aside className="sidebar" aria-label={t("sidebar.title")}>
      <ol className="spot-list" ref={listRef}>
        {spots.map((spot) => {
          const score = headlineScore(spot);
          const day = spot.days[0];
          const verdict =
            spot.type === "viewpoint" && day && isViewpointDay(day)
              ? deckVerdict(day, spot.elevation_m)
              : null;
          const selected = spot.id === shown?.id;
          return (
            <li key={spot.id}>
              <button
                type="button"
                id={`row-${spot.id}`}
                className={selected ? "spot-row selected" : "spot-row"}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(spot.id)}
              >
                <span
                  className={`spot-score score-${scoreClass(
                    score ? score.value : null
                  )}`}
                  aria-hidden="true"
                >
                  {score ? Math.round(score.value) : "?"}
                </span>
                <span className="spot-label">
                  <span className="spot-name">
                    {locale === "pt" ? spot.name.pt : spot.name.en}
                  </span>
                  <span className="spot-sub">
                    {verdict
                      ? t(`verdict.${verdict}` as TranslationKey)
                      : `${spot.elevation_m.toFixed(0)} m`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {shown && <SpotDetail spot={shown} locale={locale} t={t} />}
    </aside>
  );
}
