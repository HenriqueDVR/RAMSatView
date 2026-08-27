"""The satellite path: counts to kelvin, kelvin to metres, metres to bytes.

Nothing here touches the network. A global mosaic file is 7MB, which is not
something to commit, so the geometry tests build a miniature one with the same
structure and the calibration test pins the one number that cannot be derived
from structure - where the count scale actually lands - against the sea surface
temperature the pipeline already ingests.
"""

from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from ingest.scoring.cloudtop import (
    ATMOSPHERIC_DEPRESSION_K,
    CLEAR_CEILING_M,
    TOP_STEP_M,
    ObservedCloud,
    altitude_of_temperature,
    cloud_top_m,
    encode_tops,
    fuse,
    header,
    nearest_hour_levels,
)
from ingest.sources.base import AtmosphereForecast, AtmosphereHour, LevelSample
from ingest.sources.gmgsi import (
    DEFAULT_WINDOW,
    SatelliteScan,
    ScanWindow,
    brightness_temperature_k,
    crop,
    recent_keys,
)

h5py = pytest.importorskip("h5py")

UTC = timezone.utc
HOUR = datetime(2026, 8, 27, 5, tzinfo=UTC)


# --- calibration ----------------------------------------------------------


def test_count_scale_has_two_segments_meeting_at_the_break():
    warm, break_point, cold = brightness_temperature_k([0, 176, 255])
    assert warm == pytest.approx(330.0)
    assert break_point == pytest.approx(242.0)
    assert cold == pytest.approx(163.0)


def test_counts_run_up_as_the_scene_gets_colder():
    values = brightness_temperature_k([60, 80, 100, 200])
    assert list(values) == sorted(values, reverse=True)


def test_clear_ocean_lands_within_the_depression_of_the_ingested_sst():
    """The one thing the file format cannot tell us: where the scale sits.

    Over open water around Madeira the August mosaic plateaus at count 72
    across thousands of cells - that plateau is the sea surface, because
    nothing else out there is uniform over hundreds of kilometres. Open-Meteo's
    marine fixture puts the SST at 24.2-24.7C for the same water. If the count
    curve is wrong, the two disagree by tens of kelvin rather than by the few
    the humid atmosphere accounts for, and every cloud-top height downstream is
    fiction.
    """
    observed_c = float(brightness_temperature_k([72])[0]) - 273.15
    corrected_c = observed_c + ATMOSPHERIC_DEPRESSION_K
    assert 24.2 - 1.0 <= corrected_c <= 24.7 + 1.0


# --- cropping the mosaic --------------------------------------------------


def _mosaic(counts: np.ndarray, lats: np.ndarray, lons: np.ndarray) -> bytes:
    """A miniature GMGSI file: 2D coordinate arrays, one leading time axis."""
    buffer = io.BytesIO()
    with h5py.File(buffer, "w") as handle:
        data = handle.create_dataset(
            "data", data=counts[np.newaxis, :, :].astype(np.float32)
        )
        data.attrs["_FillValue"] = np.array([-9999.0], dtype=np.float32)
        handle.create_dataset(
            "lat", data=np.repeat(lats[:, np.newaxis], len(lons), axis=1)
        )
        handle.create_dataset(
            "lon", data=np.repeat(lons[np.newaxis, :], len(lats), axis=0)
        )
    return buffer.getvalue()


def _north_to_south_mosaic() -> bytes:
    lats = np.array([34.0, 33.0, 32.0, 31.0], dtype=np.float32)
    lons = np.array([-19.0, -18.0, -17.0, -16.0], dtype=np.float32)
    counts = np.arange(16, dtype=np.float32).reshape(4, 4) + 60.0
    return _mosaic(counts, lats, lons)


def test_crop_keeps_only_the_window():
    window = ScanWindow(west=-18.5, south=31.5, east=-16.5, north=33.5)
    scan = crop(_north_to_south_mosaic(), window, HOUR, "key")

    assert scan.lats == (33.0, 32.0)
    assert scan.lons == (-18.0, -17.0)
    assert scan.bbox() == (-18.0, 32.0, -17.0, 33.0)


def test_crop_returns_rows_north_first_even_if_the_file_is_flipped():
    lats = np.array([31.0, 32.0, 33.0, 34.0], dtype=np.float32)  # south first
    lons = np.array([-19.0, -18.0, -17.0, -16.0], dtype=np.float32)
    counts = np.zeros((4, 4), dtype=np.float32) + 60.0
    counts[2, 1] = 200.0  # the window's northern row, last in this file

    window = ScanWindow(west=-18.5, south=31.5, east=-16.5, north=33.5)
    scan = crop(_mosaic(counts, lats, lons), window, HOUR, "key")

    assert scan.lats == (33.0, 32.0)
    # The cold cell has to come back in row 0, the northern one.
    assert scan.temperatures_k[0, 0] == pytest.approx(218.0)


