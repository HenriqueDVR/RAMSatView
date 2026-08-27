"""Reasons as codes, so the web can say them in the reader's own language.

Every score in this document carries reasons, and they were written here as
finished English sentences. The site is bilingual and the Portuguese half was
therefore half English: the interface chrome translated, the sentences
explaining every number did not.

Translating them in Python would mean shipping both languages in the document
and picking one at build time, in a pipeline that has no business knowing what
language anybody reads. So the ingest emits what it decided and the numbers it
decided it from, and `web/lib/i18n.ts` owns the wording for both languages -
which is where all the other wording already lives.

A code is part of the published contract. Renaming one is a schema change, and
the web side falls back to showing the raw code rather than an empty line if it
ever meets one it does not know.
"""

from __future__ import annotations

# Every code this pipeline can publish. Canonical here, and checked against
# web/lib/i18n.ts by test_reasons.py, so neither side can add one the other
# cannot say. A typo used to be invisible: it would have shipped a sentence
# nobody wrote to a reader in a language nobody chose.
CODES: tuple[str, ...] = (
    # visibility from the summit
    "vis.rain",
    "vis.cloud_above",
    "vis.clear_above",
    "vis.broken_above",
    "vis.cirrus",
    # shared
    "wind.strong",
    # the cloud sea
    "sea.inside",
    "sea.deck_below",
    "sea.no_deck",
    "sea.layer_above",
    "sea.inversion",
    # Fanal, where the mist is the attraction
    "fog.in_forest",
    "fog.patchy",
    "fog.clear",
    "fog.rain",
    # will the sky do something
    "colour.empty",
    "colour.lid",
    "colour.band",
    "colour.some_high",
    "colour.mid_blocking",
    "colour.deck_floor",
    "colour.dust_reds",
    "colour.in_cloud",
    # Saharan dust
    "air.slight",
    "air.noticeable",
    "air.heavy",
    "air.dust",
    # beaches
    "beach.rough",
    "beach.calm",
    "beach.moderate_swell",
    "beach.cold_water",
    "beach.chilly_wind",
    "beach.high_uv",
    "beach.warning",
)


def reason(code: str, **vars: float | int | str) -> dict:
    """One reason: what was decided, and the numbers behind it.

    Values are rounded at the point of emission rather than in the template,
    because the rounding is a judgement about how much precision the model can
    honestly support and that judgement belongs with the model.
    """
    if code not in CODES:
        # Refused rather than published. An unknown code reaches the reader as
        # the raw string, which is a worse outcome than a failed build.
        raise ValueError(f"unknown reason code: {code}")
    return {"code": code, "vars": dict(vars)} if vars else {"code": code}
