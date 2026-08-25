"""Tests for assembly and the fail-closed publish gate.

The validation tests matter more than they look. The gate is the only thing
standing between a broken upstream feed and a confident green score on a page
someone uses to decide whether to drive up a mountain at 4am.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from ingest.build import (
    FORECAST_DAYS,
    SCHEMA_VERSION,
    ValidationError,
    assemble,
    run,
    validate,
)
from ingest.sources.openmeteo import OpenMeteoAtmosphere
from ingest.sources.openmeteo_marine import OpenMeteoMarine
from ingest.spots import by_type, load_spots


@pytest.fixture(scope="module")
def offline_document():
    spots = load_spots()
    document = run(out=None, dry_run=True, offline=True)
    return document, spots


def test_offline_build_produces_every_spot(offline_document):
    document, spots = offline_document
    assert len(document["spots"]) == len(spots)


def test_document_is_json_serialisable(offline_document):
    document, _ = offline_document
    assert json.loads(json.dumps(document))["schema_version"] == SCHEMA_VERSION


def test_viewpoints_carry_both_scores(offline_document):
    document, _ = offline_document
    viewpoints = [e for e in document["spots"] if e["type"] == "viewpoint"]
    assert viewpoints
    for entry in viewpoints:
        assert 0 < len(entry["days"]) <= FORECAST_DAYS
        for day in entry["days"]:
            assert "visibility" in day and "cloud_sea" in day


def test_beaches_carry_a_score_and_warning_list(offline_document):
    document, _ = offline_document
    beaches = [e for e in document["spots"] if e["type"] == "beach"]
    assert beaches
    for entry in beaches:
        for day in entry["days"]:
            assert "score" in day
            assert isinstance(day["warnings"], list)


def test_every_published_score_has_a_reason(offline_document):
    document, _ = offline_document
    for entry in document["spots"]:
        for day in entry["days"]:
            scores = (
                [day["visibility"], day["cloud_sea"]]
                if entry["type"] == "viewpoint"
                else [day["score"]]
            )
            assert all(s["reasons"] for s in scores)


def test_document_declares_staleness_and_attribution(offline_document):
    document, _ = offline_document
    assert document["stale_at"] > document["generated_at"]
    assert document["attribution"]


def test_fire_risk_is_declared_unavailable(offline_document):
    """IPMA publishes RCM for the mainland only - do not imply we have it."""
    document, _ = offline_document
    assert document["official"]["fire_risk_available"] is False


# --- the fail-closed gate -------------------------------------------------


def test_validate_accepts_a_good_document(offline_document):
    document, spots = offline_document
    validate(document, spots)  # must not raise


def test_validate_rejects_a_missing_spot(offline_document):
    document, spots = offline_document
    broken = {**document, "spots": document["spots"][:-1]}
    with pytest.raises(ValidationError, match="missing spots"):
        validate(broken, spots)


def test_validate_rejects_a_spot_with_no_days(offline_document):
    document, spots = offline_document
    entries = [dict(e) for e in document["spots"]]
    entries[0] = {**entries[0], "days": []}
    with pytest.raises(ValidationError, match="no forecast days"):
        validate({**document, "spots": entries}, spots)


def test_validate_rejects_an_out_of_range_score(offline_document):
    document, spots = offline_document
    entries = json.loads(json.dumps(document["spots"]))
    entry = next(e for e in entries if e["type"] == "viewpoint")
    entry["days"][0]["visibility"]["value"] = 140.0
    with pytest.raises(ValidationError, match="out of range"):
        validate({**document, "spots": entries}, spots)


def test_validate_rejects_an_out_of_range_confidence(offline_document):
    document, spots = offline_document
    entries = json.loads(json.dumps(document["spots"]))
    entry = next(e for e in entries if e["type"] == "viewpoint")
    entry["days"][0]["cloud_sea"]["confidence"] = 3.0
    with pytest.raises(ValidationError, match="confidence out of range"):
        validate({**document, "spots": entries}, spots)


def test_validate_rejects_an_unexplained_score(offline_document):
    document, spots = offline_document
    entries = json.loads(json.dumps(document["spots"]))
    entries[0]["days"][0][
        "visibility" if entries[0]["type"] == "viewpoint" else "score"
    ]["reasons"] = []
    with pytest.raises(ValidationError, match="no reasons"):
        validate({**document, "spots": entries}, spots)


def test_validate_rejects_a_document_that_is_born_stale(offline_document):
    """A rebuild of old data must not be publishable as current."""
    document, spots = offline_document
    past = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    stale = {**document, "stale_at": past.isoformat().replace("+00:00", "Z")}
    with pytest.raises(ValidationError, match="already stale"):
        validate(stale, spots)


def test_validate_rejects_a_schema_version_mismatch(offline_document):
    document, spots = offline_document
    with pytest.raises(ValidationError, match="schema_version"):
        validate({**document, "schema_version": 999}, spots)


def test_parse_rejects_a_location_count_mismatch():
    """A truncated upstream response must raise, not silently misalign spots."""
    spots = by_type(load_spots(), "viewpoint")
    payload = json.loads(
        (
            __import__("pathlib").Path("ingest/tests/fixtures/openmeteo_viewpoints.json")
        ).read_text()
    )
    with pytest.raises(ValueError, match="locations"):
        OpenMeteoAtmosphere.parse(spots, payload[:-1])


def test_marine_parse_rejects_a_location_count_mismatch():
    spots = by_type(load_spots(), "beach")
    payload = json.loads(
        (
            __import__("pathlib").Path("ingest/tests/fixtures/openmeteo_marine.json")
        ).read_text()
    )
    with pytest.raises(ValueError, match="locations"):
        OpenMeteoMarine.parse(spots, payload[:-1])
