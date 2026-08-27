/**
 * Client for the conditions document produced by the Python ingest.
 *
 * The shape here mirrors ingest/build.py exactly. If you change one, change
 * both - SCHEMA_VERSION is the tripwire that catches a mismatch at runtime
 * rather than letting the UI render undefined values as blanks.
 */

import type { CloudGridHeader } from "@/lib/cloudGrid";
import type { ObservedCloudHeader } from "@/lib/observedCloud";
import { withBase } from "@/lib/basePath";

export const SCHEMA_VERSION = 2;

export type Score = {
  value: number;
  confidence: number;
  reasons: string[];
};

/**
 * Cloud fraction (0..1) at an altitude in metres, as [altitude, fraction].
 * Sampled every 100m from sea level; this is what the 3D deck and the
 * cross-section chart are drawn from.
 */
export type ProfilePoint = [number, number];

export type ViewpointDay = {
  date: string;
  sunrise_utc: string;
  visibility: Score;
  cloud_sea: Score;
  deck_base_m: number | null;
  deck_top_m: number | null;
  inversion_c: number;
  temperature_c: number;
  wind_kmh: number;
  precipitation_mm: number;
  profile: ProfilePoint[];
};

export type BeachDay = {
  date: string;
  score: Score;
  sst_c: number | null;
  wave_height_m: number | null;
  wave_period_s: number | null;
  wind_kmh: number | null;
  uv_index: number | null;
  warnings: Warning[];
};

export type Warning = {
  area: string;
  type: string | null;
  level: string;
  severity: number;
  text: string | null;
  start: string | null;
  end: string | null;
};

export type SpotEntry = {
  id: string;
  type: "viewpoint" | "beach";
  name: { pt: string; en: string };
  lat: number;
  lon: number;
  elevation_m: number;
  ipma_area: string;
  notes: string | null;
  days: (ViewpointDay | BeachDay)[];
};

export type Conditions = {
  schema_version: number;
  generated_at: string;
  stale_at: string;
  attribution: string[];
  official: {
    source: string | null;
    issued_at: string | null;
    warnings: Warning[];
    uv_index: Record<string, number>;
    fire_risk_available: boolean;
  };
  /**
   * Describes cloud-grid.bin, published beside this document. Null when the
   * gridded fetch failed, in which case the map shapes cloud from the per-spot
   * profiles instead - the behaviour it had before the volume existed.
   */
  cloud_grid: CloudGridHeader | null;
  /**
   * Describes cloud-observed.bin, the satellite cloud-top field. Null when the
   * mosaic could not be read, in which case the map simply has nothing
   * observed to show - there is no forecast substitute for a measurement, and
   * pretending otherwise is the one thing this layer must never do.
   */
  cloud_observed: ObservedCloudHeader | null;
  spots: SpotEntry[];
};

const CACHE_KEY = "conditions:last-good";

/** Where the hourly job publishes. Overridden per environment. */
export function conditionsUrl(): string {
  return process.env.NEXT_PUBLIC_CONDITIONS_URL || withBase("/conditions.json");
}

export function isStale(conditions: Conditions, now = new Date()): boolean {
  return new Date(conditions.stale_at).getTime() <= now.getTime();
}

export function ageMinutes(conditions: Conditions, now = new Date()): number {
  const generated = new Date(conditions.generated_at).getTime();
  return Math.max(0, Math.round((now.getTime() - generated) / 60000));
}

function readCache(): Conditions | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Conditions) : null;
  } catch {
    return null;
  }
}

function writeCache(conditions: Conditions): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(conditions));
  } catch {
    // Quota or private mode. Caching is a nicety, not a requirement.
  }
}

export type LoadResult = {
  conditions: Conditions;
  /** True when the network failed and this came from the offline cache. */
  fromCache: boolean;
};

/**
 * Fetch the current conditions, falling back to the last good copy.
 *
 * Offline support is not decoration here: there is no mobile signal on most
 * of the levadas or at the summits, and the forecast is most needed at 5am on
 * the drive up. A cached document is always returned with fromCache set so the
 * UI can say plainly how old it is.
 */
export async function loadConditions(): Promise<LoadResult> {
  try {
    const response = await fetch(conditionsUrl(), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const conditions = (await response.json()) as Conditions;

    if (conditions.schema_version !== SCHEMA_VERSION) {
      throw new Error(
        `schema ${conditions.schema_version}, expected ${SCHEMA_VERSION}`
      );
    }
    writeCache(conditions);
    return { conditions, fromCache: false };
  } catch (error) {
    const cached = readCache();
    if (cached) return { conditions: cached, fromCache: true };
    throw error;
  }
}

export function isViewpointDay(
  day: ViewpointDay | BeachDay
): day is ViewpointDay {
  return "cloud_sea" in day;
}

/** The score a spot leads with on the map and in list view. */
export function headlineScore(spot: SpotEntry): Score | null {
  const day = spot.days[0];
  if (!day) return null;
  return isViewpointDay(day) ? day.cloud_sea : day.score;
}

/** Cloud fraction at an arbitrary altitude, interpolated from the profile. */
export function cloudAt(profile: ProfilePoint[], altitudeM: number): number {
  if (!profile.length) return 0;
  if (altitudeM <= profile[0][0]) return profile[0][1];
  const last = profile[profile.length - 1];
  if (altitudeM >= last[0]) return last[1];
  for (let index = 1; index < profile.length; index++) {
    const [upperH, upperC] = profile[index];
    if (upperH < altitudeM) continue;
    const [lowerH, lowerC] = profile[index - 1];
    const span = upperH - lowerH;
    if (span <= 0) return upperC;
    return lowerC + ((altitudeM - lowerH) / span) * (upperC - lowerC);
  }
  return last[1];
}

/**
 * Matches DECK_THRESHOLD and SUMMIT_MARGIN_M in ingest/scoring/inversion.py.
 * The two must agree: the chart and the score describe the same morning, and
 * a viewer who sees "above the cloud" beside a score of 4 stops trusting both.
 */
const DECK_THRESHOLD = 0.35;
const SUMMIT_MARGIN_M = 150;

export type DeckVerdict = "above" | "inside" | "none";

/**
 * The one sentence the whole viewpoint card exists to answer: will you be
 * standing above the cloud, inside it, or is there no deck at all?
 */
export function deckVerdict(day: ViewpointDay, elevationM: number): DeckVerdict {
  if (cloudAt(day.profile, elevationM) >= DECK_THRESHOLD) return "inside";
  const top = day.deck_top_m;
  if (top !== null && top < elevationM - SUMMIT_MARGIN_M) return "above";
  return "none";
}

export function worstWarning(warnings: Warning[]): Warning | null {
  if (!warnings.length) return null;
  return [...warnings].sort((a, b) => b.severity - a.severity)[0];
}
