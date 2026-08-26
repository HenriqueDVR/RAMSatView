"""Gridded cloud field: the forecast as a volume rather than as a column.

The per-spot forecast in openmeteo.py answers "what is above Pico Ruivo". This
answers "what is above the archipelago", on a regular grid, so the map can draw
cloud whose *shape* comes from the forecast instead of from noise. It is also
what makes a cloud-top-altitude heatmap possible at all.

Deliberately leaner than the per-spot request. Weight on Open-Meteo's free tier
is roughly (variables / 14) x (days / 14) per location, so eighty locations with
the full pressure-level set would cost several thousand calls a day. Seven
levels and nothing else keeps an hourly run at a few dozen.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterator

from ingest.scoring.inversion import cloud_at
from ingest.sources.base import LevelSample
from ingest.sources.http import get_json, make_session

ENDPOINT = "https://api.open-meteo.com/v1/forecast"

# Denser near the surface, because the deck lives between roughly 700m and
# 2000m and the whole product is about where its top is. Above 700hPa the only
# thing to see is cirrus.
GRID_LEVELS: tuple[int, ...] = (1000, 950, 925, 900, 850, 800, 700)

# The altitude ladder the web app receives. Regular by construction: pressure
# levels are not, and a renderer sampling a 3D texture needs even spacing.
ALTITUDE_STEP_M = 250
ALTITUDE_CEILING_M = 3000
ALTITUDES: tuple[int, ...] = tuple(
    range(0, ALTITUDE_CEILING_M + 1, ALTITUDE_STEP_M)
)


@dataclass(frozen=True)
class GridSpec:
    """A lat/lon lattice over the archipelago.

    Cell size is a compromise: the model behind this is ~9km, so a finer grid
    would interpolate rather than inform, and a coarser one would miss the
    difference between Funchal in the sun and the north coast under cloud -
    which is the difference the island is famous for.
    """

    west: float
    south: float
    east: float
    north: float
    cols: int
    rows: int

    def points(self) -> Iterator[tuple[float, float]]:
        """Row-major, north to south, west to east - the order textures want."""
        for row in range(self.rows):
            lat = self.north - (self.north - self.south) * row / max(self.rows - 1, 1)
            for col in range(self.cols):
                lon = self.west + (self.east - self.west) * col / max(self.cols - 1, 1)
                yield lat, lon


# Matches BOUNDS in web/lib/map/sources.ts. If one moves, the other has to.
DEFAULT_GRID = GridSpec(
    west=-17.5, south=32.3, east=-16.2, north=33.2, cols=10, rows=8
)


@dataclass(frozen=True)
class CloudGrid:
    """Cloud fraction on a regular lattice in space, altitude and time."""

    spec: GridSpec
    altitudes: tuple[int, ...]
    times: tuple[datetime, ...]
    #: [time][altitude][row][col], each 0..255. Flat, in that order.
    values: bytes

    @property
    def cell_count(self) -> int:
        return self.spec.rows * self.spec.cols

    def expected_length(self) -> int:
        return len(self.times) * len(self.altitudes) * self.cell_count

    def at(self, time_index: int, altitude_index: int, row: int, col: int) -> float:
        """Cloud fraction 0..1, for tests and for the summary line."""
        offset = (
            (time_index * len(self.altitudes) + altitude_index) * self.cell_count
            + row * self.spec.cols
            + col
        )
        return self.values[offset] / 255.0


def _hourly_vars() -> list[str]:
    variables: list[str] = []
    for level in GRID_LEVELS:
        variables += [f"cloud_cover_{level}hPa", f"geopotential_height_{level}hPa"]
    return variables


def _levels_at(hourly: dict, index: int, count: int) -> tuple[LevelSample, ...]:
    """One column of the atmosphere, as height-sorted samples."""
    samples: list[LevelSample] = []
    for level in GRID_LEVELS:
        heights = hourly.get(f"geopotential_height_{level}hPa") or [None] * count
        covers = hourly.get(f"cloud_cover_{level}hPa") or [None] * count
        height = heights[index]
        if height is None:
            # Below ground for this cell, or missing from the model run. Skip
            # rather than invent an altitude for it.
            continue
        cover = covers[index]
        samples.append(
            LevelSample(
                pressure_hpa=level,
                height_m=float(height),
                cloud_cover=0.0 if cover is None else max(0.0, min(1.0, cover / 100.0)),
                # Unused here: cloud_at only reads height and cover. The grid
                # request does not pay for temperature, because the inversion
                # is scored per spot from the denser per-spot profile.
                temperature_c=0.0,
            )
        )
    samples.sort(key=lambda sample: sample.height_m)
    return tuple(samples)


class OpenMeteoCloudGrid:
    name = "open-meteo-grid"
    attribution = "Weather data by Open-Meteo.com (CC BY 4.0)"

    def __init__(self, spec: GridSpec = DEFAULT_GRID, session=None):
        self.spec = spec
        self._session = session or make_session()

    def build_params(self, past_days: int, forecast_days: int) -> dict:
        points = list(self.spec.points())
        return {
            "latitude": ",".join(f"{lat:.4f}" for lat, _ in points),
            "longitude": ",".join(f"{lon:.4f}" for _, lon in points),
            "hourly": ",".join(_hourly_vars()),
            "past_days": past_days,
            "forecast_days": forecast_days,
            "timeformat": "unixtime",
            "timezone": "UTC",
            "cell_selection": "nearest",
        }

    def fetch(self, past_days: int = 7, forecast_days: int = 3) -> CloudGrid:
        payload = get_json(
            self._session, ENDPOINT, self.build_params(past_days, forecast_days)
        )
        return self.parse(payload)

    def parse(self, payload) -> CloudGrid:
        locations = payload if isinstance(payload, list) else [payload]
        expected = self.spec.rows * self.spec.cols
        if len(locations) != expected:
            raise ValueError(
                f"Open-Meteo returned {len(locations)} cells for a {expected}-cell grid"
            )

        times = tuple(
            datetime.fromtimestamp(epoch, tz=timezone.utc)
            for epoch in locations[0]["hourly"]["time"]
        )
        for location in locations[1:]:
            if len(location["hourly"]["time"]) != len(times):
                # Every cell has to share one time axis or the volume cannot be
                # indexed at all. Better to fail the run than to publish a
                # ragged grid the renderer would silently misread.
                raise ValueError("grid cells disagree about their time axis")

        # Interpolate every column onto the ladder first, then write out in
        # [time][altitude][row][col] order - the order the 3D texture is
        # uploaded in, so the web side does no rearranging.
        columns: list[list[list[float]]] = []
        for location in locations:
            hourly = location["hourly"]
            per_hour: list[list[float]] = []
            for index in range(len(times)):
                levels = _levels_at(hourly, index, len(times))
                per_hour.append(
                    [cloud_at(levels, float(altitude)) for altitude in ALTITUDES]
                )
            columns.append(per_hour)

        values = bytearray(len(times) * len(ALTITUDES) * expected)
        offset = 0
        for time_index in range(len(times)):
            for altitude_index in range(len(ALTITUDES)):
                for cell in range(expected):
                    fraction = columns[cell][time_index][altitude_index]
                    values[offset] = max(0, min(255, round(fraction * 255)))
                    offset += 1

        return CloudGrid(
            spec=self.spec,
            altitudes=ALTITUDES,
            times=times,
            values=bytes(values),
        )


def header(grid: CloudGrid, generated_at: datetime) -> dict:
    """The part that travels inside conditions.json, describing the blob.

    `generated_at` is repeated here deliberately: the document and the binary
    are two files, and a mismatched pair would draw last week's weather over
    this morning's scores. Validation refuses that.
    """
    return {
        "file": "cloud-grid.bin",
        "generated_at": generated_at.astimezone(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "bbox": [grid.spec.west, grid.spec.south, grid.spec.east, grid.spec.north],
        "cols": grid.spec.cols,
        "rows": grid.spec.rows,
        "altitudes_m": list(grid.altitudes),
        "times": [
            time.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            for time in grid.times
        ],
        "bytes": len(grid.values),
    }


def estimate_call_weight(
    grid_points: int, variables: int, days: int
) -> float:
    """Open-Meteo's own weighting, so a dry run can say what a change costs.

    Their rule: a request costs one call per location while it stays under
    about fourteen variables and fourteen days, and scales proportionally past
    either of those - so neither factor is allowed to discount the call below
    one.
    """
    return grid_points * max(1.0, variables / 14) * max(1.0, days / 14)


def grid_call_weight(spec: GridSpec = DEFAULT_GRID, days: int = 10) -> float:
    return estimate_call_weight(spec.rows * spec.cols, len(_hourly_vars()), days)
