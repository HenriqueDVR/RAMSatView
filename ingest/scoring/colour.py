"""Will the sunrise actually be worth watching?

Every score in this project so far answers "will I see anything" - is the deck
under the summit, is the summit in cloud, is the air hazed. None of them answer
the question people actually ask, which is whether the sky will *do something*.
A cloudless dawn scores a hundred here and is, honestly, a bit dull: the sun
comes up white over a flat horizon and that is the whole event.

What makes a sunrise: high cloud, lit from underneath while the sun is still
below the horizon. Cirrus at six to twelve kilometres catches the light long
before it reaches the ground and is what turns the sky red. Too little and
there is nothing to light; too much and it is a grey lid. Thick middle cloud
kills it by blocking the light on its way up. Standing above a cloud sea makes
it better, not worse - the deck becomes a lit floor.

Two honest limits, both carried in the confidence rather than hidden:

The colour comes from light travelling hundreds of kilometres through the
atmosphere east of here, and this model can only see a box around the
archipelago. A bank of cloud sitting on the horizon out towards the Moroccan
coast will cut the whole thing off and nothing in this data would know.

And cirrus is among the least reliable fields a forecast model publishes -
thin, fast, and often wrong about timing by hours.

So the number is capped well below the confidence the deck scores carry, and
the reasons say what it is and is not.
"""

from __future__ import annotations

from dataclasses import dataclass

# Where high cloud stops being decoration and starts being a lid. The peak is
# below half deliberately: scattered cirrus lights up in bands, an even sheet
# just goes grey.
IDEAL_HIGH = 0.45

# Thick middle cloud blocks the light on its way to the cirrus. Below this it
# is part of the picture; above, it is a ceiling.
MID_TOLERANCE = 0.5

# A little haze reddens a sunrise - this is why calima mornings can look
# spectacular from sea level and show you nothing from a summit. Past the
# upper bound the dust is the story, and calima.py handles that.
HAZE_HELPS_FROM = 0.15
HAZE_HELPS_TO = 0.40
HAZE_BONUS = 1.12

# Standing above the deck, the cloud sea becomes a lit floor.
DECK_BONUS = 1.15

# What perfect cirrus alone is worth, leaving the bonuses somewhere to go.
# Without this headroom the multipliers clamped at a hundred and vanished
# exactly where they matter most: scattered cirrus over a cloud sea is the best
# thing this island does at dawn, and it scored the same as scattered cirrus
# over nothing.
PEAK = 82.0

# The ceiling on how sure this can ever be. See the module docstring: the
# light comes from outside the model's box, and cirrus is badly forecast.
MAX_CONFIDENCE = 0.55


@dataclass(frozen=True)
class Colour:
    value: float
    confidence: float
    reasons: list[str]


# Below this there is nothing up there to light at all, and above it there is
# no gap for the light to come through. A tent between them rather than a
# parabola: a parabola through zero at 0.0 still returned a fifth of full marks
# at five percent cloud, so the score said "worth getting up for" while its own
# sentence said "empty sky".
NOTHING_TO_LIGHT = 0.05
CLOSED_OVER = 0.95


def _high_term(high: float) -> float:
    """Peaks at IDEAL_HIGH, and genuinely reaches zero at both ends."""
    if high <= NOTHING_TO_LIGHT or high >= CLOSED_OVER:
        return 0.0
    if high < IDEAL_HIGH:
        return (high - NOTHING_TO_LIGHT) / (IDEAL_HIGH - NOTHING_TO_LIGHT)
    return (CLOSED_OVER - high) / (CLOSED_OVER - IDEAL_HIGH)


def score_colour(
    *,
    cloud_high: float,
    cloud_mid: float,
    summit_cover: float,
    deck_below: bool,
    aod: float | None,
    haze_clarity: float,
    base_confidence: float,
) -> Colour:
    """One hour's worth of "will the sky do something".

    `haze_clarity` comes from calima.py and is already the multiplier that
    module decided on, so heavy dust dims this the same way it dims the view -
    a sky nobody can see through is not a sunrise regardless of its colour.
    """
    reasons: list[str] = []

    if summit_cover >= 0.6:
        # Inside the cloud. Whatever the sky is doing above, you are in it.
        return Colour(
            0.0,
            min(MAX_CONFIDENCE, base_confidence),
            ["in the cloud - no sunrise to see from here"],
        )

    term = _high_term(cloud_high)
    value = PEAK * term

    # The words come from the same number the score does, so the two can never
    # disagree in front of somebody deciding whether to set an alarm.
    if term == 0.0 and cloud_high <= NOTHING_TO_LIGHT:
        reasons.append("empty sky - clear, but nothing for the light to catch")
    elif term == 0.0:
        reasons.append(
            "high cloud closed over ({:.0f}%) - a lid rather than a canvas".format(
                cloud_high * 100
            )
        )
    elif term >= 0.8:
        reasons.append(
            "high cloud at {:.0f}% - the band that lights up".format(cloud_high * 100)
        )
    else:
        reasons.append("some high cloud ({:.0f}%)".format(cloud_high * 100))

    if cloud_mid > MID_TOLERANCE:
        blocked = min(1.0, (cloud_mid - MID_TOLERANCE) / (1.0 - MID_TOLERANCE))
        value *= 1.0 - blocked
        reasons.append(
            "middle cloud ({:.0f}%) blocking the light from below".format(
                cloud_mid * 100
            )
        )

    # The bonuses are multipliers, so they are only worth saying when there is
    # something for them to multiply. "A cloud sea underneath to catch it" on a
    # score of zero reads as a reason to go.
    if deck_below and value > 0.0:
        value *= DECK_BONUS
        reasons.append("a cloud sea underneath to catch it")

    if value > 0.0 and aod is not None and HAZE_HELPS_FROM <= aod <= HAZE_HELPS_TO:
        value *= HAZE_BONUS
        reasons.append("a little dust in the air - deeper reds")

    value *= haze_clarity

    return Colour(
        round(max(0.0, min(100.0, value)), 1),
        # Never more sure than the module docstring allows.
        round(min(MAX_CONFIDENCE, base_confidence), 2),
        reasons,
    )
