"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import SpotDetail from "@/components/SpotDetail";
import {
  deckVerdict,
  headlineScore,
  hourVerdict,
  isViewpointDay,
  type SpotEntry,
} from "@/lib/conditions";
import type { Locale, Translate, TranslationKey } from "@/lib/i18n";
import { spotHourAt, type SpotHours } from "@/lib/spotHours";

/**
 * The spot that is selected, and the ranking it came from, beside the map.
 *
 * This replaces the grid of cards the page used to end in. Two reasons it is a
 * sidebar and not a grid: a grid of eight equal cards says every spot is
 * equally the answer, when the whole product exists to say *which* one is; and
 * on desktop the grid pushed the map - the thing that actually shows the
 * answer - into a band at the top of the screen. Here the map keeps the
 * viewport and the numbers sit next to it, for the spot in question.
 *
 * The order inside it is the detail first and the ranking under it, and that
 * ordering is the whole point rather than a layout preference. It was the
 * other way round: tapping a pin selected a spot whose numbers were then eight
 * rows further down the panel, so the answer to "tell me about this one"
 * arrived below the fold of the thing you asked it from. The list is a way of
 * choosing; the detail is what was chosen, and what was chosen goes first.
 *
 * On a phone this is a bottom sheet over the map rather than a column beside
 * it. The markup is the same either way - only the handle is phone-only, and
 * CSS hides it on desktop - because a second component for the same numbers is
 * a second place for them to go wrong.
 *
 * Why a sheet and not the stacked document it used to be: on a phone the map
 * was a band at the top and the list ran off the bottom, so reading a spot
 * meant scrolling the map out of view - and the map is the answer. Now the map
 * owns the screen at every width, and tapping a pin brings its numbers up over
 * it.
 */

/**
 * How much of the sheet is showing. Phone-only; desktop ignores it.
 *
 * Two states, not three. It was peek -> detail -> full, cycling, and a control
 * whose one tap does a different thing each time is a control you have to
 * remember rather than read: there was no way back a step, and no way to tell
 * from the handle which of the three you were in. Open or closed is a thing
 * a thumb can guess at 5am.
 */
export type SheetState = "peek" | "open";

/**
 * How far a thumb has to travel before it counts as a drag rather than a tap.
 *
 * Below this the gesture falls through to the click handler, which toggles. A
 * tap on a phone always carries a few pixels of movement, and treating those
 * as a drag makes the handle feel like it is ignoring taps.
 */
