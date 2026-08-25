/**
 * Client for the conditions document produced by the Python ingest.
 *
 * The shape here mirrors ingest/build.py exactly. If you change one, change
 * both - SCHEMA_VERSION is the tripwire that catches a mismatch at runtime
 * rather than letting the UI render undefined values as blanks.
 */

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
  spots: SpotEntry[];
};

const CACHE_KEY = "conditions:last-good";

/** Where the hourly job publishes. Overridden per environment. */
function conditionsUrl(): string {
  return process.env.NEXT_PUBLIC_CONDITIONS_URL || "/conditions.json";
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

export function worstWarning(warnings: Warning[]): Warning | null {
  if (!warnings.length) return null;
  return [...warnings].sort((a, b) => b.severity - a.severity)[0];
}
