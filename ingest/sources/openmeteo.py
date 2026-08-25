"""Open-Meteo atmosphere source: vertical profiles for the inversion model.

Free tier is non-commercial only and requires CC BY 4.0 attribution. All spots
go out in a single request using comma-separated coordinates, so an hourly cron
costs 24 calls/day against a 10,000/day limit.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Sequence

from ingest.sources.base import (
    PRESSURE_LEVELS,
    AtmosphereForecast,
    AtmosphereHour,
    LevelSample,
)
from ingest.sources.http import get_json, make_session
from ingest.spots import Spot

ENDPOINT = "https://api.open-meteo.com/v1/forecast"

SURFACE_VARS = (
    "cloud_cover",
    "cloud_cover_low",
    "cloud_cover_mid",
    "cloud_cover_high",
    "precipitation",
    "wind_speed_10m",
    "freezing_level_height",
)


def _hourly_vars() -> list[str]:
    variables = list(SURFACE_VARS)
    for level in PRESSURE_LEVELS:
        variables += [
            f"cloud_cover_{level}hPa",
            f"temperature_{level}hPa",
            f"geopotential_height_{level}hPa",
        ]
    return variables


def _pct(value) -> float:
    """Open-Meteo reports cloud cover as 0-100; we normalise to 0-1."""
    return 0.0 if value is None else max(0.0, min(1.0, float(value) / 100.0))


def _num(value, default: float = 0.0) -> float:
    return default if value is None else float(value)


def _parse_location(spot_id: str, payload: dict) -> AtmosphereForecast:
    hourly = payload["hourly"]
    times = hourly["time"]
    hours: list[AtmosphereHour] = []

    for index, epoch in enumerate(times):
        levels: list[LevelSample] = []
        for level in PRESSURE_LEVELS:
            height = hourly.get(f"geopotential_height_{level}hPa", [None] * len(times))[index]
            if height is None:
                # Level below ground or missing for this model; skip rather
                # than fabricate an altitude.
                continue
            levels.append(
                LevelSample(
                    pressure_hpa=level,
                    height_m=float(height),
                    cloud_cover=_pct(hourly.get(f"cloud_cover_{level}hPa", [None] * len(times))[index]),
                    temperature_c=_num(
                        hourly.get(f"temperature_{level}hPa", [None] * len(times))[index]
                    ),
                )
            )
        levels.sort(key=lambda sample: sample.height_m)

        hours.append(
            AtmosphereHour(
                time=datetime.fromtimestamp(epoch, tz=timezone.utc),
                levels=tuple(levels),
                cloud_cover_total=_pct(hourly["cloud_cover"][index]),
                cloud_cover_low=_pct(hourly["cloud_cover_low"][index]),
                cloud_cover_mid=_pct(hourly["cloud_cover_mid"][index]),
                cloud_cover_high=_pct(hourly["cloud_cover_high"][index]),
                precipitation_mm=_num(hourly["precipitation"][index]),
                wind_speed_10m_kmh=_num(hourly["wind_speed_10m"][index]),
                freezing_level_m=hourly.get("freezing_level_height", [None] * len(times))[index],
            )
        )

    daily = payload.get("daily", {})
    return AtmosphereForecast(
        spot_id=spot_id,
        source=OpenMeteoAtmosphere.name,
        issued_at=datetime.now(tz=timezone.utc),
        hours=tuple(hours),
        sunrise=tuple(
            datetime.fromtimestamp(t, tz=timezone.utc) for t in daily.get("sunrise", [])
        ),
        sunset=tuple(
            datetime.fromtimestamp(t, tz=timezone.utc) for t in daily.get("sunset", [])
        ),
        grid_elevation_m=payload.get("elevation"),
    )


class OpenMeteoAtmosphere:
    name = "open-meteo"
    attribution = "Weather data by Open-Meteo.com (CC BY 4.0)"

    def __init__(self, session=None):
        self._session = session or make_session()

    def build_params(self, spots: Sequence[Spot], hours: int) -> dict:
        return {
            "latitude": ",".join(f"{s.lat:.4f}" for s in spots),
            "longitude": ",".join(f"{s.lon:.4f}" for s in spots),
            "hourly": ",".join(_hourly_vars()),
            "daily": "sunrise,sunset",
            "forecast_days": max(1, min(7, -(-hours // 24))),
            "timeformat": "unixtime",
            "timezone": "UTC",
            "cell_selection": "nearest",
        }

    def fetch(self, spots: Sequence[Spot], hours: int = 72) -> dict[str, AtmosphereForecast]:
        payload = get_json(self._session, ENDPOINT, self.build_params(spots, hours))
        return self.parse(spots, payload)

    @staticmethod
    def parse(spots: Sequence[Spot], payload) -> dict[str, AtmosphereForecast]:
        # A single-location request returns an object; multi-location returns a
        # list in the same order as the coordinates we sent.
        locations = payload if isinstance(payload, list) else [payload]
        if len(locations) != len(spots):
            raise ValueError(
                f"Open-Meteo returned {len(locations)} locations for {len(spots)} spots"
            )
        return {
            spot.id: _parse_location(spot.id, location)
            for spot, location in zip(spots, locations)
        }
