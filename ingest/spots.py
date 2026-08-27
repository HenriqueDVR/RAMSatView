"""Spot registry: the places we score, loaded from data/spots.yaml."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import yaml

SpotType = Literal["viewpoint", "beach"]

# IPMA issues warnings per area, not per point. Madeira has four:
#   MRM  mountainous interior      MPS  Porto Santo
#   MCN  north coast               MCS  south coast
IPMA_AREAS = ("MRM", "MCN", "MCS", "MPS")

REPO_ROOT = Path(__file__).resolve().parent.parent
SPOTS_FILE = REPO_ROOT / "data" / "spots.yaml"

# Madeira archipelago bounding box, used to catch typo'd coordinates before
# they reach an API and silently return forecasts for the open Atlantic.
BBOX = (32.3, 33.2, -17.4, -16.2)  # lat_min, lat_max, lon_min, lon_max


@dataclass(frozen=True)
class Spot:
    id: str
    type: SpotType
    name_pt: str
    name_en: str
    lat: float
    lon: float
    elevation_m: float
    ipma_area: str
    # Multiplier on wave height for spots that suffer more (rock pools, dive
    # sites) or less (breakwater-sheltered bays) than the open coast.
    swell_sensitivity: float = 1.0
    # Fanal, and only Fanal so far: the laurel forest in mist is what people
    # drive there for, so cloud at the viewpoint is the attraction rather than
    # the thing that ruins it. Everywhere else the same weather is a wasted
    # morning, and scoring both the same way told anyone asking about Fanal to
    # stay in bed on exactly the mornings they should go.
    fog_is_the_view: bool = False
    notes: str | None = None

    def name(self, locale: str) -> str:
        return self.name_pt if locale == "pt" else self.name_en


def _validate(spot: Spot) -> None:
    lat_min, lat_max, lon_min, lon_max = BBOX
    if not lat_min <= spot.lat <= lat_max:
        raise ValueError(f"{spot.id}: lat {spot.lat} outside Madeira bbox")
    if not lon_min <= spot.lon <= lon_max:
        raise ValueError(f"{spot.id}: lon {spot.lon} outside Madeira bbox")
    if spot.type not in ("viewpoint", "beach"):
        raise ValueError(f"{spot.id}: unknown type {spot.type!r}")
    if spot.elevation_m < 0 or spot.elevation_m > 2000:
        raise ValueError(f"{spot.id}: implausible elevation {spot.elevation_m}")
    if spot.ipma_area not in IPMA_AREAS:
        raise ValueError(f"{spot.id}: unknown IPMA area {spot.ipma_area!r}")


def load_spots(path: Path | None = None) -> list[Spot]:
    """Parse and validate the spot registry. Raises on any bad entry."""
    raw = yaml.safe_load((path or SPOTS_FILE).read_text(encoding="utf-8"))
    spots = [Spot(**entry) for entry in raw["spots"]]

    seen: set[str] = set()
    for spot in spots:
        if spot.id in seen:
            raise ValueError(f"duplicate spot id {spot.id!r}")
        seen.add(spot.id)
        _validate(spot)

    return spots


def by_type(spots: list[Spot], spot_type: SpotType) -> list[Spot]:
    return [s for s in spots if s.type == spot_type]
