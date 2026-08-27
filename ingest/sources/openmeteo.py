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
from dataclasses import replace

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

    def build_params(
        self, spots: Sequence[Spot], hours: int, past_days: int = 0
    ) -> dict:
        return {
            "latitude": ",".join(f"{s.lat:.4f}" for s in spots),
            "longitude": ",".join(f"{s.lon:.4f}" for s in spots),
            "hourly": ",".join(_hourly_vars()),
            "daily": "sunrise,sunset",
            "forecast_days": max(1, min(7, -(-hours // 24))),
            "past_days": past_days,
            "timeformat": "unixtime",
            "timezone": "UTC",
            "cell_selection": "nearest",
        }

    def fetch(
        self, spots: Sequence[Spot], hours: int = 72, past_days: int = 0
    ) -> dict[str, AtmosphereForecast]:
        """Reaching backwards costs nothing.

        Open-Meteo charge one call per location while a request stays under
        about fourteen variables and fourteen days, and this one is already
        over on variables and nowhere near on days - so seven days of history
        weigh exactly what three days of forecast did. It is asked for because
        the scrubber can be dragged into the past, and a spot with no history
        leaves its own readouts frozen on a day summary while the map behind
        them moves.
        """
        payload = get_json(
            self._session, ENDPOINT, self.build_params(spots, hours, past_days)
        )
        parsed = self.parse(spots, payload)
        if not past_days:
            return parsed

        # The hours keep their history - that is what it was fetched for - but
        # the daily axis does not. Open-Meteo returns one sunrise per requested
        # day, past days included, and `score_sunrise` indexes that array to
        # decide which mornings to publish. Left alone it scored last Thursday
        # and shipped it as the forecast, with the beaches on the right days
        # beside it because they come from a source with no history.
        #
        # Dropped here rather than filtered by date downstream, because only
        # this call knows how much history it asked for. Everything further in
        # would have to infer it from a clock, and the committed fixtures are
        # entirely in the past by the time they are replayed.
        return {
            spot_id: replace(
                forecast,
                sunrise=forecast.sunrise[past_days:],
                sunset=forecast.sunset[past_days:],
            )
            for spot_id, forecast in parsed.items()
        }

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
