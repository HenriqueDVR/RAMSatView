"""Sea-of-clouds and sunrise-visibility scoring for viewpoints.

The physical setup this models is the Madeira trade-wind inversion: a stable
layer traps moisture below roughly 1200-1700m, producing a solid stratocumulus
deck. Peaks above that deck (Arieiro 1818m, Ruivo 1862m) sit in clear air and
look out over an unbroken sea of clouds. Below the inversion you are simply in
fog.

Two questions are scored separately because they are genuinely different:

  visibility  - will you see the sunrise at all?
  cloud_sea   - will there be a cloud deck below you?

A clear, cloudless morning scores high on visibility and low on cloud_sea. That
is a good sunrise but not a sea of clouds, and conflating the two into one
number is what makes existing forecasts useless for this.
"""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from ingest.sources.base import AtmosphereForecast, AtmosphereHour, LevelSample
from ingest.spots import Spot

# --- tunables -------------------------------------------------------------
# These are first-guess values. They are expected to move once ground-truth
# reports exist; keep them named and in one place so calibration is a diff.

DECK_THRESHOLD = 0.35  # cloud fraction that counts as "deck", not haze
SUMMIT_MARGIN_M = 150  # dead zone above/below the peak (model cannot resolve finer)
DECK_SEARCH_FLOOR_M = 200  # ignore anything below this when hunting for a deck
BLOCKING_CEILING_M = 2500  # cloud this far above the peak still blocks the sun
PROFILE_STEP_M = 50  # vertical sampling resolution for the interpolated profile
INVERSION_BAND_M = (600, 2600)  # where the trade-wind inversion lives
STRONG_WIND_KMH = 50.0  # above this it is unpleasant regardless of the view
SUNRISE_WINDOW_H = 1  # evaluate this many hours either side of sunrise


@dataclass(frozen=True)
class Score:
    value: float  # 0..100
    confidence: float  # 0..1
    reasons: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SunriseOutlook:
    spot_id: str
    day: date
    sunrise_utc: datetime
    visibility: Score
    cloud_sea: Score
    deck_base_m: float | None
    deck_top_m: float | None
    inversion_strength_c: float
    temperature_c: float
    wind_kmh: float
    precipitation_mm: float


# --- profile helpers ------------------------------------------------------


def cloud_at(levels: tuple[LevelSample, ...], altitude_m: float) -> float:
    """Cloud fraction at an arbitrary altitude, linearly interpolated.

    Levels must be sorted ascending by height. Outside the profile we clamp to
    the nearest level rather than extrapolating - extrapolated cloud is fiction.
    """
    if not levels:
        return 0.0
    heights = [level.height_m for level in levels]
    if altitude_m <= heights[0]:
        return levels[0].cloud_cover
    if altitude_m >= heights[-1]:
        return levels[-1].cloud_cover

    index = bisect_left(heights, altitude_m)
    lower, upper = levels[index - 1], levels[index]
    span = upper.height_m - lower.height_m
    if span <= 0:
        return upper.cloud_cover
    weight = (altitude_m - lower.height_m) / span
    return lower.cloud_cover + weight * (upper.cloud_cover - lower.cloud_cover)


def temperature_at(levels: tuple[LevelSample, ...], altitude_m: float) -> float:
    """Temperature at an arbitrary altitude, linearly interpolated.

    Used to report the actual summit temperature. It is routinely 10C colder up
    there than in Funchal, which is the single most common way visitors get
    caught out at 6am.
    """
    if not levels:
        return 0.0
    heights = [level.height_m for level in levels]
    if altitude_m <= heights[0]:
        return levels[0].temperature_c
    if altitude_m >= heights[-1]:
        return levels[-1].temperature_c

    index = bisect_left(heights, altitude_m)
    lower, upper = levels[index - 1], levels[index]
    span = upper.height_m - lower.height_m
    if span <= 0:
        return upper.temperature_c
    weight = (altitude_m - lower.height_m) / span
    return lower.temperature_c + weight * (upper.temperature_c - lower.temperature_c)


def band_max(levels: tuple[LevelSample, ...], low_m: float, high_m: float) -> float:
    """Peak cloud fraction anywhere in an altitude band.

    Max rather than mean: a deck is a thin layer, and averaging it against the
    clear air around it hides exactly the feature we are looking for.
    """
    if high_m <= low_m or not levels:
        return 0.0
    altitude = low_m
    peak = 0.0
    while altitude <= high_m:
        peak = max(peak, cloud_at(levels, altitude))
        altitude += PROFILE_STEP_M
    return max(peak, cloud_at(levels, high_m))


