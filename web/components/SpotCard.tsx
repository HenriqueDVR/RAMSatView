"use client";

import ScoreDial from "@/components/ScoreDial";
import VerticalProfile from "@/components/VerticalProfile";
import {
  deckVerdict,
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
      id={`spot-${spot.id}`}
      aria-current={selected ? "true" : undefined}
    >
      <header className="card-head">
        <h3>
          {/*
            The selectable thing is the name, not the whole card. A card-wide
            click target cannot be reached from a keyboard without either
            faking a button with role and key handlers or nesting interactive
            elements inside it, and both are worse than one honest button.
          */}
          <button
            type="button"
            className="card-select"
            onClick={() => onSelect?.(spot.id)}
          >
            {name}
          </button>
        </h3>
        <p className="card-meta">
          {formatLocalDate(day.date, locale)}
          {spot.type === "viewpoint" && (
            <>
              <span aria-hidden="true"> &#183; </span>
              {spot.elevation_m.toFixed(0)} m
            </>
          )}
        </p>
      </header>

      {isViewpointDay(day) ? (
        <>
          {(() => {
            const verdict = deckVerdict(day, spot.elevation_m);
            return (
              <p className={`verdict verdict-${verdict}`}>
                {t(`verdict.${verdict}` as TranslationKey)}
              </p>
            );
          })()}

          <div className="card-readout">
            <ScoreDial
              score={day.cloud_sea}
              label={t("score.cloud_sea")}
              confidenceLabel={confidence}
            />
            <VerticalProfile
              profile={day.profile}
              summitM={spot.elevation_m}
              deckTopM={day.deck_top_m}
              summitLabel={t("label.summit")}
              caption={t("profile.caption", {
                deck: day.deck_top_m?.toFixed(0) ?? 0,
                summit: spot.elevation_m.toFixed(0),
              })}
              readout={(pct) => t("profile.at_summit", { pct })}
            />
          </div>

          <dl className="facts">
            <Fact
              label={t("score.visibility")}
              value={day.visibility.value.toFixed(0)}
            />
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
          <div className="card-readout">
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
