"""Tests for beach scoring, with emphasis on the IPMA warning gate.

No Madeira warnings were active when the fixtures were captured, so the gate is
exercised with synthetic warnings. That path is the one with real safety
consequences, so it gets the most coverage here.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from ingest.scoring.beach import (
    COLD_SST_C,
    sea_state,
    score_beach,
    sst_comfort,
    uv_for,
    wind_factor,
)
from ingest.sources.base import MarineForecast, MarineHour, OfficialStatus
from ingest.sources.ipma import FUNCHAL, PORTO_SANTO, active_warnings, severity_of
from ingest.sources.openmeteo_marine import OpenMeteoMarine
from ingest.spots import Spot, by_type, load_spots

FIXTURES = Path(__file__).parent / "fixtures"
DAY = date(2026, 8, 26)

BEACH = Spot(
    id="test-beach",
    type="beach",
    name_pt="Praia",
    name_en="Beach",
    lat=33.0567,
    lon=-16.3383,
    elevation_m=0,
    ipma_area="MPS",
    swell_sensitivity=1.0,
)


def make_marine(sst=24.0, wave=0.4, swell=0.3, period=8.0) -> MarineForecast:
    hours = tuple(
        MarineHour(
            time=datetime(2026, 8, 26, hour, tzinfo=timezone.utc),
            sst_c=sst,
            wave_height_m=wave,
            wave_period_s=period,
            wave_direction_deg=310.0,
            swell_height_m=swell,
        )
        for hour in range(24)
    )
    return MarineForecast(
        spot_id=BEACH.id,
        source="test",
        issued_at=datetime(2026, 8, 26, tzinfo=timezone.utc),
        hours=hours,
    )


def make_status(*warnings: dict) -> OfficialStatus:
    return OfficialStatus(
        source="ipma",
        issued_at=datetime(2026, 8, 26, tzinfo=timezone.utc),
        warnings=tuple(warnings),
        uv_index={FUNCHAL: 9.0, PORTO_SANTO: 8.9},
    )


def warning(level="yellow", area="MPS", type_="Agitacao Maritima") -> dict:
    return {
        "area": area,
        "type": type_,
        "level": level,
        "severity": severity_of(level),
        "text": "Ondas de noroeste com 4 a 5 metros.",
        "start": "2026-08-26T00:00:00",
        "end": "2026-08-26T23:59:00",
    }


# --- component curves -----------------------------------------------------


def test_sst_comfort_peaks_in_the_ideal_band():
    assert sst_comfort(23.0) == 1.0
    assert sst_comfort(21.0) == 1.0
    assert sst_comfort(26.0) == 1.0


def test_sst_comfort_degrades_below_the_ideal_band():
    assert sst_comfort(19.0) < 1.0
    assert sst_comfort(COLD_SST_C) == pytest.approx(0.25)
    assert sst_comfort(10.0) == pytest.approx(0.25)


def test_sst_comfort_barely_penalises_warm_water():
    assert sst_comfort(28.0) > 0.85


def test_sst_comfort_is_neutral_when_unknown():
    assert sst_comfort(None) == 0.5


def test_sea_state_is_calm_below_threshold_and_zero_when_rough():
    assert sea_state(0.4, 0.3, 1.0) == 1.0
    assert sea_state(2.5, 2.0, 1.0) == 0.0


def test_sea_state_uses_the_larger_of_wave_and_swell():
    assert sea_state(0.4, 1.6, 1.0) < sea_state(0.4, 0.3, 1.0)


def test_swell_sensitivity_penalises_exposed_spots():
    """The Porto Moniz pools shut in swell a sheltered bay shrugs off."""
    moderate = 1.0
    assert sea_state(moderate, moderate, 1.8) < sea_state(moderate, moderate, 0.8)


def test_wind_factor_only_bites_above_brisk():
    assert wind_factor(10.0) == 1.0
    assert wind_factor(None) == 1.0
    assert wind_factor(50.0) == pytest.approx(0.4)


# --- warning gate ---------------------------------------------------------


def test_yellow_maritime_warning_caps_an_otherwise_perfect_beach():
    perfect = score_beach(BEACH, make_marine(), DAY, wind_kmh=5.0, status=make_status())
    gated = score_beach(
        BEACH, make_marine(), DAY, wind_kmh=5.0, status=make_status(warning("yellow"))
    )
    assert perfect.score.value > 90
    assert gated.score.value <= 40


def test_red_warning_zeroes_the_score():
    gated = score_beach(
        BEACH, make_marine(), DAY, wind_kmh=5.0, status=make_status(warning("red"))
    )
    assert gated.score.value == 0.0


def test_warning_severity_ordering_is_monotonic():
    scores = [
        score_beach(
            BEACH, make_marine(), DAY, wind_kmh=5.0, status=make_status(warning(level))
        ).score.value
        for level in ("yellow", "orange", "red")
    ]
    assert scores == sorted(scores, reverse=True)


def test_warning_text_is_surfaced_as_the_first_reason():
    """The official position must lead, not be buried under our own numbers."""
    gated = score_beach(
        BEACH, make_marine(), DAY, wind_kmh=5.0, status=make_status(warning("orange"))
    )
    assert gated.score.reasons[0]["code"] == "beach.warning"


def test_warning_for_another_area_does_not_gate_this_beach():
    """A north-coast warning must not suppress a Porto Santo beach."""
    gated = score_beach(
        BEACH,
        make_marine(),
        DAY,
        wind_kmh=5.0,
        status=make_status(warning("red", area="MCN")),
    )
    assert gated.score.value > 90


def test_non_maritime_warning_does_not_gate_swimming():
    """A heat warning is not a reason to say the sea is unsafe."""
    gated = score_beach(
        BEACH,
        make_marine(),
        DAY,
        wind_kmh=5.0,
        status=make_status(warning("orange", type_="Tempo Quente")),
    )
    assert gated.score.value > 90


def test_active_warnings_respects_the_time_window():
    status = make_status(warning("yellow"))
    inside = datetime(2026, 8, 26, 13, tzinfo=timezone.utc)
    outside = datetime(2026, 8, 28, 13, tzinfo=timezone.utc)
    assert active_warnings(status, "MPS", inside)
    assert not active_warnings(status, "MPS", outside)


def test_active_warnings_sorts_most_severe_first():
    status = make_status(warning("yellow"), warning("red"))
    live = active_warnings(status, "MPS", datetime(2026, 8, 26, 13, tzinfo=timezone.utc))
    assert live[0]["level"] == "red"


# --- outlook assembly -----------------------------------------------------


def test_uv_uses_porto_santo_location_for_porto_santo_spots():
    status = make_status()
    mainland_spot = Spot(**{**BEACH.__dict__, "id": "x", "ipma_area": "MCS"})
    assert uv_for(BEACH, status) == 8.9
    assert uv_for(mainland_spot, status) == 9.0


def test_high_uv_is_flagged():
    outlook = score_beach(BEACH, make_marine(), DAY, wind_kmh=5.0, status=make_status())
    assert any(r["code"] == "beach.high_uv" for r in outlook.score.reasons)


def test_confidence_drops_when_marine_data_is_missing():
    full = score_beach(BEACH, make_marine(), DAY, status=make_status())
    empty = score_beach(
        BEACH, make_marine(sst=None, wave=None, swell=None), DAY, status=make_status()
    )
    assert empty.score.confidence < full.score.confidence


def test_confidence_is_never_absolute():
    """A three-day sea forecast is not a certainty; never claim 100%."""
    outlook = score_beach(BEACH, make_marine(), DAY, wind_kmh=5.0, status=make_status())
    assert outlook.score.confidence < 1.0


def test_confidence_decays_with_lead_time():
    marine = make_marine()
    # Extend the fixture a day so a later date has hours to score.
    later = date(2026, 8, 27)
    extended = MarineForecast(
        spot_id=BEACH.id,
        source="test",
        issued_at=marine.issued_at,
        hours=marine.hours
        + tuple(
            MarineHour(
                time=datetime(2026, 8, 27, hour, tzinfo=timezone.utc),
                sst_c=24.0,
                wave_height_m=0.4,
                wave_period_s=8.0,
                wave_direction_deg=310.0,
                swell_height_m=0.3,
            )
            for hour in range(24)
        ),
    )
    near = score_beach(BEACH, extended, DAY)
    far = score_beach(BEACH, extended, later)
    assert far.score.confidence < near.score.confidence


def test_reasons_do_not_restate_the_numbers_the_ui_already_shows():
    """Duplicated values get rounded twice and disagree with each other.

    Now that a reason is a code and its numbers, the check is that the beach
    reasons carry no numbers at all: none of them is about a value the facts
    row is already showing.
    """
    outlook = score_beach(BEACH, make_marine(), DAY, wind_kmh=5.0, status=make_status())
    for reason in outlook.score.reasons:
        if reason["code"] == "beach.warning":
            continue  # the warning's own level and type, which nothing else shows
        assert "vars" not in reason, reason


def test_returns_none_for_a_day_with_no_forecast_hours():
    assert score_beach(BEACH, make_marine(), date(2030, 1, 1)) is None


def test_works_without_any_official_status():
    """Ingest must still produce a score if IPMA is unreachable."""
    outlook = score_beach(BEACH, make_marine(), DAY, wind_kmh=5.0, status=None)
    assert outlook is not None
    assert outlook.score.value > 0


# --- golden case against captured real marine data ------------------------


@pytest.fixture(scope="module")
def real_marine():
    payload = json.loads(
        (FIXTURES / "openmeteo_marine.json").read_text(encoding="utf-8")
    )
    spots = by_type(load_spots(), "beach")
    return {s.id: s for s in spots}, OpenMeteoMarine.parse(spots, payload)


def test_golden_north_coast_is_rougher_than_sheltered_south(real_marine):
    """Seixal faces the open Atlantic; Garajau sits in the lee of the island."""
    spots, marine = real_marine
    day = marine["seixal"].hours[24].time.date()
    north = score_beach(spots["seixal"], marine["seixal"], day)
    south = score_beach(spots["garajau"], marine["garajau"], day)
    assert north.wave_height_m > south.wave_height_m


def test_golden_summer_sst_is_in_the_comfortable_band(real_marine):
    spots, marine = real_marine
    day = marine["porto-santo-beach"].hours[24].time.date()
    outlook = score_beach(
        spots["porto-santo-beach"], marine["porto-santo-beach"], day
    )
    assert 18.0 < outlook.sst_c < 28.0
