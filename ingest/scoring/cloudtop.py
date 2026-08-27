"""Observed cloud-top altitude: infrared brightness turned into metres.

A geostationary infrared pixel measures one thing - how cold the top of what it
can see is. That is not a picture of cloud, it is a temperature field, and it
becomes useful only when read against a temperature profile of the atmosphere
underneath it: the altitude at which the air is that cold is the altitude of
the cloud top. The profile is the one already reconstructed in metres for every
viewpoint, so this costs no extra fetch.

Two corrections stand between the two numbers.

*Atmospheric depression.* The 10.8um window is not perfectly transparent; water
vapour between the cloud and the satellite absorbs and re-emits, so an observed
top always reads a little colder than the air actually is there. Over open water
around Madeira the mosaic plateaus at about 21.2C - the same value across
thousands of clear cells - against the 24.2-24.5C sea surface already ingested
from Open-Meteo. Three kelvin is the size of the effect at this humidity and
this viewing angle from Meteosat.

*Clear sky is not zero.* A cloud-free pixel still returns a temperature - the
sea's. Nothing distinguishes it from a very low cloud except that its implied
top sits at or under the surface, which is what `CLEAR_CEILING_M` tests. Cloud
below that is fog the satellite cannot separate from the sea anyway.

The output is a top in metres, never a cloud fraction. An infrared pixel cannot
say how thick or how broken a deck is - only where its top is - and publishing
a fraction here would invent a number the instrument did not measure.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Sequence

import numpy as np

from ingest.sources.base import AtmosphereForecast, LevelSample
from ingest.sources.gmgsi import SatelliteScan

# How much colder the satellite reads than the air really is, in kelvin.
# Calibrated against sea-surface temperature over clear water; see the module
# docstring. Applied as a straight offset because the correction that would
# deserve more than that needs a radiative transfer model and a humidity
# profile per pixel, and this product does not need that precision.
ATMOSPHERIC_DEPRESSION_K = 3.0

# An implied top under this reads as clear sky rather than cloud. The sea
# surface itself lands here, and so does any fog too shallow to tell apart.
CLEAR_CEILING_M = 200.0

# Nothing above this is the trade-wind deck; it is cirrus, and the deck view is
# what the product is about. Kept as a ceiling rather than a filter so high
# cloud still shows - it shades the sunrise even when it is not the deck.
TOP_CEILING_M = 12000.0

# The blob stores metres in this quantum, one byte per cell. 50m is finer than
# the model levels the profile is interpolated from, so it is not the limiting
# error, and it reaches 12.75km - above any cloud top in this basin.
TOP_STEP_M = 50

# Used only where no forecast profile is available at all. The standard
# tropospheric lapse rate against a 20C sea surface: coarse, but it keeps an
# observed field on the map rather than dropping it.
FALLBACK_SURFACE_C = 20.0
FALLBACK_LAPSE_C_PER_KM = 6.5


def _fallback_altitude(temperature_c: float) -> float:
    return max(0.0, (FALLBACK_SURFACE_C - temperature_c) / FALLBACK_LAPSE_C_PER_KM * 1000.0)


def altitude_of_temperature(
    levels: tuple[LevelSample, ...], temperature_c: float
) -> float:
    """Lowest altitude at which the profile is this cold.

    Lowest, not highest, because an inversion makes the mapping ambiguous: in a
    trade-wind profile the air at 300m and at 1400m can share a temperature.
    The lower answer is the right one for a cloud top under an inversion, which
    is the case this product exists for, and it fails safe - it never lifts a
    stratocumulus deck into the free troposphere.
    """
    if not levels:
        return _fallback_altitude(temperature_c)

    previous_height = levels[0].height_m
    previous_temp = levels[0].temperature_c
    if temperature_c >= previous_temp:
        # Warmer than anything in the column: at or below the lowest level.
        return previous_height

    for level in levels[1:]:
        if level.temperature_c <= temperature_c:
            span = level.temperature_c - previous_temp
            if span == 0:
                return level.height_m
            weight = (temperature_c - previous_temp) / span
            return previous_height + weight * (level.height_m - previous_height)
        previous_height, previous_temp = level.height_m, level.temperature_c

    # Colder than the top of the profile - extrapolate on the last lapse rate
    # rather than clamping, or every cirrus top in the window collapses onto
    # the 3000m ceiling of the requested levels.
    top = levels[-1]
    if len(levels) >= 2:
        lower = levels[-2]
        lapse = (top.temperature_c - lower.temperature_c) / max(
            top.height_m - lower.height_m, 1.0
        )
        if lapse < 0:
            return top.height_m + (temperature_c - top.temperature_c) / lapse
    return top.height_m


def cloud_top_m(
    brightness_k: float, levels: tuple[LevelSample, ...]
) -> float:
    """One pixel: observed brightness temperature to cloud-top metres.

    Returns 0.0 for clear sky. NaN in means NaN out - a cell the mosaic had no
    retrieval for is a hole, not a clear sky, and flattening the two would draw
    a suspiciously sunny stripe wherever the satellites overlap badly.
    """
    if not np.isfinite(brightness_k):
        return float("nan")
    corrected_c = brightness_k + ATMOSPHERIC_DEPRESSION_K - 273.15
    altitude = altitude_of_temperature(levels, corrected_c)
    if altitude < CLEAR_CEILING_M:
        return 0.0
    return min(altitude, TOP_CEILING_M)


def tops_from_scan(
    temperatures_k: np.ndarray, levels: tuple[LevelSample, ...]
) -> np.ndarray:
    """The whole window at once, as float metres with NaN for missing cells."""
    flat = np.asarray(temperatures_k, dtype=np.float64).ravel()
    tops = np.array([cloud_top_m(value, levels) for value in flat], dtype=np.float64)
    return tops.reshape(np.asarray(temperatures_k).shape)


def encode_tops(tops: np.ndarray) -> bytes:
    """Metres to one byte per cell, in `TOP_STEP_M` steps.

    255 is reserved for "no retrieval" rather than being the top of the scale:
    the renderer has to be able to leave a hole alone, and a hole that decoded
    as 12.75km of cloud would be the most visible artefact on the map.
    """
    values = np.asarray(tops, dtype=np.float64)
    encoded = np.rint(np.nan_to_num(values, nan=0.0) / TOP_STEP_M)
    encoded = np.clip(encoded, 0, 254).astype(np.uint8)
    encoded[~np.isfinite(values)] = 255
    return encoded.tobytes()


# --- the published product ------------------------------------------------


@dataclass(frozen=True)
class ObservedCloud:
    """Observed cloud-top altitude over the window, hour by hour."""

    #: Cell centres. Shipped explicitly rather than derived from the box: the
    #: mosaic's rows are evenly spaced in its own projection, not in latitude,
    #: so the spacing shrinks slightly towards the poles. Over this window that
    #: is under a percent, but the renderer should not have to know that.
    lats: tuple[float, ...]
    lons: tuple[float, ...]
    times: tuple[datetime, ...]
    #: [time][row][col], one byte per cell, `TOP_STEP_M` metres each.
    values: bytes

    @property
    def rows(self) -> int:
        return len(self.lats)

    @property
    def cols(self) -> int:
        return len(self.lons)

    def top_m(self, time_index: int, row: int, col: int) -> float | None:
        """Cloud-top metres, or None where the mosaic had no retrieval."""
        offset = (time_index * self.rows + row) * self.cols + col
        raw = self.values[offset]
        return None if raw == 255 else raw * TOP_STEP_M


def nearest_hour_levels(
    forecast: AtmosphereForecast, when: datetime
) -> tuple[LevelSample, ...]:
    """The profile closest in time to a scan.

    Nearest rather than exact: the per-spot forecast starts at midnight today
    and runs forward, while scans reach back a few hours, so a scan taken just
    after midnight has no matching forecast hour at all. An hour either side
    changes a low-level temperature by a fraction of a degree.
    """
    if not forecast.hours:
        return ()
    return min(
        forecast.hours, key=lambda hour: abs((hour.time - when).total_seconds())
    ).levels


def fuse(
    scans: Sequence[SatelliteScan],
    levels_at: Callable[[datetime], tuple[LevelSample, ...]],
) -> ObservedCloud:
    """Scans plus profiles to one blob of observed cloud-top altitude.

    Every pixel in an hour is read against the *same* temperature profile,
    Madeira's. That was easy to defend when the window was 100km across. It is
    now the camera box, some 800km by 700km, and it is worth being honest about
    what that costs: the profile that matters is the lowest two kilometres,
    which over open ocean in one air mass is near enough uniform, but the far
    corners of this window are not guaranteed to be in Madeira's air mass. Tops
    near the islands are as good as they were; tops at the edge are a plausible
    altitude for a temperature that was really measured, and should be read as
    context rather than as a number to drive up a mountain on.

    The alternative - a profile per satellite cell - means paying Open-Meteo
    for temperature across the whole box, which is thousands of grid points a
    run for a budget that has room for eighty, to sharpen a number whose error
    is dominated by the infrared correction anyway.
    """
    if not scans:
        raise ValueError("no satellite scans to fuse")

    first = scans[0]
    payload = bytearray()
    for scan in scans:
        if scan.lats != first.lats or scan.lons != first.lons:
            # The mosaic is a fixed grid, so this means the window moved
            # between fetches - a bug here, not upstream. Refuse it: a ragged
            # stack of hours cannot be indexed as one volume.
            raise ValueError("satellite scans disagree about their footprint")
        tops = tops_from_scan(scan.temperatures_k, levels_at(scan.time))
        payload += encode_tops(tops)

    return ObservedCloud(
        lats=first.lats,
        lons=first.lons,
        times=tuple(scan.time for scan in scans),
        values=bytes(payload),
    )


def header(observed: ObservedCloud, generated_at: datetime) -> dict:
    """What travels inside conditions.json to describe the blob beside it."""
    return {
        "file": "cloud-observed.bin",
        "generated_at": generated_at.astimezone(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "source": "NOAA GMGSI longwave infrared",
        "lats": [round(value, 4) for value in observed.lats],
        "lons": [round(value, 4) for value in observed.lons],
        "rows": observed.rows,
        "cols": observed.cols,
        "step_m": TOP_STEP_M,
        # The byte the renderer must leave as a hole rather than draw.
        "missing": 255,
        "times": [
            time.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            for time in observed.times
        ],
        "bytes": len(observed.values),
    }