const DRAG_THRESHOLD_PX = 24;

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
  sheet,
  onSheetChange,
  legal,
  hours = null,
  atMs,
}: {
  spots: SpotEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  locale: Locale;
  t: Translate;
  sheet: SheetState;
  onSheetChange: (state: SheetState) => void;
  /** The published hourly series, and the instant the scrubber is on. Together
   *  they make every row, the summary and the detail describe the same hour
   *  the map is drawing. */
  hours?: SpotHours | null;
  atMs?: number;
  /** The data credit and the safety notice. They ride inside the sheet on a
   *  phone because nothing outside it is reachable once the map is the page;
   *  the tile licence itself is on MapLibre's own attribution control, which
   *  is always on screen. */
  legal?: ReactNode;
}) {
  // Nothing selected means the map is showing everything, so the detail shows
  // the best spot on the list - which is the one the sort has already put
  // first, and the one somebody opening this at 5am is asking about.
  const shown =
    spots.find((spot) => spot.id === selectedId) ?? spots[0] ?? null;
  // Whichever element does the scrolling at this width: the column itself on
  // desktop, the sheet body on a phone. Both are held because the CSS decides
  // which one has the overflow, and this component is not told which.
  const panelRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Looked up per spot rather than inside a row: the whole list is redrawn
  // while the scrubber is dragged.
  const hourFor = useCallback(
    (spot: SpotEntry) =>
      hours && atMs !== undefined ? spotHourAt(hours, spot.id, atMs) : null,
    [hours, atMs],
  );

  // Where the thumb went down, and whether it has travelled far enough to be a
  // drag. Refs rather than state: this changes on every pointer event and
  // nothing about it belongs in a render.
  const dragFrom = useRef<{ y: number; sheet: SheetState } | null>(null);
  const dragged = useRef(false);

  // Choosing a spot scrolls the panel back to the top, because the top is
  // where that spot's numbers are.
  //
  // This used to scroll the *selected row* into view, which was the right move
  // when the detail sat under the whole list and the row was the only thing
  // worth looking at. With the detail first it is exactly backwards: someone
  // who scrolled down to the ranking, picked something and got left staring at
  // the ranking has been shown nothing, and the answer is off the top of the
  // panel behind them.
  useEffect(() => {
    if (!selectedId) return;
    for (const element of [panelRef.current, bodyRef.current]) {
      element?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [selectedId]);

  if (!spots.length) return null;

  const shownScore = shown ? headlineScore(shown) : null;

  return (
    <aside
      ref={panelRef}
      className="sidebar"
      aria-label={t("sidebar.title")}
      // The state the CSS reads. It is an attribute rather than a class so the
      // two positions stay one axis - a stray "sheet-open" left on alongside
      // "sheet-peek" is a bug that cannot be written this way.
      data-sheet={sheet}
    >
      {/* Phone-only; `display: none` on desktop, where the sidebar is simply a
          column and has no states. Labelled with what it will do rather than
          what it is, because "handle" tells a screen reader nothing. */}
      <button
        type="button"
        className="sheet-handle"
        aria-expanded={sheet === "open"}
        aria-controls="sheet-body"
        aria-label={t(sheet === "open" ? "sheet.close" : "sheet.open")}
        // Up opens, down closes. A tap - anything under the threshold - falls
        // through to onClick and toggles instead, which is also the whole
        // keyboard story: the handle is a button and Enter works on it.
        onPointerDown={(event) => {
          dragFrom.current = { y: event.clientY, sheet };
          dragged.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const from = dragFrom.current;
          if (!from) return;
          const travelled = from.y - event.clientY;
          if (Math.abs(travelled) < DRAG_THRESHOLD_PX) return;
          dragged.current = true;
          const next: SheetState = travelled > 0 ? "open" : "peek";
          if (next !== sheet) onSheetChange(next);
        }}
        onPointerUp={() => {
          dragFrom.current = null;
        }}
        onPointerCancel={() => {
          dragFrom.current = null;
          dragged.current = false;
        }}
        onClick={() => {
          // The drag already moved it; a click is fired at the end of one too.
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          onSheetChange(sheet === "open" ? "peek" : "open");
        }}
      >
        <span className="sheet-grip" aria-hidden="true" />
        <span className="sheet-summary">
          {shown ? (
            <>
              <span
                className={`spot-score score-${scoreClass(
                  shownScore ? shownScore.value : null,
                )}`}
                aria-hidden="true"
              >
                {shownScore ? Math.round(shownScore.value) : "?"}
              </span>
              <span className="spot-name">
                {locale === "pt" ? shown.name.pt : shown.name.en}
              </span>
            </>
          ) : (
            <span className="spot-name">{t("sidebar.title")}</span>
          )}
        </span>
      </button>

      <div className="sheet-body" id="sheet-body" ref={bodyRef}>
        {/* The answer, first. */}
        {shown && (
          <SpotDetail
            spot={shown}
            locale={locale}
            t={t}
            hour={hourFor(shown)}
          />
        )}

        {/* And the ranking it came out of, under it, behind a heading that
            says what it is. Without the heading the two blocks read as one
            long panel and the numbers at the top look like the first row's. */}
        <section className="spot-picker">
          <h2 className="panel-heading">
            {t("sidebar.title")}
            <span className="muted">{t("sidebar.count", { n: spots.length })}</span>
          </h2>

          <ol className="spot-list">
            {spots.map((spot) => {
              const score = headlineScore(spot);
              const day = spot.days[0];
              const at = hourFor(spot);
              const verdict =
                spot.type === "viewpoint" && day && isViewpointDay(day)
                  ? ((at &&
                      hourVerdict(at, spot.elevation_m, spot.fog_is_the_view)) ??
                    deckVerdict(day, spot.elevation_m, spot.fog_is_the_view))
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
                        score ? score.value : null,
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
        </section>

        {/* Folded away rather than removed. It is a licence condition and a
            safety notice, so it cannot go; it is also six lines of small print
            that used to sit at the end of every scroll, between the reader and
            nothing at all. Closed by default, one tap from open. */}
        {legal && (
          <details className="legal">
            <summary>{t("sidebar.legal")}</summary>
            {legal}
          </details>
        )}
      </div>
    </aside>
  );
}