def find_deck(
    levels: tuple[LevelSample, ...], below_m: float
) -> tuple[float | None, float | None]:
    """Base and top of the lowest contiguous cloud layer starting below below_m.

    Returns (None, None) when there is no layer meeting DECK_THRESHOLD.
    """
    if not levels:
        return None, None
    ceiling = levels[-1].height_m
    base: float | None = None
    top: float | None = None

    altitude = float(DECK_SEARCH_FLOOR_M)
    while altitude <= ceiling:
        cloudy = cloud_at(levels, altitude) >= DECK_THRESHOLD
        if cloudy and base is None:
            base = altitude
        elif not cloudy and base is not None:
            top = altitude
            break
        altitude += PROFILE_STEP_M

    if base is None:
        return None, None
    if top is None:  # layer runs to the top of the profile
        top = ceiling

    # Require a real measured level below the spot to be cloudy. Pressure
    # levels near the summit are ~500m apart, and interpolating between a clear
    # level and a cloudy one above it invents a cloud base in the gap. That
    # phantom deck reads as "cloud sea underfoot" when the cloud is actually
    # all above you.
    measured_below = any(
        lv.cloud_cover >= DECK_THRESHOLD and lv.height_m <= below_m for lv in levels
    )
    if not measured_below:
        return None, None
    return base, top


def inversion_strength(levels: tuple[LevelSample, ...]) -> float:
    """Largest temperature increase with height, in degrees C.

    Positive means a temperature inversion is present - the stable lid that
    creates the cloud deck. Zero means a normal decreasing profile.
    """
    low, high = INVERSION_BAND_M
    in_band = [lv for lv in levels if low <= lv.height_m <= high]
    strongest = 0.0
    for lower, upper in zip(in_band, in_band[1:]):
        strongest = max(strongest, upper.temperature_c - lower.temperature_c)
    return strongest


def vertical_confidence(levels: tuple[LevelSample, ...], elevation_m: float) -> float:
    """How well the model resolves altitudes around the summit.

    Pressure levels near 1800m are ~500m apart, so the deck top can hide in the
    gap between them. Wider gap, less trust.
    """
    below = [lv.height_m for lv in levels if lv.height_m <= elevation_m]
    above = [lv.height_m for lv in levels if lv.height_m > elevation_m]
    if not below or not above:
        return 0.35
    gap = min(above) - max(below)
    return max(0.35, min(1.0, 1.0 - (gap - 300.0) / 900.0))


# --- scoring --------------------------------------------------------------


def _lead_time_confidence(sunrise: datetime, issued_at: datetime) -> float:
    days = max(0.0, (sunrise - issued_at).total_seconds() / 86400.0)
    return max(0.4, 1.0 - 0.15 * days)


def _grid_confidence(grid_elevation_m: float | None, elevation_m: float) -> float:
    """Penalise spots the model terrain does not resolve.

    Open-Meteo reports 1785m for the true 1818m of Arieiro - fine. A coastal
    grid cell standing in for a 1000m ridge is not.
    """
    if grid_elevation_m is None:
        return 0.9
    error = abs(grid_elevation_m - elevation_m)
    return max(0.3, min(1.0, 1.0 - error / 800.0))


