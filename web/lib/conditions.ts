/**
 * Client for the conditions document produced by the Python ingest.
 *
 * The shape here mirrors ingest/build.py exactly. If you change one, change
 * both - SCHEMA_VERSION is the tripwire that catches a mismatch at runtime
 * rather than letting the UI render undefined values as blanks.
 */

import type { CloudGridHeader } from "@/lib/cloudGrid";
import type { ObservedCloudHeader } from "@/lib/observedCloud";
import type { SpotHoursHeader } from "@/lib/spotHours";
import { withBase } from "@/lib/basePath";

// 4: reasons are codes and their numbers rather than English sentences, so the
// Portuguese half of the site is no longer explained in English.
export const SCHEMA_VERSION = 4;

/**
 * Why a score came out the way it did: what the ingest decided, and the numbers
 * it decided from.
 *
 * A code rather than a sentence, because the site is bilingual and the ingest
 * has no business knowing which language anybody reads. See
 * ingest/scoring/reasons.py.
 */
export type Reason = {
  code: string;
  vars?: Record<string, string | number>;
};

export type Score = {
  value: number;
  confidence: number;
  reasons: Reason[];
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
  /** Will the sky actually do something, as opposed to merely being visible.
   *  Absent from documents published before this existed. */
  colour?: Score;
  /** Saharan dust over the sunrise window. Absent from documents published
   *  before the air-quality source existed, and absent when that fetch failed
   *  - which is not the same as clear air, and is shown as nothing at all. */
  calima?: {
    severity: CalimaSeverity;
    aod: number | null;
    dust_ug_m3: number | null;
  };
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
  /** True where cloud at the viewpoint is the attraction rather than the thing
   *  that ruins it. Fanal, and so far only Fanal. */
  fog_is_the_view?: boolean;
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
  /** Per-spot hourly scalars, in a blob beside the document. Null when the
   *  ingest published none, which leaves the readouts on the day summary. */
  spot_hours: SpotHoursHeader | null;
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
    if (!raw) return null;
    const cached = JSON.parse(raw) as Conditions;

    // The same tripwire the network path gets, and it was missing here. A
    // schema mismatch on the fetch throws, the catch below reaches for the
    // cache, and an unchecked cache handed back a document from the previous
    // schema to be rendered as though it were current - which is precisely
    // what the version check exists to prevent. It showed up as reasons
    // rendering as empty lines after they became codes.
    if (cached.schema_version !== SCHEMA_VERSION) {
      window.localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return cached;
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
        `schema ${conditions.schema_version}, expected ${SCHEMA_VERSION}`,
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
  day: ViewpointDay | BeachDay,
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

export type DeckVerdict = "above" | "inside" | "none" | "fog" | "no_fog";

export type CalimaSeverity = "none" | "slight" | "noticeable" | "heavy";

/**
 * Where the dust stops being worth a word and starts being the story.
 *
 * These mirror ingest/scoring/calima.py, which is where the reasoning lives.
 * The point of showing it at all: nothing in the cloud profile sees dust, so a
 * calima morning scores as perfectly clear and hands you an orange horizon.
 */
export function calimaSeverity(aod: number | null): CalimaSeverity {
  if (aod === null) return "none";
  if (aod >= 0.7) return "heavy";
  if (aod >= 0.4) return "noticeable";
  if (aod >= 0.25) return "slight";
  return "none";
}

/**
 * The one sentence the whole viewpoint card exists to answer: will you be
 * standing above the cloud, inside it, or is there no deck at all?
 */
export function deckVerdict(
  day: ViewpointDay,
  elevationM: number,
  fogIsTheView = false,
): DeckVerdict {
  // At Fanal the same sky gets the opposite words. The laurel forest in mist
  // is what people drive there for, so "inside the cloud" is the good answer
  // and reporting it as a summit swallowed by weather told them to stay home
  // on the one morning worth going.
  if (fogIsTheView) {
    return cloudAt(day.profile, elevationM) >= DECK_THRESHOLD
      ? "fog"
      : "no_fog";
  }
  if (cloudAt(day.profile, elevationM) >= DECK_THRESHOLD) return "inside";
  const top = day.deck_top_m;
  if (top !== null && top < elevationM - SUMMIT_MARGIN_M) return "above";
  return "none";
}

/**
 * The same verdict, from one published hour rather than from the day summary.
 *
 * Deliberately the same two questions in the same order as `deckVerdict`, and
 * against the same thresholds: if these two ever disagreed about a morning,
 * the map and the panel beside it would disagree in front of the user, which
 * is the exact failure the hourly series exists to close.
 *
 * Null when the hour published nothing usable - a hole in the series is not a
 * clear sky, and the caller falls back to the day.
 */
export function hourVerdict(
  hour: { cloudAtSummit: number | null; deckTopM: number | null },
  elevationM: number,
  fogIsTheView = false,
): DeckVerdict | null {
  if (hour.cloudAtSummit === null && hour.deckTopM === null) return null;
  if (fogIsTheView) {
    if (hour.cloudAtSummit === null) return null;
    return hour.cloudAtSummit >= DECK_THRESHOLD ? "fog" : "no_fog";
  }
  if (hour.cloudAtSummit !== null && hour.cloudAtSummit >= DECK_THRESHOLD) {
    return "inside";
  }
  if (hour.deckTopM !== null && hour.deckTopM < elevationM - SUMMIT_MARGIN_M) {
    return "above";
  }
  return "none";
}

export function worstWarning(warnings: Warning[]): Warning | null {
  if (!warnings.length) return null;
  return [...warnings].sort((a, b) => b.severity - a.severity)[0];
}
