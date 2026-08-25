"use client";

import {
  ageMinutes,
  isStale,
  worstWarning,
  type Conditions,
} from "@/lib/conditions";
import type { Locale, TranslationKey } from "@/lib/i18n";

/**
 * Freshness and official warnings, above everything else on the page.
 *
 * Two rules this component exists to enforce:
 *
 *  1. Never present data as current when it is not. Past stale_at the badge
 *     goes red and says so, rather than letting a green score imply freshness.
 *  2. IPMA warnings are shown verbatim, before any of our own numbers, with a
 *     link to the official source. We relay the official position; we do not
 *     restate or soften it.
 */

const LEVEL_CLASS: Record<string, string> = {
  yellow: "warn-yellow",
  orange: "warn-orange",
  red: "warn-red",
};

export default function StatusBar({
  conditions,
  fromCache,
  locale,
  t,
}: {
  conditions: Conditions;
  fromCache: boolean;
  locale: Locale;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}) {
  const stale = isStale(conditions);
  const age = ageMinutes(conditions);
  const warning = worstWarning(conditions.official.warnings);

  return (
    <div className="statusbar">
      <p className={stale ? "freshness stale" : "freshness"}>
        {stale ? (
          <strong>{t("state.stale")}</strong>
        ) : (
          <span>{t("state.updated", { n: age })}</span>
        )}
        {fromCache && <span className="muted"> · {t("state.offline")}</span>}
      </p>

      {warning && (
        <aside
          className={`official ${LEVEL_CLASS[warning.level] ?? "warn-yellow"}`}
          role="alert"
        >
          <strong>
            {t("warning.official")}
            {warning.type ? ` · ${warning.type}` : ""}
          </strong>
          {warning.text && <p>{warning.text}</p>}
          <a
            href="https://www.ipma.pt/pt/otempo/prev-avisos/"
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("warning.source")}
          </a>
        </aside>
      )}
    </div>
  );
}