def test_crop_turns_the_fill_value_into_a_hole_not_a_temperature():
    lats = np.array([34.0, 33.0, 32.0, 31.0], dtype=np.float32)
    lons = np.array([-19.0, -18.0, -17.0, -16.0], dtype=np.float32)
    counts = np.zeros((4, 4), dtype=np.float32) + 60.0
    counts[1, 1] = -9999.0

    window = ScanWindow(west=-18.5, south=31.5, east=-16.5, north=33.5)
    scan = crop(_mosaic(counts, lats, lons), window, HOUR, "key")

    assert np.isnan(scan.temperatures_k[0, 0])
    assert not np.isnan(scan.temperatures_k[1, 1])


def test_crop_refuses_a_window_the_mosaic_does_not_cover():
    window = ScanWindow(west=140.0, south=-40.0, east=150.0, north=-30.0)
    with pytest.raises(ValueError, match="does not cover"):
        crop(_north_to_south_mosaic(), window, HOUR, "key")


def test_default_window_matches_the_map_bounds():
    # web/lib/map/sources.ts BOUNDS, and openmeteo_grid.DEFAULT_GRID.
    assert (
        DEFAULT_WINDOW.west,
        DEFAULT_WINDOW.south,
        DEFAULT_WINDOW.east,
        DEFAULT_WINDOW.north,
    ) == (-17.5, 32.3, -16.2, 33.2)


# --- listing --------------------------------------------------------------


class _FakeS3:
    """Answers the bucket listing from a set of hours that exist."""

    LISTING = (
        '<?xml version="1.0"?>'
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        "{contents}</ListBucketResult>"
    )

    def __init__(self, published: set[str]):
        self.published = published
        self.asked: list[str] = []

    def get(self, url, params=None, timeout=None):
        prefix = params["prefix"]
        self.asked.append(prefix)
        contents = ""
        if prefix in self.published:
            contents = f"<Contents><Key>{prefix}GLOBCOMPLIR_v3r0.nc</Key></Contents>"
        return _FakeResponse(self.LISTING.format(contents=contents).encode())


class _FakeResponse:
    def __init__(self, content: bytes):
        self.content = content

    def raise_for_status(self):
        return None


def _prefix(hours_back: int) -> str:
    """Prefix for an hour counted back from 11:00, the newest hour NOW allows."""
    when = datetime(2026, 8, 27, 11, tzinfo=UTC) - timedelta(hours=hours_back)
    return when.strftime("GMGSI_LW/%Y/%m/%d/%H/")


def test_recent_keys_returns_the_newest_hours_oldest_first():
    session = _FakeS3({_prefix(back) for back in range(0, 8)})
    found = recent_keys(
        session, 3, now=datetime(2026, 8, 27, 12, tzinfo=UTC), stride_hours=1
    )

    times = [when for when, _ in found]
    assert times == sorted(times)
    # 45 minutes of publish lag means 11:15, so the newest full hour is 11:00.
    assert times[-1] == datetime(2026, 8, 27, 11, tzinfo=UTC)
    assert len(found) == 3


def test_recent_keys_steps_back_by_the_stride():
    """The newest scan is always kept; the rest are spaced, not consecutive."""
    session = _FakeS3({_prefix(back) for back in range(0, 12)})
    found = recent_keys(
        session, 3, now=datetime(2026, 8, 27, 12, tzinfo=UTC), stride_hours=3
    )

    assert [when.hour for when, _ in found] == [5, 8, 11]


def test_recent_keys_skips_an_hour_the_mosaic_missed():
    published = {_prefix(back) for back in range(0, 8)} - {_prefix(1)}
    session = _FakeS3(published)
    found = recent_keys(
        session, 3, now=datetime(2026, 8, 27, 12, tzinfo=UTC), stride_hours=1
    )

    hours = [when.hour for when, _ in found]
    assert 10 not in hours  # the missing one, not silently substituted
    assert hours == [8, 9, 11]


# --- brightness temperature to altitude -----------------------------------


def _levels(*points: tuple[float, float]) -> tuple[LevelSample, ...]:
    return tuple(
        LevelSample(
            pressure_hpa=1000 - index * 50,
            height_m=height,
            cloud_cover=0.0,
            temperature_c=temperature,
        )
        for index, (height, temperature) in enumerate(points)
    )


TRADE_WIND = _levels(
    (100.0, 21.0),
    (600.0, 17.0),
    (1200.0, 13.0),
    # The inversion: warmer at 1600m than at 1200m, which is what makes the
    # temperature-to-altitude mapping ambiguous in the first place.
    (1600.0, 16.0),
    (2200.0, 12.0),
    (3000.0, 6.0),
)


def test_altitude_under_an_inversion_takes_the_lower_of_two_answers():
    # 13C occurs at 1200m on the way up and again above 2000m past the
    # inversion. A stratocumulus top is the lower one.
    assert altitude_of_temperature(TRADE_WIND, 13.0) == pytest.approx(1200.0, abs=1)


def test_altitude_extrapolates_above_the_top_of_the_profile():
    # Cirrus is far colder than the coldest level fetched; clamping to 3000m
    # would pile every high cloud onto the ceiling.
    assert altitude_of_temperature(TRADE_WIND, -20.0) > 6000.0


