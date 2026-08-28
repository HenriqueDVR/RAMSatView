"use client";

import { useId, useState } from "react";
import { LAYER_ORDER, type LayerKey, type LayerState } from "@/lib/layers";
import type { Translate, TranslationKey } from "@/lib/i18n";

/** Explicit rather than a template literal, so a missing key fails to build. */
const LABEL: Record<LayerKey, TranslationKey> = {
  satellite: "layers.satellite",
  terrain: "layers.terrain",
  cloud: "layers.cloud",
  heatmap: "layers.heatmap",
  observed: "layers.observed",
};

/**
 * What each cloud layer actually is, in four words.
 *
 * Only the three cloud layers carry one, and they carry it because they are
 * the three that get mistaken for each other: two are the same model an hour
 * at a time and one is a satellite every three hours, and without saying so
 * the obvious reading of "the observed cloud does not match the cloud" is that
 * something is broken. Satellite imagery and terrain need no such note.
 */
const NOTE: Partial<Record<LayerKey, TranslationKey>> = {
  cloud: "layers.note.cloud",
  heatmap: "layers.note.heatmap",
  observed: "layers.note.observed",
};

/**
 * The layer switches, as a HUD panel over the map.
 *
 * Collapsible rather than always open: on a phone the map is the whole screen
 * and four permanent switches would eat a corner of it, and the person who
 * opened this at 4:30am wants the picture first and the controls second.
 *
 * It is also where the view options live - the things that are not layers but
 * are still "what is on my screen". There is exactly one so far, and it is
 * here rather than in a settings page because a settings page for one checkbox
 * is a place nobody would look.
 */
export default function LayerPanel({
  layers,
  onChange,
  t,
  showTime,
  onShowTimeChange,
}: {
  layers: LayerState;
  onChange: (key: LayerKey, value: boolean) => void;
  t: Translate;
  /** Whether the time scrubber is on screen. */
  showTime?: boolean;
  onShowTimeChange?: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className={open ? "layer-panel open" : "layer-panel"}>
      <button
        type="button"
        className="layer-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="layer-toggle-glyph" aria-hidden="true" />
        <span className="layer-toggle-label">{t("layers.title")}</span>
      </button>

      <div className="layer-list" id={panelId} hidden={!open}>
        {LAYER_ORDER.map((key) => {
          const note = NOTE[key];
          return (
            <label key={key} className="layer-row">
              <input
                type="checkbox"
                checked={layers[key]}
                onChange={(event) => onChange(key, event.target.checked)}
              />
              <span className="layer-label">
                <span className="layer-name">{t(LABEL[key])}</span>
                {/* Hidden from the accessibility tree on purpose: it is a
                    caption, and folded into the checkbox's name it would be
                    read out as part of the switch every time. */}
                {note && (
                  <span className="layer-note" aria-hidden="true">
                    {t(note)}
                  </span>
                )}
              </span>
              <span className="layer-state" aria-hidden="true">
                {layers[key] ? "ON" : "OFF"}
              </span>
            </label>
          );
        })}

        {onShowTimeChange && (
          <label className="layer-row layer-row-option">
            <input
              type="checkbox"
              checked={showTime ?? true}
              onChange={(event) => onShowTimeChange(event.target.checked)}
            />
            <span className="layer-label">
              <span className="layer-name">{t("time.show")}</span>
            </span>
            <span className="layer-state" aria-hidden="true">
              {showTime ?? true ? "ON" : "OFF"}
            </span>
          </label>
        )}
      </div>
    </div>
  );
}
