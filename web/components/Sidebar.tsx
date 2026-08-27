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
 * The list of spots and the one that is selected, beside the map.
 *
 * This replaces the grid of cards the page used to end in. Two reasons it is a
 * sidebar and not a grid: a grid of eight equal cards says every spot is
 * equally the answer, when the whole product exists to say *which* one is; and
 * on desktop the grid pushed the map - the thing that actually shows the
 * answer - into a band at the top of the screen. Here the map keeps the
 * viewport and the numbers sit next to it, for the spot in question.
 *
 * On a phone this is a bottom sheet over the map rather than a column beside
 * it, in one of three states. The markup is the same either way - only the
 * handle is phone-only, and CSS hides it on desktop - because a second
 * component for the same numbers is a second place for them to go wrong.
 *
 * Why a sheet and not the stacked document it used to be: on a phone the map
 * was a band at the top and the list ran off the bottom, so reading a spot
 * meant scrolling the map out of view - and the map is the answer. Now the map
 * owns the screen at every width, and tapping a pin brings its numbers up over
 * it.
 */

/** How much of the sheet is showing. Phone-only; desktop ignores it. */
export type SheetState = "peek" | "detail" | "full";

/** Tapping the handle cycles forward, wrapping at the top. */
const NEXT: Record<SheetState, SheetState> = {
  peek: "detail",
  detail: "full",
  full: "peek",
};

/** The states in order, so a drag can step along them. */
const ORDER: SheetState[] = ["peek", "detail", "full"];

/**
 * How far a thumb has to travel before it counts as a drag rather than a tap.
 *
 * Below this the gesture falls through to the click handler, which cycles. A
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
  const listRef = useRef<HTMLOListElement | null>(null);

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

  // Selecting a pin on the map has to move the list too, or the selected row
  // is somewhere off-screen in a column of eight.
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const row = listRef.current.querySelector(`#row-${CSS.escape(selectedId)}`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  if (!spots.length) return null;

  const shownScore = shown ? headlineScore(shown) : null;

  const step = (from: SheetState, by: number): SheetState => {
    const index = ORDER.indexOf(from) + by;
    return ORDER[Math.max(0, Math.min(ORDER.length - 1, index))];
  };

  return (
    <aside
      className="sidebar"
      aria-label={t("sidebar.title")}
      // The state the CSS reads. It is an attribute rather than a class so the
      // three positions stay one axis - a stray "sheet-full" left on alongside
      // "sheet-peek" is a bug that cannot be written this way.
      data-sheet={sheet}
    >
      {/* Phone-only; `display: none` on desktop, where the sidebar is simply a
          column and has no states. Labelled with what it will do rather than
          what it is, because "handle" tells a screen reader nothing. */}
      <button
        type="button"
        className="sheet-handle"
        aria-expanded={sheet !== "peek"}
        aria-controls="sheet-body"
        // Up opens, down closes, one step per drag. A tap - anything under the
        // threshold - falls through to onClick and cycles instead, which is
        // also the whole keyboard story: the handle is a button and Enter
        // works on it.
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
          const next = step(from.sheet, travelled > 0 ? 1 : -1);
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
          onSheetChange(NEXT[sheet]);
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

      <div className="sheet-body" id="sheet-body">
        <ol className="spot-list" ref={listRef}>
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

        {shown && (
          <SpotDetail
            spot={shown}
            locale={locale}
            t={t}
            hour={hourFor(shown)}
          />
        )}

        {legal}
      </div>
    </aside>
  );
}
