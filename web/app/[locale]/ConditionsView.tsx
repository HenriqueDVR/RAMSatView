"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import LayerPanel from "@/components/LayerPanel";
import TimeScrubber from "@/components/TimeScrubber";
import Sidebar from "@/components/Sidebar";
import CloudTopLegend from "@/components/CloudTopLegend";
import StatusBar from "@/components/StatusBar";
import {
  conditionsUrl,
  headlineScore,
  isViewpointDay,
  loadConditions,
  type Conditions,
  type SpotEntry,
} from "@/lib/conditions";
import {
  loadCloudGrid,
  timeIndexFor,
  type CloudGrid,
} from "@/lib/cloudGrid";
import {
  loadObservedCloud,
  type ObservedCloud,
} from "@/lib/observedCloud";
import { nearestIndex } from "@/lib/timeline";
import { translator, type Locale } from "@/lib/i18n";
import {
  DEFAULT_LAYERS,
  exclusiveLayers,
  type LayerKey,
  type LayerState,
} from "@/lib/layers";

// MapLibre touches window at import time and is by far the heaviest dependency
// on the page (~200KB gzipped), so it is client-only and lazily loaded. The
// list below it is fully usable before the map arrives.
const MapView = dynamic(() => import("@/components/Map"), {
  ssr: false,
  loading: () => <div className="map map-placeholder" />,
});

type Tab = "viewpoint" | "beach";

/**
 * The next sunrise the forecast covers, which is where the scrubber starts.
 *
 * The *next* one, not the first in the document: opening the page at nine in
 * the evening should show tomorrow morning, not this morning, which has
 * already happened and which nobody is deciding anything about. Falls back to
 * the earliest sunrise on file when the whole forecast is in the past, so the
 * control still lands somewhere meaningful rather than on hour zero.
 */
function nextSunrise(spots: SpotEntry[], now = new Date()): Date {
  const sunrises = spots
    .flatMap((spot) => spot.days)
    .filter(isViewpointDay)
    .map((day) => new Date(day.sunrise_utc))
    .sort((a, b) => a.getTime() - b.getTime());
  if (!sunrises.length) return now;
  return sunrises.find((time) => time.getTime() >= now.getTime()) ?? sunrises[0];
}

