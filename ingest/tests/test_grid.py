"""The gridded cloud field: layout, ordering and the failures it must refuse.

The renderer reads this blob as a raw 3D texture with no framing bytes, so the
only thing standing between a transposed axis and cloud drawn over the wrong
island is this file.
"""

from datetime import datetime, timezone

import pytest

from ingest.sources.openmeteo_grid import (
    ALTITUDES,
    DEFAULT_GRID,
    GridSpec,
    OpenMeteoCloudGrid,
    grid_call_weight,
    header,
)

SMALL = GridSpec(west=-17.0, south=32.5, east=-16.5, north=33.0, cols=2, rows=2)

# Two hours, so a time axis mistake shows up as well as a spatial one.
TIMES = [1756166400, 1756170000]


def _cell(cover_by_level: dict[int, float]) -> dict:
    """One Open-Meteo location payload with a constant profile over both hours."""
    hourly: dict[str, list] = {"time": list(TIMES)}
    for level, cover in cover_by_level.items():
        # Rough standard-atmosphere heights, only their ordering matters here.
        height = {1000: 100.0, 950: 550.0, 925: 780.0, 900: 1000.0,
                  850: 1500.0, 800: 2000.0, 700: 3000.0}[level]
        hourly[f"geopotential_height_{level}hPa"] = [height] * len(TIMES)
        hourly[f"cloud_cover_{level}hPa"] = [cover * 100.0] * len(TIMES)
    return {"hourly": hourly}


def _clear() -> dict:
    return _cell({1000: 0.0, 950: 0.0, 925: 0.0, 900: 0.0, 850: 0.0, 800: 0.0, 700: 0.0})


def _overcast() -> dict:
    return _cell({1000: 0.0, 950: 1.0, 925: 1.0, 900: 1.0, 850: 0.0, 800: 0.0, 700: 0.0})


def test_points_run_north_west_first_row_major():
    points = list(SMALL.points())
    assert points == [
        (33.0, -17.0),
        (33.0, -16.5),
        (32.5, -17.0),
        (32.5, -16.5),
    ]


def test_default_grid_matches_the_map_bounds():
    # web/lib/map/sources.ts BOUNDS. Drift here draws the volume off the island.
    assert (
        DEFAULT_GRID.west,
        DEFAULT_GRID.south,
        DEFAULT_GRID.east,
        DEFAULT_GRID.north,
    ) == (-17.5, 32.3, -16.2, 33.2)


def test_parse_lays_the_volume_out_time_altitude_row_col():
    source = OpenMeteoCloudGrid(SMALL, session=object())
    # Only the north-east cell (row 0, col 1) is clouded.
    grid = source.parse([_clear(), _overcast(), _clear(), _clear()])

    assert len(grid.values) == grid.expected_length()
    assert len(grid.values) == len(TIMES) * len(ALTITUDES) * 4

    deck = ALTITUDES.index(750)
    assert grid.at(0, deck, 0, 1) == pytest.approx(1.0, abs=0.01)
    assert grid.at(0, deck, 0, 0) == 0.0
    assert grid.at(0, deck, 1, 1) == 0.0
    # Same field an hour later: the fixture is steady, so this catches a time
    # stride that has collapsed onto one hour.
    assert grid.at(1, deck, 0, 1) == pytest.approx(1.0, abs=0.01)


def test_parse_clears_above_the_deck_top():
    source = OpenMeteoCloudGrid(SMALL, session=object())
    grid = source.parse([_overcast()] * 4)
    assert grid.at(0, ALTITUDES.index(2000), 0, 0) == 0.0


def test_parse_refuses_a_short_payload():
    source = OpenMeteoCloudGrid(SMALL, session=object())
    with pytest.raises(ValueError, match="3 cells"):
        source.parse([_clear()] * 3)


def test_parse_refuses_a_ragged_time_axis():
    source = OpenMeteoCloudGrid(SMALL, session=object())
    ragged = _clear()
    ragged["hourly"]["time"] = TIMES[:1]
    with pytest.raises(ValueError, match="time axis"):
        source.parse([_clear(), _clear(), _clear(), ragged])


def test_build_params_sends_one_coordinate_per_cell():
    source = OpenMeteoCloudGrid(SMALL, session=object())
    params = source.build_params(past_days=2, forecast_days=3)
    assert len(params["latitude"].split(",")) == 4
    assert len(params["longitude"].split(",")) == 4
    assert params["timeformat"] == "unixtime"
    assert "cloud_cover_850hPa" in params["hourly"]


def test_header_describes_the_blob_it_ships_with():
    source = OpenMeteoCloudGrid(SMALL, session=object())
    grid = source.parse([_clear()] * 4)
    generated = datetime(2026, 8, 26, 9, 0, tzinfo=timezone.utc)
    meta = header(grid, generated)

    assert meta["file"] == "cloud-grid.bin"
    assert meta["generated_at"] == "2026-08-26T09:00:00Z"
    assert meta["cols"] == 2 and meta["rows"] == 2
    assert meta["bytes"] == len(grid.values)
    assert meta["altitudes_m"] == list(ALTITUDES)
    assert len(meta["times"]) == len(TIMES)
    assert meta["times"][0].endswith("Z")


def test_the_hourly_run_stays_inside_a_hobby_call_budget():
    # 80 cells x 14 variables x 10 days. If a level or a day is added, this is
    # the line that says what it costs before the API says it in 429s.
    # 14 variables and 10 days both sit under Open-Meteo's thresholds, so the
    # grid costs exactly one call per cell.
    assert grid_call_weight() == pytest.approx(80.0)
    # A fourteenth day, or an eighth level, is where it starts to multiply.
    assert grid_call_weight(days=28) == pytest.approx(160.0)
    # Twenty-four runs a day against a 10k/day free allowance.
    assert grid_call_weight() * 24 < 10_000
