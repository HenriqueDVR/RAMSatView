"""Open-Meteo Air Quality source: Saharan dust over the archipelago.

Calima is the local word for it, and it is the one weather event this product
was blind to. Cloud and dust ruin a summit sunrise in completely different
ways: cloud is condensed water the model can see in the vertical profile, dust
is suspended mineral that leaves the profile looking perfect. On a calima
morning the scores here read a hundred - clear air above the summit, no deck
in the way - and what you actually get is an orange sky, a horizon a few
kilometres off and no view of anything.

Same licensing position as the other Open-Meteo sources: free tier is
non-commercial, CC BY 4.0 attribution required, and no account of any kind.
The endpoint takes the same comma-separated coordinate list, so fifteen spots
is one request.

Fails open, deliberately. Dust sharpens a forecast; it is not the forecast. An
air-quality outage must cost the calima warning and nothing else.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Sequence

from ingest.sources.base import AirForecast, AirHour
from ingest.sources.http import get_json, make_session
from ingest.spots import Spot

ENDPOINT = "https://air-quality-api.open-meteo.com/v1/air-quality"

HOURLY_VARS = ("aerosol_optical_depth", "dust")


def _opt(series, index: int) -> float | None:
    if series is None or index >= len(series):
        return None
    value = series[index]
    return None if value is None else float(value)


def _parse_location(spot_id: str, payload: dict) -> AirForecast:
    hourly = payload.get("hourly") or {}
    times = hourly.get("time", [])
    hours = tuple(
        AirHour(
            time=datetime.fromtimestamp(epoch, tz=timezone.utc),
            aod=_opt(hourly.get("aerosol_optical_depth"), index),
            dust_ug_m3=_opt(hourly.get("dust"), index),
        )
        for index, epoch in enumerate(times)
    )
    return AirForecast(
        spot_id=spot_id,
        source=OpenMeteoAir.name,
        issued_at=datetime.now(tz=timezone.utc),
        hours=hours,
    )


class OpenMeteoAir:
    name = "open-meteo-air-quality"
    attribution = "Air quality data by Open-Meteo.com (CC BY 4.0)"

    def __init__(self, session=None):
        self._session = session or make_session()

    def build_params(
        self, spots: Sequence[Spot], past_days: int, forecast_days: int
    ) -> dict:
        return {
            "latitude": ",".join(f"{s.lat:.4f}" for s in spots),
            "longitude": ",".join(f"{s.lon:.4f}" for s in spots),
            "hourly": ",".join(HOURLY_VARS),
            "past_days": past_days,
            "forecast_days": forecast_days,
            "timeformat": "unixtime",
            "timezone": "UTC",
        }

    def fetch(
        self,
        spots: Sequence[Spot],
        past_days: int = 7,
        forecast_days: int = 3,
    ) -> dict[str, AirForecast]:
        payload = get_json(
            self._session, ENDPOINT, self.build_params(spots, past_days, forecast_days)
        )
        return self.parse(spots, payload)

    @staticmethod
    def parse(spots: Sequence[Spot], payload) -> dict[str, AirForecast]:
        # One location comes back as an object, several as a list in the order
        # the coordinates were sent.
        locations = payload if isinstance(payload, list) else [payload]
        if len(locations) != len(spots):
            raise ValueError(
                f"air quality returned {len(locations)} locations for {len(spots)} spots"
            )
        return {
            spot.id: _parse_location(spot.id, location)
            for spot, location in zip(spots, locations)
        }
