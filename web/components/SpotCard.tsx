"use client";

import ScoreDial from "@/components/ScoreDial";
import {
  isViewpointDay,
  worstWarning,
  type SpotEntry,
} from "@/lib/conditions";
import {
  formatLocalDate,
  formatLocalTime,
  type Locale,
  type TranslationKey,
} from "@/lib/i18n";

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export default function SpotCard({
  spot,
  locale,
  t,
  selected,
  onSelect,
}: {
  spot: SpotEntry;
  locale: Locale;
  t: T;
  selected?: boolean;
  onSelect?: (id: string) => void;
}) {
  const day = spot.days[0];
  if (!day) return null;

  const name = locale === "pt" ? spot.name.pt : spot.name.en;
  const confidence = t("score.confidence");

  return (
    <article
      className={selected ? "card selected" : "card"}
      onClick={() => onSelect?.(spot.id)}
      id={`spot-${spot.id}`}
    >
      <header>
        <h3>{name}</h3>
        <span className="muted">
          {formatLocalDate(day.date, locale)}
          {spot.type === "viewpoint" &&
            ` · ${spot.elevation_m.toFixed(0)} m`}
        </span>
      </header>

      {isViewpointDay(day) ? (
        <>
          <div className="dials">
            <ScoreDial
              score={day.cloud_sea}
              label={t("score.cloud_sea")}
              confidenceLabel={confidence}
            />
            <ScoreDial
              score={day.visibility}
              label={t("score.visibility")}
              confidenceLabel={confidence}
            />
          </div>
          <dl className="facts">
            <Fact
              label={t("label.sunrise")}
              value={formatLocalTime(day.sunrise_utc, locale)}
            />
            <Fact
              label={t("label.temperature")}
              value={`${day.temperature_c.toFixed(0)} °C`}
            />
            <Fact
              label={t("label.wind")}
              value={`${day.wind_kmh.toFixed(0)} km/h`}
            />
            {day.deck_top_m !== null && (
              <Fact
                label={t("label.deck")}
                value={`${day.deck_top_m.toFixed(0)} m`}
              />
            )}
          </dl>
          <ul className="reasons">
            {[...day.cloud_sea.reasons, ...day.visibility.reasons].map(
              (reason) => (
                <li key={reason}>{reason}</li>
              )
            )}
          </ul>
        </>
      ) : (
        <>
          <div className="dials">
            <ScoreDial
              score={day.score}
              label={t("score.beach")}
              confidenceLabel={confidence}
            />
          </div>
          <dl className="facts">
            {day.sst_c !== null && (
              <Fact label={t("label.water")} value={`${day.sst_c} °C`} />
            )}
            {day.wave_height_m !== null && (
              <Fact
                label={t("label.waves")}
                value={`${day.wave_height_m.toFixed(1)} m`}
              />
            )}
            {day.wind_kmh !== null && (
              <Fact
                label={t("label.wind")}
                value={`${day.wind_kmh.toFixed(0)} km/h`}
              />
            )}
            {day.uv_index !== null && (
              <Fact label={t("label.uv")} value={day.uv_index.toFixed(1)} />
            )}
          </dl>
          {worstWarning(day.warnings) && (
            <p className="card-warning" role="alert">
              {t("warning.official")}
            </p>
          )}
          <ul className="reasons">
            {day.score.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}
