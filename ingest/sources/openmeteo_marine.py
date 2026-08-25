"""Open-Meteo Marine source: sea state and SST for beach spots.

Same licensing position as the atmosphere source - free tier is non-commercial
only, CC BY 4.0 attribution required.

The marine models are gridded on the ocean. A beach coordinate that sits a few
hundred metres inland can land in a land cell and come back empty, so callers
must tolerate missing values rather than assume every beach resolves.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Sequence

from ingest.sources.base import MarineForecast, MarineHour
from ingest.sources.http import get_json, make_session
from ingest.spots import Spot

ENDPOINT = "https://marine-api.open-meteo.com/v1/marine"

HOURLY_VARS = (
    "wave_height",
    "wave_direction",
    "wave_period",
    "swell_wave_height",
    "sea_surface_temperature",
)


def _opt(series, index: int) -> float | None:
    if series is None:
        return None
    value = series[index]
    return None if value is None else float(value)


def _parse_location(spot_id: str, payload: dict) -> MarineForecast:
    hourly = payload.get("hourly") or {}
    times = hourly.get("time", [])
    hours = tuple(
        MarineHour(
            time=datetime.fromtimestamp(epoch, tz=timezone.utc),
            sst_c=_opt(hourly.get("sea_surface_temperature"), index),
            wave_height_m=_opt(hourly.get("wave_height"), index),
            wave_period_s=_opt(hourly.get("wave_period"), index),
            wave_direction_deg=_opt(hourly.get("wave_direction"), index),
            swell_height_m=_opt(hourly.get("swell_wave_height"), index),
        )
        for index, epoch in enumerate(times)
    )
    return MarineForecast(
        spot_id=spot_id,
        source=OpenMeteoMarine.name,
        issued_at=datetime.now(tz=timezone.utc),
        hours=hours,
    )


class OpenMeteoMarine:
    name = "open-meteo-marine"
    attribution = "Marine data by Open-Meteo.com (CC BY 4.0)"

    def __init__(self, session=None):
        self._session = session or make_session()

    def build_params(self, spots: Sequence[Spot], hours: int) -> dict:
        return {
            "latitude": ",".join(f"{s.lat:.4f}" for s in spots),
            "longitude": ",".join(f"{s.lon:.4f}" for s in spots),
            "hourly": ",".join(HOURLY_VARS),
            "forecast_days": max(1, min(7, -(-hours // 24))),
            "timeformat": "unixtime",
            "timezone": "UTC",
            "cell_selection": "sea",
        }

    def fetch(self, spots: Sequence[Spot], hours: int = 72) -> dict[str, MarineForecast]:
        payload = get_json(self._session, ENDPOINT, self.build_params(spots, hours))
        return self.parse(spots, payload)

    @staticmethod
    def parse(spots: Sequence[Spot], payload) -> dict[str, MarineForecast]:
        locations = payload if isinstance(payload, list) else [payload]
        if len(locations) != len(spots):
            raise ValueError(
                f"Marine API returned {len(locations)} locations for {len(spots)} spots"
            )
        return {
            spot.id: _parse_location(spot.id, location)
            for spot, location in zip(spots, locations)
        }
