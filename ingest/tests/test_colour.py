import pytest

from ingest.scoring.colour import (
    IDEAL_HIGH,
    MAX_CONFIDENCE,
    score_colour,
)


def colour(**overrides):
    args = dict(
        cloud_high=IDEAL_HIGH,
        cloud_mid=0.0,
        summit_cover=0.0,
        deck_below=False,
        aod=None,
        haze_clarity=1.0,
        base_confidence=0.9,
    )
    args.update(overrides)
    return score_colour(**args)


def test_a_clear_sky_is_not_a_good_sunrise():
    """The gap this score exists to fill. A cloudless dawn scores a hundred on
    every other number in the document and is dull to stand in."""
    empty = colour(cloud_high=0.0)
    assert empty.value == 0.0
    assert "nothing for the light to catch" in empty.reasons[0]


def test_an_overcast_lid_is_not_one_either():
    closed = colour(cloud_high=1.0)
    assert closed.value == 0.0
    assert "lid" in closed.reasons[0]


def test_scattered_cirrus_is_the_best_case():
    assert colour(cloud_high=IDEAL_HIGH).value > colour(cloud_high=0.15).value
    assert colour(cloud_high=IDEAL_HIGH).value > colour(cloud_high=0.85).value


def test_the_words_never_contradict_the_number():
    """The failure this replaces: a parabola through zero still returned a
    fifth of full marks at five percent cloud, so the score said 'worth getting
    up for' while its own sentence said 'empty sky'."""
    for high in [round(0.05 * n, 2) for n in range(21)]:
        result = colour(cloud_high=high)
        says_empty = any("nothing for the light" in r for r in result.reasons)
        says_lid = any("lid" in r for r in result.reasons)
        if says_empty or says_lid:
            assert result.value == 0.0, f"{high} scores {result.value}"


def test_thick_middle_cloud_blocks_the_light_from_below():
    assert colour(cloud_mid=1.0).value == 0.0
    assert colour(cloud_mid=0.75).value < colour(cloud_mid=0.0).value
    assert any("middle cloud" in r for r in colour(cloud_mid=0.75).reasons)


def test_standing_above_the_deck_makes_it_better_not_worse():
    """The cloud sea becomes a lit floor. Every other score in this project
    treats cloud as the enemy; here it is the subject."""
    assert colour(deck_below=True).value > colour(deck_below=False).value
    assert any("cloud sea" in r for r in colour(deck_below=True).reasons)


def test_only_an_exceptional_morning_reaches_full_marks():
    """Cirrus alone leaves headroom, so the bonuses are visible rather than
    clamped away at the top of the scale."""
    assert colour().value < 100.0
    best = colour(deck_below=True, aod=0.25)
    assert best.value == 100.0


def test_inside_the_cloud_there_is_no_sunrise_at_any_price():
    fogged = colour(summit_cover=0.9, cloud_high=IDEAL_HIGH, deck_below=True)
    assert fogged.value == 0.0
    assert "in the cloud" in fogged.reasons[0]


def test_a_little_dust_deepens_it_and_a_lot_ends_it():
    assert colour(aod=0.25).value > colour(aod=None).value
    # Heavy calima arrives as a clarity multiplier from calima.py.
    assert colour(aod=1.2, haze_clarity=0.2).value < colour(aod=None).value


def test_a_bonus_is_never_claimed_on_a_score_of_zero():
    """'A cloud sea underneath to catch it' beside a zero reads as a reason to
    go."""
    empty = colour(cloud_high=0.0, deck_below=True, aod=0.25)
    assert empty.value == 0.0
    assert len(empty.reasons) == 1


def test_confidence_is_capped_however_sure_the_rest_of_the_forecast_is():
    """The light comes from hundreds of kilometres east of anything this model
    can see, and cirrus is badly forecast. Neither is hidden in the number."""
    assert colour(base_confidence=1.0).confidence == MAX_CONFIDENCE
    # And a poor forecast is not made better by the cap.
    assert colour(base_confidence=0.2).confidence == pytest.approx(0.2)


def test_every_score_carries_a_reason():
    for high in (0.0, 0.2, 0.45, 0.8, 1.0):
        assert colour(cloud_high=high).reasons
