"""Saharan dust, and what it does to a view.

Aerosol optical depth is the right quantity to reason from, because it is
literally a measure of how much light the air column scatters away. Clean
maritime air over Madeira sits around 0.1; a calima event lifts it to several
tenths and, in a bad one, past one.

The relationship between that number and "can I see Porto Santo from Arieiro"
is a first guess, and is written here as one rather than buried in a
coefficient. Like the tunables at the top of inversion.py it wants calibrating
against what people actually saw, and it sits in the same TODO entry.

The dust concentration is carried alongside but is not what the score is built
from: it is a surface number, and the haze that ruins a summit view is the
whole column above you. It earns its place in the wording, because micrograms
per cubic metre is what air-quality warnings speak in and people recognise it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Optical depth of clean air here. At or under this is the sky the rest of the
# model already assumes, and it costs nothing.
CLEAN_AOD = 0.12

# How hard the excess over clean bites: exp(-k * excess). At k = 1.4 an AOD of
# 0.6 keeps about half the view and a heavy 1.2 keeps a fifth. First guess,
# fitted to nothing - it is the shape that is defensible, not the constant.
HAZE_K = 1.4

# Where the wording changes. Taken from the Canaries' own calima advisories,
# which are the nearest thing to a local standard.
SLIGHT_AOD = 0.25
NOTICEABLE_AOD = 0.40
HEAVY_AOD = 0.70

# Surface dust worth naming at all, in ug/m3.
DUST_MENTION = 20.0

Severity = str  # "none" | "slight" | "noticeable" | "heavy"


@dataclass(frozen=True)
class Calima:
    """What the dust is doing at one hour, and what to say about it."""

    aod: float | None
    dust_ug_m3: float | None
    severity: Severity
    #: Multiplier on visibility, 0..1. Exactly 1.0 when there is nothing to say.
    clarity: float
    reason: str | None

    @property
    def known(self) -> bool:
        return self.aod is not None


def severity_of(aod: float) -> Severity:
    if aod >= HEAVY_AOD:
        return "heavy"
    if aod >= NOTICEABLE_AOD:
        return "noticeable"
    if aod >= SLIGHT_AOD:
        return "slight"
    return "none"


def assess(aod: float | None, dust_ug_m3: float | None = None) -> Calima:
    """One hour of dust, turned into a factor and a sentence.

    Unknown is not clean. A missing AOD returns clarity 1.0 so the score is
    exactly what it would have been before this existed, and says nothing -
    rather than reporting clear air the model never saw.
    """
    if aod is None:
        return Calima(None, dust_ug_m3, "none", 1.0, None)

    severity = severity_of(aod)
    excess = max(0.0, aod - CLEAN_AOD)
    clarity = math.exp(-HAZE_K * excess)

    if severity == "none":
        return Calima(aod, dust_ug_m3, severity, 1.0, None)

    words = {
        "slight": "slight Saharan haze",
        "noticeable": "Saharan dust hazing the view",
        "heavy": "heavy calima - the view will be gone",
    }[severity]
    reason = f"{words} (AOD {aod:.2f})"
    if dust_ug_m3 is not None and dust_ug_m3 >= DUST_MENTION:
        reason += f", dust {dust_ug_m3:.0f} ug/m3"

    return Calima(aod, dust_ug_m3, severity, clarity, reason)


def worst(hours: list[Calima]) -> Calima:
    """The hour that matters out of a window, which is the dustiest one.

    Averaging would let a clear hour either side of a plume hide it, and the
    plume is the thing worth being told about.
    """
    known = [hour for hour in hours if hour.known]
    if not known:
        return Calima(None, None, "none", 1.0, None)
    return min(known, key=lambda hour: hour.clarity)
