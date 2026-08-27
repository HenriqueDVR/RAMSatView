import pytest

from ingest.scoring.calima import (
    CLEAN_AOD,
    HEAVY_AOD,
    assess,
    severity_of,
    worst,
)
from ingest.sources.openmeteo_air import OpenMeteoAir
from ingest.spots import by_type, load_spots


def test_clean_maritime_air_costs_nothing():
    """Madeira's ordinary sky. The score has to come out exactly as it did
    before dust was ingested at all, or every clear morning quietly drops."""
    calm = assess(0.10, 0.0)
    assert calm.clarity == 1.0
    assert calm.severity == "none"
    assert calm.reasons == ()


def test_unknown_is_not_clean():
    """A missing reading must not be published as clear air the model never
    saw. It says nothing and changes nothing."""
    unknown = assess(None)
    assert unknown.clarity == 1.0
    assert unknown.reasons == ()
    assert not unknown.known


def test_a_heavy_calima_takes_most_of_the_view():
    heavy = assess(1.2, 240.0)
    assert heavy.severity == "heavy"
    assert heavy.clarity < 0.3
    assert [r["code"] for r in heavy.reasons] == ["air.heavy", "air.dust"]
    # The number people recognise from air-quality warnings earns its place,
    # as its own reason: a template cannot take an optional placeholder, and a
    # suffix would have been dropped without anybody noticing.
    assert heavy.reasons[1]["vars"]["dust"] == 240


def test_the_haze_deepens_with_the_dust():
    """Monotonic, which is the one property of the curve worth pinning. The
    constant in it is a first guess; the shape is not."""
    values = [assess(aod).clarity for aod in (0.1, 0.3, 0.5, 0.8, 1.2)]
    assert values == sorted(values, reverse=True)
    assert values[0] == 1.0


def test_surface_dust_alone_does_not_invent_a_haze():
    """The column is what hazes a summit view. Surface dust is corroboration
    and gets a mention, never a score of its own."""
    assert assess(None, 300.0).clarity == 1.0


def test_severity_thresholds_are_ordered():
    assert severity_of(CLEAN_AOD) == "none"
    assert severity_of(HEAVY_AOD) == "heavy"
    assert severity_of(HEAVY_AOD + 1) == "heavy"


def test_the_worst_hour_wins_a_window():
    """Averaging would let a clear hour either side of a plume hide it, and
    the plume is the thing worth being told about."""
    window = [assess(0.1), assess(0.9), assess(0.12)]
    assert worst(window).severity == "heavy"


def test_a_window_with_nothing_measured_says_nothing():
    assert worst([assess(None), assess(None)]).reasons == ()
    assert worst([]).clarity == 1.0


# --- the source -----------------------------------------------------------


def test_the_request_asks_for_every_spot_at_once():
    spots = load_spots()
    params = OpenMeteoAir().build_params(spots, past_days=7, forecast_days=3)
    assert params["latitude"].count(",") == len(spots) - 1
    assert params["past_days"] == 7
    assert "aerosol_optical_depth" in params["hourly"]


def test_a_location_count_mismatch_is_refused():
    """The response is positional. One location short and every spot after it
    is reading another spot's air."""
    spots = by_type(load_spots(), "viewpoint")
    with pytest.raises(ValueError, match="returned 1 locations"):
        OpenMeteoAir.parse(spots, {"hourly": {"time": []}})


def test_missing_values_stay_missing():
    spots = by_type(load_spots(), "viewpoint")[:1]
    parsed = OpenMeteoAir.parse(
        spots,
        {
            "hourly": {
                "time": [1756252800, 1756256400],
                "aerosol_optical_depth": [0.18, None],
                "dust": [None, 12.0],
            }
        },
    )
    hours = parsed[spots[0].id].hours
    assert hours[0].aod == 0.18
    assert hours[0].dust_ug_m3 is None
    assert hours[1].aod is None
    assert assess(hours[1].aod).clarity == 1.0
