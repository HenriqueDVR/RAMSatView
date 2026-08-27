"""Normalised forecast schema and the provider protocol.

Everything downstream (scoring, JSON output, the web app) depends only on the
types in this module, never on a provider's response shape. Swapping
Open-Meteo for a self-hosted instance or raw ECMWF open data means writing one
new module that satisfies these protocols and changing nothing else.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, Sequence

from ingest.spots import Spot

# Pressure levels we request. Dense near the surface because the trade-wind
# inversion and the cloud deck both sit between roughly 700m and 2000m, which
# is 950-800hPa. Above 700hPa is only useful for spotting high cirrus.
PRESSURE_LEVELS: tuple[int, ...] = (1000, 975, 950, 925, 900, 850, 800, 700)


@dataclass(frozen=True)
class LevelSample:
    """One pressure level at one hour, resolved to a real altitude."""

    pressure_hpa: int
    height_m: float  # geopotential height, metres above sea level
    cloud_cover: float  # 0..1
    temperature_c: float


@dataclass(frozen=True)
class AtmosphereHour:
    time: datetime  # timezone-aware, UTC
    levels: tuple[LevelSample, ...]  # ascending by height_m
    cloud_cover_total: float  # 0..1
    cloud_cover_low: float
    cloud_cover_mid: float
    cloud_cover_high: float
    precipitation_mm: float
    wind_speed_10m_kmh: float
    freezing_level_m: float | None = None
    boundary_layer_m: float | None = None


@dataclass(frozen=True)
class AirHour:
    """One hour of what is suspended in the air, rather than condensed in it.

    Cloud and dust ruin a summit view in completely different ways and the
    model only knew about the first. A Saharan dust plume - calima locally -
    leaves the sky technically clear and the view gone: the sun comes up
    through an orange soup and the horizon is a few kilometres away.
    """

    time: datetime  # timezone-aware, UTC
    # Aerosol optical depth at 550nm, dimensionless. Literally how much light
    # the column scatters out, which is exactly the quantity a hazy view is
    # about. Clean maritime air over Madeira sits near 0.1.
    aod: float | None
    # Surface dust concentration. Corroborates the AOD and is the number people
    # recognise from air-quality warnings.
    dust_ug_m3: float | None


@dataclass(frozen=True)
class AirForecast:
    spot_id: str
    source: str
    issued_at: datetime
    hours: tuple[AirHour, ...]


@dataclass(frozen=True)
class AtmosphereForecast:
    spot_id: str
    source: str
    issued_at: datetime
    hours: tuple[AtmosphereHour, ...]
    sunrise: tuple[datetime, ...] = ()  # one per forecast day, UTC
    sunset: tuple[datetime, ...] = ()
    grid_elevation_m: float | None = None  # model cell elevation, for QA


@dataclass(frozen=True)
class MarineHour:
    time: datetime
    sst_c: float | None = None
    wave_height_m: float | None = None
    wave_period_s: float | None = None
    wave_direction_deg: float | None = None
    swell_height_m: float | None = None


@dataclass(frozen=True)
class MarineForecast:
    spot_id: str
    source: str
    issued_at: datetime
    hours: tuple[MarineHour, ...]


@dataclass(frozen=True)
class OfficialStatus:
    """Authoritative island-wide data from IPMA.

    Displayed verbatim and used to gate scores. Never overridden by our own
    model - if IPMA says there is a maritime warning, no beach scores well.
    """

    source: str
    issued_at: datetime
    warnings: tuple[dict, ...] = ()
    uv_index: dict[str, float] | None = None  # globalIdLocal -> peak UV
    fire_risk: dict[str, int] | None = None  # globalIdLocal -> 1..5


class AtmosphereSource(Protocol):
    """Vertical profile provider. The inversion model's only input."""

    name: str
    attribution: str

    def fetch(
        self, spots: Sequence[Spot], hours: int
    ) -> dict[str, AtmosphereForecast]: ...


class MarineSource(Protocol):
    name: str
    attribution: str

    def fetch(self, spots: Sequence[Spot], hours: int) -> dict[str, MarineForecast]: ...


class OfficialSource(Protocol):
    name: str
    attribution: str

    def fetch(self) -> OfficialStatus: ...
