from datetime import datetime, timedelta, timezone

import pytest

from ingest.scoring.spothours import (
    MISSING,
    SERIES,
    encode,
    header,
    value_at,
)

T0 = datetime(2026, 8, 20, 0, 0, tzinfo=timezone.utc)


def columns(**overrides) -> dict[str, list[float | None]]:
    """Three hours of every series, with the given ones replaced."""
    base = {
        "deck_base_m": [600.0, 620.0, None],
        "deck_top_m": [1400.0, 1420.0, None],
        "cloud_at_summit": [0.9, 0.05, None],
        "temperature_c": [11.4, 12.8, None],
        "wind_kmh": [18.0, 22.5, None],
    }
    base.update(overrides)
    return base


def test_a_value_survives_the_round_trip_within_its_own_step():
    hours = encode(["arieiro"], T0, 3, {"arieiro": columns()})
    assert value_at(hours, "arieiro", "deck_top_m", T0) == 1400
    assert value_at(hours, "arieiro", "temperature_c", T0) == pytest.approx(11.5, abs=0.25)
    assert value_at(hours, "arieiro", "cloud_at_summit", T0) == pytest.approx(0.9, abs=0.005)
    assert value_at(hours, "arieiro", "wind_kmh", T0 + timedelta(hours=1)) == 22.5


def test_no_deck_is_a_hole_and_not_a_zero():
    """Zero metres is a claim: fog on the ground. Absence has to survive."""
    hours = encode(["arieiro"], T0, 3, {"arieiro": columns()})
    assert value_at(hours, "arieiro", "deck_top_m", T0 + timedelta(hours=2)) is None
    # And a real zero is still a zero.
    ground = encode(["arieiro"], T0, 1, {"arieiro": {"deck_base_m": [0.0]}})
    assert value_at(ground, "arieiro", "deck_base_m", T0) == 0


def test_a_value_off_the_scale_clamps_rather_than_wrapping():
    """A 300km/h wind is wrong. Drawing it as 45 because a byte overflowed is
    worse than drawing the strongest wind the scale can hold."""
    hours = encode(["arieiro"], T0, 1, {"arieiro": {"wind_kmh": [300.0]}})
    held = value_at(hours, "arieiro", "wind_kmh", T0)
    assert held is not None
    assert held == pytest.approx(127.0, abs=0.5)


def test_a_spot_with_no_forecast_still_holds_its_place():
    """The index is computed from a spot's position, so the layout cannot move
    just because one fetch failed."""
    hours = encode(["arieiro", "fanal"], T0, 3, {"arieiro": columns()})
    assert len(hours.values) == 2 * len(SERIES) * 3
    assert value_at(hours, "fanal", "deck_top_m", T0) is None
    assert value_at(hours, "arieiro", "deck_top_m", T0) == 1400


def test_a_series_of_the_wrong_length_is_refused():
    with pytest.raises(ValueError, match="2 samples for 3 hours"):
        encode(["arieiro"], T0, 3, {"arieiro": {"wind_kmh": [1.0, 2.0]}})


def test_reading_outside_the_published_span_finds_nothing():
    """Observation and forecast both end. Pinning the last hour in place and
    passing it off as another one is the failure mode worth refusing."""
    hours = encode(["arieiro"], T0, 3, {"arieiro": columns()})
    assert value_at(hours, "arieiro", "wind_kmh", T0 - timedelta(hours=1)) is None
    assert value_at(hours, "arieiro", "wind_kmh", T0 + timedelta(hours=3)) is None
    assert value_at(hours, "nowhere", "wind_kmh", T0) is None


def test_the_header_describes_the_blob_beside_it():
    hours = encode(["arieiro", "fanal"], T0, 3, {"arieiro": columns()})
    meta = header(hours, datetime(2026, 8, 27, 12, 0, tzinfo=timezone.utc))

    assert meta["file"] == "spot-hours.bin"
    assert meta["bytes"] == len(hours.values)
    assert meta["count"] == 3
    assert meta["step_h"] == 1
    assert meta["missing"] == MISSING
    # Order is the index: this list and the blob are one artefact.
    assert meta["spots"] == ["arieiro", "fanal"]
    assert [s["name"] for s in meta["series"]] == [s.name for s in SERIES]
    assert meta["t0"] == "2026-08-20T00:00:00Z"


def test_the_blob_is_a_byte_a_sample():
    """The whole reason this is not five JSON arrays. Ten days of fifteen spots
    has to stay in the tens of kilobytes."""
    hours = encode([f"spot-{n}" for n in range(15)], T0, 240, {})
    assert len(hours.values) == 15 * len(SERIES) * 240
    # Six channels of ten days for fifteen spots. The ceiling is the point: the
    # same thing as JSON is past sixty kilobytes, against a document meant to
    # stay under thirty-five.
    assert len(hours.values) < 25_000
