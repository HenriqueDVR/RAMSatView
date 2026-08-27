"""Beach and sea-condition scoring.

Deliberately simpler than the inversion model: sea state is a well-behaved
forecast problem and there is no exotic vertical structure to reason about.

The one hard rule is that IPMA gates the score. An active maritime warning caps
what any beach can score no matter how pleasant the numbers look, and the
warning text is surfaced verbatim. We report conditions and relay the official
position; we never issue a safety verdict of our own.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from ingest.scoring.inversion import Score
from ingest.scoring.reasons import reason
from ingest.sources.base import MarineForecast, MarineHour, OfficialStatus
from ingest.sources.ipma import FUNCHAL, PORTO_SANTO, active_warnings
from ingest.spots import Spot

# --- tunables -------------------------------------------------------------

IDEAL_SST_C = (21.0, 26.0)  # water temperature range most people call pleasant
COLD_SST_C = 16.0  # below this, swimming is unpleasant for most
CALM_WAVE_M = 0.5  # at or under this the sea reads as calm
ROUGH_WAVE_M = 2.0  # at or over this, effectively unswimmable
BRISK_WIND_KMH = 30.0
STRONG_WIND_KMH = 45.0
HIGH_UV = 8.0
DAYLIGHT_HOURS_UTC = (10, 17)  # the window people actually go to the beach

# Score ceilings imposed by an active IPMA warning, by severity.
WARNING_CEILING = {1: 40.0, 2: 15.0, 3: 0.0}

# Warning types that bear on being in the water specifically.
MARITIME_TYPES = ("Agita", "Vento")  # Agitacao Maritima, Vento (accent-insensitive)


@dataclass(frozen=True)
class BeachOutlook:
    spot_id: str
    day: date
    score: Score
    sst_c: float | None
    wave_height_m: float | None
    wave_period_s: float | None
    wind_kmh: float | None
    uv_index: float | None
    warnings: tuple[dict, ...]


def sst_comfort(sst_c: float | None) -> float:
    """0..1 comfort factor for water temperature.

    Madeira sits between roughly 18C in March and 25C in September, so this
    curve spends most of the year in its upper half. Never returns 0 - cold
    water is unpleasant, not disqualifying, and divers in wetsuits do not care.
    """
    if sst_c is None:
        return 0.5  # unknown: stay neutral rather than inventing a penalty
    low, high = IDEAL_SST_C
    if low <= sst_c <= high:
        return 1.0
    if sst_c > high:
        return max(0.85, 1.0 - (sst_c - high) * 0.03)
    if sst_c <= COLD_SST_C:
        return 0.25
    return 0.25 + 0.75 * (sst_c - COLD_SST_C) / (low - COLD_SST_C)


def sea_state(
    wave_height_m: float | None, swell_height_m: float | None, sensitivity: float
) -> float:
    """0..1 factor for how swimmable the sea is.

    Uses the larger of significant wave height and swell height - a long-period
    swell of the same nominal height is more disruptive at the shoreline than
    local windchop.
    """
    heights = [h for h in (wave_height_m, swell_height_m) if h is not None]
    if not heights:
        return 0.5
    effective = max(heights) * sensitivity
    if effective <= CALM_WAVE_M:
        return 1.0
    if effective >= ROUGH_WAVE_M:
        return 0.0
    return 1.0 - (effective - CALM_WAVE_M) / (ROUGH_WAVE_M - CALM_WAVE_M)


def wind_factor(wind_kmh: float | None) -> float:
    if wind_kmh is None:
        return 1.0
    if wind_kmh <= BRISK_WIND_KMH:
        return 1.0
    if wind_kmh >= STRONG_WIND_KMH:
        return 0.4
    span = STRONG_WIND_KMH - BRISK_WIND_KMH
    return 1.0 - 0.6 * (wind_kmh - BRISK_WIND_KMH) / span


def _daylight(hours: tuple[MarineHour, ...], day: date) -> list[MarineHour]:
    start, end = DAYLIGHT_HOURS_UTC
    return [h for h in hours if h.time.date() == day and start <= h.time.hour <= end]


def _mean(values: list[float | None]) -> float | None:
    present = [v for v in values if v is not None]
    return sum(present) / len(present) if present else None


def uv_for(spot: Spot, status: OfficialStatus | None) -> float | None:
    """Daily peak UV from the nearest IPMA point location."""
    if status is None or not status.uv_index:
        return None
    key = PORTO_SANTO if spot.ipma_area == "MPS" else FUNCHAL
    return status.uv_index.get(key)


def score_beach(
    spot: Spot,
    marine: MarineForecast,
    day: date,
    wind_kmh: float | None = None,
    status: OfficialStatus | None = None,
) -> BeachOutlook | None:
    """Score one beach for one day across the daylight window."""
    hours = _daylight(marine.hours, day)
    if not hours:
        return None

    sst = _mean([h.sst_c for h in hours])
    wave = _mean([h.wave_height_m for h in hours])
    swell = _mean([h.swell_height_m for h in hours])
    period = _mean([h.wave_period_s for h in hours])
    uv = uv_for(spot, status)

    comfort = sst_comfort(sst)
    state = sea_state(wave, swell, spot.swell_sensitivity)
    wind = wind_factor(wind_kmh)
    value = 100.0 * comfort * state * wind

    # Reasons carry judgement, never a restatement of numbers the UI already
    # shows in its own facts row. Repeating them means the same value gets
    # rounded twice, in two languages, and disagrees with itself on screen.
    reasons: list[dict] = []
    if state <= 0.2:
        reasons.append(reason("beach.rough"))
    elif state >= 0.9:
        reasons.append(reason("beach.calm"))
    else:
        reasons.append(reason("beach.moderate_swell"))
    if comfort <= 0.5:
        reasons.append(reason("beach.cold_water"))
    if wind_kmh is not None and wind_kmh >= BRISK_WIND_KMH:
        reasons.append(reason("beach.chilly_wind"))
    if uv is not None and uv >= HIGH_UV:
        reasons.append(reason("beach.high_uv"))

    # --- official gate. IPMA outranks the model, always.
    noon = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc) + timedelta(
        hours=13
    )
    live = active_warnings(status, spot.ipma_area, noon) if status else []
    relevant = [
        w
        for w in live
        if any(token in (w.get("type") or "") for token in MARITIME_TYPES)
    ]
    if relevant:
        worst = relevant[0]
        ceiling = WARNING_CEILING.get(worst["severity"], 0.0)
        value = min(value, ceiling)
        reasons.insert(
            0,
            reason("beach.warning", level=worst["level"], type=worst["type"]),
        )

    # Confidence has two inputs: how much of the marine data actually resolved
    # for this grid cell, and how far out the forecast is. It is deliberately
    # capped below 1.0 - a three-day sea forecast is never a certainty, and
    # presenting one as 100% is the fastest way to lose a user's trust the
    # first time it is wrong.
    known = sum(1 for v in (sst, wave, swell) if v is not None)
    completeness = 0.4 + 0.2 * known
    lead_days = max(0, (day - marine.issued_at.date()).days)
    confidence = round(min(0.9, completeness) * max(0.5, 1.0 - 0.12 * lead_days), 2)

    return BeachOutlook(
        spot_id=spot.id,
        day=day,
        score=Score(round(max(0.0, min(100.0, value)), 1), confidence, reasons),
        sst_c=round(sst, 1) if sst is not None else None,
        wave_height_m=round(wave, 2) if wave is not None else None,
        wave_period_s=round(period, 1) if period is not None else None,
        wind_kmh=round(wind_kmh, 1) if wind_kmh is not None else None,
        uv_index=uv,
        warnings=tuple(live),
    )
