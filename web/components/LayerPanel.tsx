"use client";

import { useId, useState } from "react";
import { LAYER_ORDER, type LayerKey, type LayerState } from "@/lib/layers";
import type { Translate, TranslationKey } from "@/lib/i18n";

/** Explicit rather than a template literal, so a missing key fails to build. */
const LABEL: Record<LayerKey, TranslationKey> = {
  satellite: "layers.satellite",
  terrain: "layers.terrain",
  sea: "layers.sea",
  cloud: "layers.cloud",
};

/**
 * The layer switches, as a HUD panel over the map.
 *
 * Collapsible rather than always open: on a phone the map is the whole screen
 * and four permanent switches would eat a corner of it, and the person who
 * opened this at 4:30am wants the picture first and the controls second.
 */
export default function LayerPanel({
  layers,
  onChange,
  t,
}: {
  layers: LayerState;
  onChange: (key: LayerKey, value: boolean) => void;
  t: Translate;
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
        {LAYER_ORDER.map((key) => (
          <label key={key} className="layer-row">
            <input
              type="checkbox"
              checked={layers[key]}
              onChange={(event) => onChange(key, event.target.checked)}
            />
            <span className="layer-name">{t(LABEL[key])}</span>
            <span className="layer-state" aria-hidden="true">
              {layers[key] ? "ON" : "OFF"}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