def test_warmer_than_the_whole_column_is_the_bottom_of_it():
    assert altitude_of_temperature(TRADE_WIND, 30.0) == pytest.approx(100.0)


def test_clear_sea_reads_as_clear_not_as_very_low_cloud():
    sea_surface_k = 21.0 - ATMOSPHERIC_DEPRESSION_K + 273.15
    assert cloud_top_m(sea_surface_k, TRADE_WIND) == 0.0


def test_a_deck_top_reads_back_at_the_altitude_it_came_from():
    deck_c = 13.0
    observed_k = deck_c - ATMOSPHERIC_DEPRESSION_K + 273.15
    assert cloud_top_m(observed_k, TRADE_WIND) == pytest.approx(1200.0, abs=25)
    assert cloud_top_m(observed_k, TRADE_WIND) > CLEAR_CEILING_M


def test_a_missing_cell_stays_missing_rather_than_becoming_clear_sky():
    assert np.isnan(cloud_top_m(float("nan"), TRADE_WIND))


def test_encoding_reserves_255_for_holes():
    encoded = encode_tops(np.array([[0.0, 1200.0, float("nan"), 20000.0]]))
    assert list(encoded) == [0, 1200 // TOP_STEP_M, 255, 254]


# --- fusing into the published blob ---------------------------------------


def _scan(time: datetime, counts: np.ndarray) -> SatelliteScan:
    return SatelliteScan(
        time=time,
        key="key",
        lats=(33.0, 32.0),
        lons=(-17.0, -16.5),
        temperatures_k=brightness_temperature_k(counts),
    )


def test_fuse_lays_the_hours_out_time_row_col():
    warm = 72.0  # clear sea
    cold = 90.0  # a deck
    first = _scan(HOUR, np.array([[warm, cold], [warm, warm]]))
    second = _scan(HOUR + timedelta(hours=1), np.array([[warm, warm], [cold, warm]]))

    observed = fuse([first, second], lambda when: TRADE_WIND)

    assert len(observed.values) == 2 * 2 * 2
    assert observed.top_m(0, 0, 1) > CLEAR_CEILING_M
    assert observed.top_m(0, 1, 0) == 0.0
    # An hour later the cloud has moved to the other cell, so a collapsed time
    # stride or a transposed row/col shows up here.
    assert observed.top_m(1, 0, 1) == 0.0
    assert observed.top_m(1, 1, 0) > CLEAR_CEILING_M


def test_fuse_refuses_scans_whose_footprints_disagree():
    first = _scan(HOUR, np.array([[72.0, 72.0], [72.0, 72.0]]))
    second = SatelliteScan(
        time=HOUR + timedelta(hours=1),
        key="key",
        lats=(34.0, 33.0),
        lons=(-17.0, -16.5),
        temperatures_k=brightness_temperature_k(np.zeros((2, 2)) + 72.0),
    )
    with pytest.raises(ValueError, match="footprint"):
        fuse([first, second], lambda when: TRADE_WIND)


def test_header_describes_exactly_what_is_in_the_blob():
    observed = fuse(
        [_scan(HOUR, np.array([[72.0, 90.0], [72.0, 72.0]]))],
        lambda when: TRADE_WIND,
    )
    meta = header(observed, HOUR)

    assert meta["bytes"] == len(observed.values)
    assert meta["rows"] * meta["cols"] * len(meta["times"]) == meta["bytes"]
    assert len(meta["lats"]) == meta["rows"]
    assert meta["lats"] == sorted(meta["lats"], reverse=True)
    assert meta["step_m"] == TOP_STEP_M


def test_top_m_reads_a_hole_as_none():
    observed = ObservedCloud(
        lats=(33.0,), lons=(-17.0,), times=(HOUR,), values=bytes([255])
    )
    assert observed.top_m(0, 0, 0) is None


# --- matching a scan to a forecast hour -----------------------------------


def _forecast(start: datetime, hours: int) -> AtmosphereForecast:
    return AtmosphereForecast(
        spot_id="pico-arieiro",
        source="test",
        issued_at=start,
        hours=tuple(
            AtmosphereHour(
                time=start + timedelta(hours=index),
                levels=TRADE_WIND,
                cloud_cover_total=0.0,
                cloud_cover_low=0.0,
                cloud_cover_mid=0.0,
                cloud_cover_high=0.0,
                precipitation_mm=0.0,
                wind_speed_10m_kmh=10.0,
            )
            for index in range(hours)
        ),
    )


def test_a_scan_from_before_the_forecast_starts_still_gets_a_profile():
    """Scans reach backwards; the per-spot forecast starts at midnight today."""
    forecast = _forecast(datetime(2026, 8, 27, 0, tzinfo=UTC), 24)
    levels = nearest_hour_levels(forecast, datetime(2026, 8, 26, 22, tzinfo=UTC))
    assert levels == TRADE_WIND


def test_no_forecast_hours_means_no_profile_rather_than_a_crash():
    forecast = _forecast(datetime(2026, 8, 27, 0, tzinfo=UTC), 0)
    assert nearest_hour_levels(forecast, HOUR) == ()
