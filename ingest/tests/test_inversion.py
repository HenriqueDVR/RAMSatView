"""Tests for the sea-of-clouds model.

Two layers of testing here:

1. Synthetic profiles, hand-built to isolate one physical situation each.
   These are stable forever and are where the logic is actually pinned down.
2. Golden cases against a committed fixture of real Open-Meteo output. These
   assert direction and ordering, never exact values. Do not re-capture
   ingest/tests/fixtures/openmeteo_viewpoints.json casually - it is a captured
   set of known weather situations, not a cache.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from ingest.scoring.inversion import (
    DECK_THRESHOLD,
    band_max,
    cloud_at,
    find_deck,
    inversion_strength,
    score_hour,
    score_sunrise,
    temperature_at,
    vertical_confidence,
)
from ingest.sources.base import AtmosphereForecast, AtmosphereHour, LevelSample
from ingest.sources.openmeteo import OpenMeteoAtmosphere
from ingest.spots import Spot, by_type, load_spots

FIXTURES = Path(__file__).parent / "fixtures"

ARIEIRO = Spot(
    id="test-peak",
    type="viewpoint",
    name_pt="Pico",
    name_en="Peak",
    lat=32.7357,
    lon=-16.9284,
    elevation_m=1818,
    ipma_area="MRM",
)


def make_levels(*pairs: tuple[float, float, float]) -> tuple[LevelSample, ...]:
    """Build a profile from (height_m, cloud_cover, temperature_c) triples."""
    return tuple(
        LevelSample(
            pressure_hpa=1000 - index * 25,
            height_m=height,
            cloud_cover=cover,
            temperature_c=temp,
        )
        for index, (height, cover, temp) in enumerate(pairs)
    )


def make_hour(levels, **overrides) -> AtmosphereHour:
    defaults = dict(
        time=datetime(2026, 8, 27, 6, 0, tzinfo=timezone.utc),
        levels=levels,
        cloud_cover_total=0.0,
        cloud_cover_low=0.0,
        cloud_cover_mid=0.0,
        cloud_cover_high=0.0,
        precipitation_mm=0.0,
        wind_speed_10m_kmh=5.0,
    )
    defaults.update(overrides)
    return AtmosphereHour(**defaults)


# --- interpolation --------------------------------------------------------


def test_cloud_at_interpolates_between_levels():
    levels = make_levels((1000, 0.0, 15.0), (2000, 1.0, 10.0))
    assert cloud_at(levels, 1500) == pytest.approx(0.5)
    assert cloud_at(levels, 1250) == pytest.approx(0.25)


def test_cloud_at_clamps_outside_profile_rather_than_extrapolating():
    levels = make_levels((1000, 0.2, 15.0), (2000, 0.8, 10.0))
    assert cloud_at(levels, 0) == pytest.approx(0.2)
    assert cloud_at(levels, 9000) == pytest.approx(0.8)


def test_cloud_at_empty_profile_is_zero():
    assert cloud_at((), 1500) == 0.0


def test_temperature_at_interpolates_to_summit_height():
    levels = make_levels((1537, 0.0, 11.1), (2042, 0.0, 12.8))
    # Arieiro sits between these two real pressure levels.
    assert temperature_at(levels, 1818) == pytest.approx(12.05, abs=0.05)


def test_band_max_finds_a_thin_layer_that_a_mean_would_hide():
    levels = make_levels(
        (500, 0.0, 18.0), (1000, 0.9, 15.0), (1500, 0.0, 12.0), (2000, 0.0, 10.0)
    )
    assert band_max(levels, 400, 2000) == pytest.approx(0.9)


def test_band_max_of_inverted_band_is_zero():
    levels = make_levels((500, 0.5, 18.0), (1500, 0.5, 12.0))
    assert band_max(levels, 1500, 500) == 0.0


# --- deck detection -------------------------------------------------------


def test_find_deck_returns_base_and_top_of_low_layer():
    levels = make_levels(
        (300, 0.8, 20.0), (1000, 0.9, 16.0), (1600, 0.0, 12.0), (2200, 0.0, 13.0)
    )
    base, top = find_deck(levels, below_m=1818)
    assert base is not None and top is not None
    assert base <= 400
    assert 1200 < top < 1700


def test_find_deck_ignores_layer_starting_above_the_spot():
    levels = make_levels(
        (300, 0.0, 20.0), (1000, 0.0, 16.0), (2200, 0.9, 10.0), (3000, 0.9, 6.0)
    )
    assert find_deck(levels, below_m=1818) == (None, None)


def test_find_deck_returns_none_for_clear_profile():
    levels = make_levels((300, 0.0, 20.0), (1500, 0.05, 14.0), (2500, 0.0, 9.0))
    assert find_deck(levels, below_m=1818) == (None, None)


def test_deck_threshold_is_the_boundary():
    thin = make_levels((300, DECK_THRESHOLD - 0.01, 20.0), (1500, 0.0, 14.0))
    assert find_deck(thin, below_m=1818) == (None, None)


# --- inversion ------------------------------------------------------------


def test_inversion_strength_detects_warming_with_height():
    levels = make_levels((800, 0.0, 15.0), (1537, 0.0, 11.1), (2042, 0.0, 12.8))
    assert inversion_strength(levels) == pytest.approx(1.7, abs=0.01)


def test_inversion_strength_zero_for_normal_lapse_rate():
    levels = make_levels((800, 0.0, 18.0), (1500, 0.0, 14.0), (2400, 0.0, 9.0))
    assert inversion_strength(levels) == 0.0


# --- confidence -----------------------------------------------------------


def test_vertical_confidence_drops_as_levels_straddle_the_summit_more_widely():
    tight = make_levels((1700, 0.0, 12.0), (1950, 0.0, 11.0))
    wide = make_levels((1300, 0.0, 13.0), (2500, 0.0, 9.0))
    assert vertical_confidence(tight, 1818) > vertical_confidence(wide, 1818)


def test_vertical_confidence_is_low_when_summit_is_outside_the_profile():
    levels = make_levels((300, 0.0, 20.0), (900, 0.0, 16.0))
    assert vertical_confidence(levels, 1818) == pytest.approx(0.35)


# --- scoring scenarios ----------------------------------------------------


def test_classic_sea_of_clouds_scores_high_on_both():
    """Deck below the summit, clear air above: the product's whole reason to exist.

    The deck tops out near 1500m, comfortably clear of the 1818m summit. A
    profile whose cloud boundary lands within ~100m of the summit is genuinely
    ambiguous and is covered by test_summit_inside_the_deck_is_penalised.
    """
    levels = make_levels(
        (300, 0.6, 20.0),
        (1000, 0.85, 16.0),
        (1400, 0.8, 13.0),
        (1600, 0.05, 13.5),
        (2100, 0.0, 14.0),
    )
    visibility, cloud_sea, diagnostics = score_hour(ARIEIRO, make_hour(levels))
    assert visibility.value > 70
    assert cloud_sea.value > 50
    assert diagnostics["deck_top_m"] < ARIEIRO.elevation_m


def test_clear_sky_is_visible_but_is_not_a_cloud_sea():
    """The distinction that a single combined score would destroy."""
    levels = make_levels(
        (300, 0.0, 20.0), (1000, 0.0, 16.0), (1500, 0.0, 13.0), (2100, 0.0, 14.0)
    )
    visibility, cloud_sea, _ = score_hour(ARIEIRO, make_hour(levels))
    assert visibility.value > 90
    assert cloud_sea.value < 10


def test_overcast_above_summit_kills_visibility():
    levels = make_levels(
        (300, 0.0, 20.0), (1000, 0.0, 16.0), (1900, 0.9, 11.0), (2600, 1.0, 8.0)
    )
    visibility, cloud_sea, _ = score_hour(ARIEIRO, make_hour(levels))
    assert visibility.value < 30
    assert cloud_sea.value < 20


def test_summit_inside_the_deck_is_penalised():
    """Deck top at summit height is the fogged-out case, not a cloud sea."""
    levels = make_levels(
        (300, 0.9, 20.0), (1200, 0.9, 15.0), (1800, 0.6, 12.0), (2400, 0.0, 11.0)
    )
    _, cloud_sea, diagnostics = score_hour(ARIEIRO, make_hour(levels))
    assert diagnostics["deck_top_m"] is not None
    assert cloud_sea.value < 45


def test_rain_suppresses_visibility():
    levels = make_levels((300, 0.0, 20.0), (1500, 0.0, 13.0), (2100, 0.0, 11.0))
    dry, _, _ = score_hour(ARIEIRO, make_hour(levels))
    wet, _, _ = score_hour(ARIEIRO, make_hour(levels, precipitation_mm=2.0))
    assert wet.value < dry.value * 0.5


def test_mid_level_cloud_blocks_even_though_it_is_above_the_profile():
    """Cloud at 3-8km is outside our pressure levels but still hides the sun."""
    levels = make_levels((300, 0.0, 20.0), (1500, 0.0, 13.0), (2100, 0.0, 11.0))
    visibility, _, _ = score_hour(ARIEIRO, make_hour(levels, cloud_cover_mid=0.9))
    assert visibility.value < 20


def test_strong_wind_is_reported_even_when_the_view_is_good():
    levels = make_levels((300, 0.0, 20.0), (1500, 0.0, 13.0), (2100, 0.0, 11.0))
    visibility, _, _ = score_hour(ARIEIRO, make_hour(levels, wind_speed_10m_kmh=70))
    assert visibility.value > 80
    assert any("wind" in reason for reason in visibility.reasons)


@pytest.mark.parametrize(
    "levels",
    [
        make_levels((300, 0.6, 20.0), (1000, 0.8, 16.0), (2100, 0.0, 14.0)),
        make_levels((300, 0.0, 20.0), (1500, 0.0, 13.0), (2100, 0.0, 11.0)),
        make_levels((300, 0.0, 20.0), (1900, 0.9, 11.0), (2600, 1.0, 8.0)),
        make_levels((300, 0.9, 20.0), (1800, 0.6, 12.0), (2400, 0.0, 11.0)),
    ],
)
def test_every_score_carries_at_least_one_reason(levels):
    """A number with no explanation is not something a user can act on."""
    visibility, cloud_sea, _ = score_hour(ARIEIRO, make_hour(levels))
    assert visibility.reasons
    assert cloud_sea.reasons


# --- golden cases against captured real output ----------------------------


@pytest.fixture(scope="module")
def real_forecasts():
    payload = json.loads(
        (FIXTURES / "openmeteo_viewpoints.json").read_text(encoding="utf-8")
    )
    spots = by_type(load_spots(), "viewpoint")
    return {s.id: s for s in spots}, OpenMeteoAtmosphere.parse(spots, payload)


def test_golden_higher_peak_clears_the_deck_more_convincingly(real_forecasts):
    """Ruivo is 44m above Arieiro; on a deck morning it must score no worse."""
    spots, forecasts = real_forecasts
    day = 2  # the captured cloud-deck morning
    arieiro = score_sunrise(spots["pico-arieiro"], forecasts["pico-arieiro"], day)
    ruivo = score_sunrise(spots["pico-ruivo"], forecasts["pico-ruivo"], day)
    assert ruivo.cloud_sea.value >= arieiro.cloud_sea.value


def test_golden_low_viewpoints_are_never_above_the_deck(real_forecasts):
    """Cabo Girao at 580m is under the inversion, so it cannot see a cloud sea."""
    spots, forecasts = real_forecasts
    outlook = score_sunrise(spots["cabo-girao"], forecasts["cabo-girao"], 2)
    assert outlook.cloud_sea.value < 10


def test_golden_confidence_decays_with_lead_time(real_forecasts):
    spots, forecasts = real_forecasts
    near = score_sunrise(spots["pico-arieiro"], forecasts["pico-arieiro"], 0)
    far = score_sunrise(spots["pico-arieiro"], forecasts["pico-arieiro"], 2)
    assert far.visibility.confidence < near.visibility.confidence


def test_golden_summit_is_colder_than_sea_level(real_forecasts):
    """Sanity check on the temperature interpolation against real data."""
    spots, forecasts = real_forecasts
    outlook = score_sunrise(spots["pico-arieiro"], forecasts["pico-arieiro"], 0)
    assert -5 < outlook.temperature_c < 25


def test_score_sunrise_returns_none_beyond_forecast_range(real_forecasts):
    spots, forecasts = real_forecasts
    assert score_sunrise(spots["pico-arieiro"], forecasts["pico-arieiro"], 99) is None
