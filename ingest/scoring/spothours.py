"""Each spot's own numbers, hour by hour, as a byte per sample.

Why a blob and not five arrays inside conditions.json: ten days is 240 hours
for each of fifteen spots, and written as JSON that is some sixty kilobytes
against a document that is currently twenty-eight. `test_build.py` puts a 35KB
ceiling on that document and the reason is in its docstring - it is fetched
over mobile data on a mountain road, which is exactly the moment this product
is for. Quantised to a byte a sample the same series is eighteen kilobytes, it
travels beside conditions.json rather than inside it, and it can fail to load
without taking the scores down with it, the same way the cloud volume and the
observed field already do.

A byte is not a lossy shortcut here, it is honest about the input. The pressure
levels near the summits are roughly five hundred metres apart and the deck
altitude is interpolated between them, so twenty-metre steps are already finer
than the data can support.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Sequence

# The byte that means "no value here". Every series gives it up, which is why
# none of them may use the full 0..255 range.
MISSING = 255


@dataclass(frozen=True)
class Series:
    """One quantised channel: `value = byte * scale + offset`."""

    name: str
    scale: float
    offset: float

    def encode(self, value: float | None) -> int:
        if value is None:
            return MISSING
        raw = round((value - self.offset) / self.scale)
        # Clamped rather than wrapped. A wind of 300km/h is wrong, but drawing
        # it as 45 because the byte overflowed is worse than drawing the
        # highest wind the scale can hold.
        return max(0, min(MISSING - 1, raw))

    def decode(self, raw: int) -> float | None:
        return None if raw == MISSING else raw * self.scale + self.offset


# Ranges chosen from what the archipelago actually produces, with room above.
SERIES: tuple[Series, ...] = (
    # 0..5080m in 20m steps: the ladder tops out at 3000m and the levels near
    # the summits are 500m apart.
    Series("deck_base_m", 20.0, 0.0),
    Series("deck_top_m", 20.0, 0.0),
    # 0..1 in half-percent steps.
    Series("cloud_at_summit", 0.005, 0.0),
    # -25C to +38C in quarter degrees. Madeira's summits go below zero in
    # winter and the coast does not reach thirty-nine.
    Series("temperature_c", 0.25, -25.0),
    # 0..127km/h in half-km steps.
    Series("wind_kmh", 0.5, 0.0),
    # Aerosol optical depth, 0..2.54 in hundredths. Clean air here is near
    # 0.10 and a heavy calima is past 1.0, so hundredths is finer than the
    # model's own disagreement about the number.
    Series("aod", 0.01, 0.0),
)


@dataclass(frozen=True)
class SpotHours:
    """The whole grid of it: [spot][series][hour], one byte each."""

    spot_ids: tuple[str, ...]
    t0: datetime
    count: int
    values: bytes

    @property
    def stride(self) -> int:
        """Bytes per spot."""
        return len(SERIES) * self.count


def encode(
    spot_ids: Sequence[str],
    t0: datetime,
    count: int,
    columns: dict[str, dict[str, Sequence[float | None]]],
) -> SpotHours:
    """Pack `columns[spot_id][series_name]` into one blob.

    A spot with no forecast is not dropped from the layout - it is written as a
    run of MISSING - because the index a reader computes from a spot's position
    has to stay valid whether or not that particular fetch succeeded.
    """
    payload = bytearray()
    for spot_id in spot_ids:
        spot = columns.get(spot_id, {})
        for series in SERIES:
            samples = spot.get(series.name, ())
            if samples and len(samples) != count:
                raise ValueError(
                    f"{spot_id}/{series.name}: {len(samples)} samples for {count} hours"
                )
            if not samples:
                payload += bytes([MISSING]) * count
                continue
            payload += bytes(series.encode(value) for value in samples)

    return SpotHours(
        spot_ids=tuple(spot_ids),
        t0=t0,
        count=count,
        values=bytes(payload),
    )


def header(hours: SpotHours, generated_at: datetime) -> dict:
    """What travels inside conditions.json to describe the blob beside it."""
    return {
        "file": "spot-hours.bin",
        "generated_at": generated_at.astimezone(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "t0": hours.t0.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "step_h": 1,
        "count": hours.count,
        # Order is the index. A reader finds a spot's block by its position
        # here, so this list and the blob are one artefact.
        "spots": list(hours.spot_ids),
        "series": [
            {"name": series.name, "scale": series.scale, "offset": series.offset}
            for series in SERIES
        ],
        "missing": MISSING,
        "bytes": len(hours.values),
    }


def value_at(
    hours: SpotHours, spot_id: str, series_name: str, when: datetime
) -> float | None:
    """One number, for the tests and the dry run. The web side has its own."""
    if spot_id not in hours.spot_ids:
        return None
    series_index = next(
        (index for index, s in enumerate(SERIES) if s.name == series_name), None
    )
    if series_index is None:
        return None

    elapsed = when.astimezone(timezone.utc) - hours.t0
    index = round(elapsed / timedelta(hours=1))
    if index < 0 or index >= hours.count:
        return None

    spot_index = hours.spot_ids.index(spot_id)
    at = spot_index * hours.stride + series_index * hours.count + index
    return SERIES[series_index].decode(hours.values[at])