def score_hour(spot: Spot, hour: AtmosphereHour) -> tuple[Score, Score, dict]:
    """Score one hour. Returns (visibility, cloud_sea, diagnostics)."""
    elevation = spot.elevation_m
    levels = hour.levels

    blocking_low = elevation + SUMMIT_MARGIN_M
    blocking_high = min(
        elevation + BLOCKING_CEILING_M,
        levels[-1].height_m if levels else blocking_low,
    )
    above_profile = band_max(levels, blocking_low, blocking_high)
    # Mid-level cloud (3-8km) sits above our pressure profile but still hides
    # the sun. High cirrus is treated as colour, not obstruction.
    blocking = max(above_profile, hour.cloud_cover_mid)

    below_cover = band_max(
        levels, max(DECK_SEARCH_FLOOR_M, elevation - 1400), elevation - SUMMIT_MARGIN_M
    )
    deck_base, deck_top = find_deck(levels, below_m=elevation)
    # Cloud fraction at the summit itself. This is the most direct answer to
    # "am I standing in the fog or above it", and it is more robust than
    # comparing an interpolated deck top against the summit height.
    summit_cover = cloud_at(levels, elevation)

    # --- visibility
    visibility = 100.0 * (1.0 - blocking)
    vis_reasons: list[str] = []
    if hour.precipitation_mm > 0.2:
        visibility *= 0.35
        vis_reasons.append("rain forecast ({:.1f}mm)".format(hour.precipitation_mm))
    if blocking >= 0.7:
        vis_reasons.append("cloud above the summit ({:.0f}%)".format(blocking * 100))
    elif blocking <= 0.2:
        vis_reasons.append("clear air above the summit")
    else:
        vis_reasons.append(
            "broken cloud above the summit ({:.0f}%)".format(blocking * 100)
        )
    if 0.15 <= hour.cloud_cover_high <= 0.75 and blocking < 0.4:
        visibility = min(100.0, visibility * 1.05)
        vis_reasons.append("high cirrus - good colour")
    if hour.wind_speed_10m_kmh >= STRONG_WIND_KMH:
        vis_reasons.append(
            "strong wind ({:.0f} km/h)".format(hour.wind_speed_10m_kmh)
        )

    # --- cloud sea
    in_the_cloud = summit_cover >= DECK_THRESHOLD
    deck_below = deck_top is not None and deck_top < elevation - SUMMIT_MARGIN_M

    # Three independent conditions must all hold for a sea of clouds: thick
    # cloud below you, clear air above you, and clear air where you stand.
    cloud_sea = 100.0 * below_cover * (1.0 - above_profile) * (1.0 - summit_cover)
    sea_reasons: list[str] = []
    if in_the_cloud:
        sea_reasons.append(
            "summit likely inside the cloud ({:.0f}% at {:.0f}m)".format(
                summit_cover * 100, elevation
            )
        )
    elif deck_below:
        sea_reasons.append(
            "cloud deck top near {:.0f}m, below the summit".format(deck_top)
        )
    elif deck_top is None:
        sea_reasons.append("no cloud deck forecast below the summit")
    else:
        # A layer exists but its top is above the summit: the viewpoint is
        # inside or beneath it. Never leave a score unexplained.
        sea_reasons.append(
            "cloud layer reaches {:.0f}m, above the summit".format(deck_top)
        )

    strength = inversion_strength(levels)
    if strength > 0.5:
        sea_reasons.append(
            "temperature inversion present (+{:.1f} C)".format(strength)
        )

    # --- confidence
    base_confidence = vertical_confidence(levels, elevation)
    diagnostics = {
        "blocking": blocking,
        "above_profile": above_profile,
        "below_cover": below_cover,
        "summit_cover": summit_cover,
        "deck_base_m": deck_base,
        "deck_top_m": deck_top,
        "inversion_c": strength,
        "vertical_confidence": base_confidence,
    }

    # An inversion is the mechanism behind the deck; its presence makes the
    # cloud_sea call more trustworthy, its absence less.
    sea_confidence = base_confidence * (1.0 if strength > 0.5 else 0.75)

    return (
        Score(round(max(0.0, min(100.0, visibility)), 1), base_confidence, vis_reasons),
        Score(round(max(0.0, min(100.0, cloud_sea)), 1), sea_confidence, sea_reasons),
        diagnostics,
    )


def score_sunrise(
    spot: Spot, forecast: AtmosphereForecast, day_index: int = 0
) -> SunriseOutlook | None:
    """Score the sunrise window for one spot on one forecast day.

    Averages the hours within SUNRISE_WINDOW_H of actual local sunrise rather
    than picking a fixed UTC hour - sunrise moves by over an hour across the
    year and the deck changes fast around dawn.
    """
    if day_index >= len(forecast.sunrise):
        return None
    sunrise = forecast.sunrise[day_index]
    window = timedelta(hours=SUNRISE_WINDOW_H)
    hours = [h for h in forecast.hours if abs(h.time - sunrise) <= window]
    if not hours:
        return None

    scored = [score_hour(spot, hour) for hour in hours]
    count = len(scored)

    visibility = sum(s[0].value for s in scored) / count
    cloud_sea = sum(s[1].value for s in scored) / count
    lead = _lead_time_confidence(sunrise, forecast.issued_at)
    grid = _grid_confidence(forecast.grid_elevation_m, spot.elevation_m)

    vis_confidence = (sum(s[0].confidence for s in scored) / count) * lead * grid
    sea_confidence = (sum(s[1].confidence for s in scored) / count) * lead * grid

    # Reasons come from the hour closest to sunrise, so they describe the
    # moment the user actually cares about.
    closest = min(range(count), key=lambda i: abs(hours[i].time - sunrise))
    pivot_hour, pivot = hours[closest], scored[closest]

    return SunriseOutlook(
        spot_id=spot.id,
        day=sunrise.date(),
        sunrise_utc=sunrise,
        visibility=Score(
            round(visibility, 1), round(vis_confidence, 2), pivot[0].reasons
        ),
        cloud_sea=Score(
            round(cloud_sea, 1), round(sea_confidence, 2), pivot[1].reasons
        ),
        deck_base_m=pivot[2]["deck_base_m"],
        deck_top_m=pivot[2]["deck_top_m"],
        inversion_strength_c=round(pivot[2]["inversion_c"], 2),
        temperature_c=round(
            temperature_at(pivot_hour.levels, spot.elevation_m), 1
        ),
        wind_kmh=round(sum(h.wind_speed_10m_kmh for h in hours) / count, 1),
        precipitation_mm=round(sum(h.precipitation_mm for h in hours), 1),
    )
