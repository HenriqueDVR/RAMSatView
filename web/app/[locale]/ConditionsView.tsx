"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import SpotCard from "@/components/SpotCard";
import StatusBar from "@/components/StatusBar";
import {
  headlineScore,
  loadConditions,
  type Conditions,
  type SpotEntry,
} from "@/lib/conditions";
import { translator, type Locale } from "@/lib/i18n";

// MapLibre touches window at import time and is by far the heaviest dependency
// on the page (~200KB gzipped), so it is client-only and lazily loaded. The
// list below it is fully usable before the map arrives.
const MapView = dynamic(() => import("@/components/Map"), {
  ssr: false,
  loading: () => <div className="map map-placeholder" />,
});

type Tab = "viewpoint" | "beach";

export default function ConditionsView({ locale }: { locale: Locale }) {
  const t = useMemo(() => translator(locale), [locale]);
  const [conditions, setConditions] = useState<Conditions | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("viewpoint");
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

      <MapView
        spots={visible}
        locale={locale}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />

      <section className="cards">
        {visible.map((spot) => (
          <SpotCard
            key={spot.id}
            spot={spot}
            locale={locale}
            t={t}
            selected={spot.id === selectedId}
            onSelect={setSelectedId}
          />
        ))}
      </section>

      <footer className="attribution">
        <p>
          <strong>{t("footer.data")}:</strong>{" "}
          {conditions.attribution.join(" · ")}
        </p>
      </footer>
    </>
  );
}
