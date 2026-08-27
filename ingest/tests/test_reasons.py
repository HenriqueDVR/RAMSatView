"""The two halves of the bilingual contract, checked against each other.

The interface chrome was translated and the sentences explaining every number
were not, so the Portuguese half of the site was explained in English. The
wording now lives on the web side and the codes live here, which only works if
neither side can add one the other cannot say.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from ingest.scoring.reasons import CODES, reason

I18N = Path(__file__).resolve().parents[2] / "web" / "lib" / "i18n.ts"


def wording(locale: str) -> dict[str, str]:
    source = I18N.read_text(encoding="utf-8")
    start = source.index(f"  {locale}: {{")
    end = source.index("\n  },", start)
    return dict(re.findall(r'"([^"]+)":\s*"([^"]*)"', source[start:end]))


@pytest.mark.parametrize("locale", ["en", "pt"])
def test_every_code_has_wording_in_both_languages(locale):
    said = wording(locale)
    missing = [code for code in CODES if f"reason.{code}" not in said]
    assert missing == [], f"{locale} cannot say: {missing}"


@pytest.mark.parametrize("locale", ["en", "pt"])
def test_no_wording_is_left_behind_for_a_code_that_is_gone(locale):
    """A stale entry is not dangerous, but it is a lie about what can appear."""
    said = wording(locale)
    orphans = [
        key[len("reason.") :]
        for key in said
        if key.startswith("reason.") and key[len("reason.") :] not in CODES
    ]
    assert orphans == []


def test_every_placeholder_is_filled_by_the_code_that_uses_it():
    """A template asking for {m} against a reason that publishes no m renders
    the brace to the reader."""
    emitted = {
        "vis.rain": {"mm"},
        "vis.cloud_above": {"pct"},
        "vis.broken_above": {"pct"},
        "wind.strong": {"kmh"},
        "sea.inside": {"pct", "m"},
        "sea.deck_below": {"m"},
        "sea.layer_above": {"m"},
        "sea.inversion": {"c"},
        "fog.in_forest": {"pct", "m"},
        "fog.patchy": {"pct"},
        "fog.rain": {"mm"},
        "colour.lid": {"pct"},
        "colour.band": {"pct"},
        "colour.some_high": {"pct"},
        "colour.mid_blocking": {"pct"},
        "air.slight": {"aod"},
        "air.noticeable": {"aod"},
        "air.heavy": {"aod"},
        "air.dust": {"dust"},
        "beach.warning": {"level", "type"},
    }
    for locale in ("en", "pt"):
        said = wording(locale)
        for code in CODES:
            template = said[f"reason.{code}"]
            wanted = set(re.findall(r"\{(\w+)\}", template))
            assert wanted == emitted.get(code, set()), f"{locale} {code}"


def test_an_unknown_code_is_refused_rather_than_published():
    with pytest.raises(ValueError, match="unknown reason code"):
        reason("sea.definitely_not_a_code")