export default function ConditionsView({ locale }: { locale: Locale }) {
  const t = useMemo(() => translator(locale), [locale]);
  const [conditions, setConditions] = useState<Conditions | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("viewpoint");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS);
  const [grid, setGrid] = useState<CloudGrid | null>(null);
  const [observed, setObserved] = useState<ObservedCloud | null>(null);
  // Null until the volume arrives, then the sunrise the forecast is about -
  // not "now". Held as an index rather than a Date so the slider, the shader
  // and the lighting cannot drift a minute apart from each other.
  const [hour, setHour] = useState<number | null>(null);

  const setLayer = useCallback((key: LayerKey, value: boolean) => {
    // Through exclusiveLayers rather than a plain spread: the volumetric deck
    // and the cloud-top heatmap are the same field drawn two ways and only one
    // of them can be on.
    setLayers((current) => exclusiveLayers(current, key, value));
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadConditions()
      .then((result) => {
        if (cancelled) return;
        setConditions(result.conditions);
        setFromCache(result.fromCache);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The volume is a quarter of a megabyte and the page is fully usable
  // without it, so it is fetched after the document rather than with it, and a
  // failure only costs the shaped cloud.
  useEffect(() => {
    const header = conditions?.cloud_grid;
    if (!header) return;
    let cancelled = false;
    loadCloudGrid(header, conditionsUrl())
      .then((loaded) => {
        if (cancelled) return;
        setGrid(loaded);
        setHour(timeIndexFor(loaded, nextSunrise(conditions.spots)));
      })
      .catch(() => {
        // Deliberately silent: the deck falls back to the per-spot profile and
        // the user has lost nothing they can name.
        if (!cancelled) setGrid(null);
      });
    return () => {
      cancelled = true;
    };
  }, [conditions]);

  // A couple of kilobytes, so there is nothing to stage: it is fetched
  // alongside the volume and, like it, costs only its own layer when it fails.
  useEffect(() => {
    const header = conditions?.cloud_observed;
    if (!header) return;
    let cancelled = false;
    loadObservedCloud(header, conditionsUrl())
      .then((loaded) => {
        if (!cancelled) setObserved(loaded);
      })
      .catch(() => {
        if (!cancelled) setObserved(null);
      });
    return () => {
      cancelled = true;
    };
  }, [conditions]);

  const times = useMemo(
    () => grid?.timesMs.map((ms) => new Date(ms)) ?? [],
    [grid]
  );

  // Where the satellite's span falls on the forecast's track. The two axes
  // come from different sources and only overlap over the recent past, so this
  // is worked out by clock and not by index.
  const observedRange = useMemo(() => {
    if (!observed || !times.length) return undefined;
    const first = observed.timesMs[0];
    const last = observed.timesMs[observed.timesMs.length - 1];
    return {
      from: nearestIndex(times, new Date(first)),
      to: nearestIndex(times, new Date(last)),
    };
  }, [observed, times]);

  const visible: SpotEntry[] = useMemo(() => {
    if (!conditions) return [];
    return conditions.spots
      .filter((spot) => spot.type === tab)
      .sort((a, b) => {
        const left = headlineScore(a)?.value ?? -1;
        const right = headlineScore(b)?.value ?? -1;
        return right - left;
      });
  }, [conditions, tab]);

  if (error) {
    return (
      <p className="state" role="alert">
        {t("state.error")} <span className="muted">({error})</span>
      </p>
    );
  }

  if (!conditions) {
    return <p className="state">{t("state.loading")}</p>;
  }

  return (
    <>
      <StatusBar
        conditions={conditions}
        fromCache={fromCache}
        locale={locale}
        t={t}
      />

      <nav className="tabs" role="tablist">
        {(["viewpoint", "beach"] as Tab[]).map((value) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            className={tab === value ? "tab active" : "tab"}
            onClick={() => {
              setTab(value);
              setSelectedId(null);
            }}
          >
            {value === "viewpoint" ? t("nav.viewpoints") : t("nav.beaches")}
          </button>
        ))}
      </nav>

      {/*
        Outside the stage, not inside it. The stage is a fixed, full-viewport
        element on desktop, so anything within it is trapped under the cards
        that scroll over the map - and pinning the panel at a fixed offset
        instead put it under whatever the status bar happens to be showing
        that morning. In the flow, under the tabs, it lands below them however
        tall they are.
      */}
      <LayerPanel layers={layers} onChange={setLayer} t={t} />

      <div className="stage">
        <MapView
          spots={visible}
          locale={locale}
          selectedId={selectedId}
          onSelect={setSelectedId}
          layers={layers}
          grid={grid}
          observed={observed}
          timeIndex={hour ?? 0}
          time={hour === null ? undefined : times[hour]}
        />
      </div>

      {/*
        Outside the stage for the same reason the layer panel is: on desktop
        the stage is a fixed element with its own stacking context, and a
        control inside it stops taking clicks the moment the cards scroll up
        over the map.
      */}
      {hour !== null && (
        <TimeScrubber
          times={times}
          index={hour}
          onChange={setHour}
          locale={locale}
          t={t}
          sunriseIndex={nearestIndex(times, nextSunrise(conditions.spots))}
          observedRange={observedRange}
        />
      )}

      {layers.heatmap && grid !== null && <CloudTopLegend t={t} />}

      <Sidebar
        spots={visible}
        selectedId={selectedId}
        onSelect={setSelectedId}
        locale={locale}
        t={t}
      />

      <footer className="attribution">
        <p>
          <strong>{t("footer.data")}:</strong>{" "}
          {conditions.attribution.join(" · ")}
        </p>
      </footer>
    </>
  );
}
