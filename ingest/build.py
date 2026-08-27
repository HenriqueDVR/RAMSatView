"""Pipeline orchestrator: fetch, score, validate, emit conditions.json.

Run hourly from CI. The contract with the web app is the JSON file this
produces, and the contract with users is that a stale or partial file is never
published. Every failure path here raises rather than degrading quietly - a
confident-looking green score built from yesterday's data is worse than an
outage, because the user drives an hour up a mountain on the strength of it.

Usage:
    python -m ingest.build --dry-run       # live fetch, print, write nothing
    python -m ingest.build --out dist/conditions.json
    python -m ingest.build --offline       # rebuild from committed fixtures
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ingest.scoring.beach import score_beach
from ingest.scoring.cloudtop import ObservedCloud, fuse, nearest_hour_levels
from ingest.scoring.cloudtop import header as observed_header
from ingest.scoring.spothours import SpotHours
from ingest.scoring.spothours import encode as spothours_encode
from ingest.scoring.spothours import header as spothours_header
from ingest.scoring.inversion import (
    Score,
    cloud_at,
    find_deck,
    score_sunrise,
    temperature_at,
)
from ingest.sources.base import AtmosphereForecast, OfficialStatus
from ingest.sources.gmgsi import GmgsiLongwave
from ingest.sources.ipma import IPMA, active_warnings
from ingest.scoring.calima import Calima
from ingest.scoring.colour import score_colour
from ingest.scoring.calima import assess as assess_calima
from ingest.scoring.calima import worst as worst_calima
from ingest.sources.base import AirForecast
from ingest.sources.openmeteo import OpenMeteoAtmosphere
from ingest.sources.openmeteo_air import OpenMeteoAir
from ingest.sources.openmeteo_grid import (
    ALTITUDES,
    CloudGrid,
    OpenMeteoCloudGrid,
)
from ingest.sources.openmeteo_grid import header as grid_header
from ingest.sources.openmeteo_marine import OpenMeteoMarine
from ingest.spots import REPO_ROOT, Spot, by_type, load_spots

# 3: every spot carries its own hourly series, so the readouts follow the
# scrubber instead of staying on the day summary while the map moves.
SCHEMA_VERSION = 3
FORECAST_HOURS = 72
FORECAST_DAYS = 3

# How far back the gridded volume reaches. The scrubber runs backwards as well
# as forwards, and a week is what Open-Meteo serves from the forecast endpoint
# without moving to the archive API, which lags by days.
GRID_PAST_DAYS = 7

# How many satellite scans to fetch. They are three hours apart, so this is
# the last full day of observation; see gmgsi.STRIDE_HOURS for why not hourly.
OBSERVED_SCANS = 9

# How long a published file may be trusted. The web app must show a staleness
# badge past this and refuse to present scores as current. Generous relative to
# the hourly cron so a single failed run does not blank the site.
FRESHNESS = timedelta(hours=6)

FIXTURES = REPO_ROOT / "ingest" / "tests" / "fixtures"


# --- serialisation --------------------------------------------------------


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _score(score) -> dict:
    return {
        "value": score.value,
        "confidence": score.confidence,
        "reasons": list(score.reasons),
    }


def _daily_wind(forecast: AtmosphereForecast | None, day) -> float | None:
    """Mean daytime 10m wind, used to temper beach scores.

    Optional: wind only tempers an existing score, so a beach whose atmosphere
    fetch failed still publishes rather than disappearing from the document.
    """
    if forecast is None:
        return None
    hours = [
        h for h in forecast.hours if h.time.date() == day and 10 <= h.time.hour <= 17
    ]
    if not hours:
        return None
    return sum(h.wind_speed_10m_kmh for h in hours) / len(hours)


def _round(value: float | None, places: int) -> float | None:
    return None if value is None else round(value, places)


def build_hours(
    spot: Spot,
    forecast: AtmosphereForecast | None,
    air: AirForecast | None = None,
) -> tuple[datetime, dict[str, list[float | None]]] | None:
    """The spot's own numbers, hour by hour, as columns ready to be quantised.

    Scalars only. A full profile per hour per spot would duplicate what
    cloud-grid.bin already carries one byte to the cell, and the sidebar has
    never drawn more than these five numbers.
    """
    if forecast is None or not forecast.hours:
        return None

    hours = sorted(forecast.hours, key=lambda hour: hour.time)
    columns: dict[str, list[float | None]] = {
        "deck_base_m": [],
        "deck_top_m": [],
        "cloud_at_summit": [],
        "temperature_c": [],
        "wind_kmh": [],
        "aod": [],
    }

    # Matched by clock, not by index: air quality is a separate request to a
    # separate model and there is no promise its hours line up with the
    # atmosphere's.
    dust_at = {hour.time: hour.aod for hour in (air.hours if air else ())}

    for hour in hours:
        # Below the summit, the same bound `score_hour` uses: a deck that
        # starts above the viewpoint is not a deck you stand over.
        base, top = find_deck(hour.levels, below_m=spot.elevation_m)
        columns["deck_base_m"].append(base)
        columns["deck_top_m"].append(top)
        columns["cloud_at_summit"].append(
            cloud_at(hour.levels, spot.elevation_m) if hour.levels else None
        )
        columns["temperature_c"].append(
            temperature_at(hour.levels, spot.elevation_m) if hour.levels else None
        )
        columns["wind_kmh"].append(hour.wind_speed_10m_kmh)
        columns["aod"].append(dust_at.get(hour.time))

    return hours[0].time, columns


def _calima_for(
    air: AirForecast | None, sunrise: datetime, window_h: float = 1.5
) -> Calima:
    """The dust over the sunrise window, matched by clock.

    Air quality is a separate request to a separate model, so its hours are
    matched to the sunrise rather than assumed to line up by index. The worst
    hour in the window wins - a clear hour either side of a plume would
    otherwise hide the plume, and the plume is the thing worth being told.
    """
    if air is None:
        return assess_calima(None)
    span = timedelta(hours=window_h)
    return worst_calima(
        [
            assess_calima(hour.aod, hour.dust_ug_m3)
            for hour in air.hours
            if abs(hour.time - sunrise) <= span
        ]
    )


def build_viewpoint(
    spot: Spot, forecast: AtmosphereForecast, air: AirForecast | None = None
) -> dict:
    days = []
    for index in range(FORECAST_DAYS):
        outlook = score_sunrise(spot, forecast, index)
        if outlook is None:
            continue
        # Dust does not condense, so nothing in the vertical profile sees it:
        # a calima morning reads as perfectly clear right up until you are
        # standing in it looking at an orange horizon. The haze is applied to
        # visibility here, after the profile has had its say.
        calima = _calima_for(air, outlook.sunrise_utc)
        visibility = outlook.visibility
        if calima.reason is not None:
            visibility = Score(
                round(visibility.value * calima.clarity, 1),
                visibility.confidence,
                [*visibility.reasons, calima.reason],
            )

        # Not "will I see anything" but "will the sky do something", which is
        # the question people actually ask and the one nothing here answered.
        # A cloudless dawn scores a hundred on every other number in this
        # document and is, honestly, dull.
        colour = score_colour(
            cloud_high=outlook.cloud_high,
            cloud_mid=outlook.cloud_mid,
            summit_cover=outlook.summit_cover,
            deck_below=(
                outlook.deck_top_m is not None
                and outlook.deck_top_m < spot.elevation_m
            ),
            aod=calima.aod,
            haze_clarity=calima.clarity,
            base_confidence=outlook.visibility.confidence,
        )

        days.append(
            {
                "date": outlook.day.isoformat(),
                "sunrise_utc": _iso(outlook.sunrise_utc),
                "visibility": _score(visibility),
                "colour": {
                    "value": colour.value,
                    "confidence": colour.confidence,
                    "reasons": colour.reasons,
                },
                "calima": {
                    "severity": calima.severity,
                    "aod": None if calima.aod is None else round(calima.aod, 3),
                    "dust_ug_m3": (
                        None
                        if calima.dust_ug_m3 is None
                        else round(calima.dust_ug_m3, 1)
                    ),
                },
                "cloud_sea": _score(outlook.cloud_sea),
                "deck_base_m": outlook.deck_base_m,
                "deck_top_m": outlook.deck_top_m,
                "inversion_c": outlook.inversion_strength_c,
                "temperature_c": outlook.temperature_c,
                "wind_kmh": outlook.wind_kmh,
                "precipitation_mm": outlook.precipitation_mm,
                # [altitude_m, cloud_fraction] pairs rather than named keys:
                # the field repeats ~30 times per day per viewpoint and the
                # document is fetched over mobile data on a mountain road.
                "profile": [[height, cover] for height, cover in outlook.profile],
            }
        )
    return {"days": days}


def build_beach(
    spot: Spot,
    marine,
    forecast: AtmosphereForecast | None,
    status: OfficialStatus | None,
) -> dict:
    days = []
    seen = sorted({hour.time.date() for hour in marine.hours})[:FORECAST_DAYS]
    for day in seen:
        outlook = score_beach(
            spot, marine, day, wind_kmh=_daily_wind(forecast, day), status=status
        )
        if outlook is None:
            continue
        days.append(
            {
                "date": outlook.day.isoformat(),
                "score": _score(outlook.score),
                "sst_c": outlook.sst_c,
                "wave_height_m": outlook.wave_height_m,
                "wave_period_s": outlook.wave_period_s,
                "wind_kmh": outlook.wind_kmh,
                "uv_index": outlook.uv_index,
                "warnings": [dict(w) for w in outlook.warnings],
            }
        )
    return {"days": days}


def _reference_levels(
    atmosphere: dict[str, AtmosphereForecast], when: datetime
):
    """One temperature profile to read the whole satellite window against.

    Any viewpoint's column will do. What the infrared conversion needs is the
    temperature of the lowest couple of kilometres of air over the ocean around
    Madeira, and every viewpoint in the file sits inside that same air mass -
    the differences between them are orographic, which is a story about where
    cloud forms, not about how warm 900hPa is.
    """
    for forecast in atmosphere.values():
        levels = nearest_hour_levels(forecast, when)
        if levels:
            return levels
    return ()


def pack_hours(
    spots: list[Spot],
    atmosphere: dict[str, AtmosphereForecast],
    air: dict[str, AirForecast] | None = None,
) -> SpotHours | None:
    """Every spot's hourly columns, on one shared clock, as one blob.

    Every series comes from the same Open-Meteo response, so they all start at
    the same hour and run the same length. This refuses rather than pads if
    that ever stops being true: a blob whose spots disagree about what hour an
    index means is worse than no blob at all, because nothing downstream could
    detect it.
    """
    columns: dict[str, dict[str, list[float | None]]] = {}
    t0: datetime | None = None
    for spot in spots:
        built = build_hours(spot, atmosphere.get(spot.id), (air or {}).get(spot.id))
        if built is None:
            continue
        t0, columns[spot.id] = built

    if not columns or t0 is None:
        return None

    lengths = {len(series["wind_kmh"]) for series in columns.values()}
    if len(lengths) != 1:
        raise ValueError(f"spots disagree about their hour count: {sorted(lengths)}")

    return spothours_encode(
        spot_ids=sorted(columns),
        t0=t0,
        count=lengths.pop(),
        columns=columns,
    )


def assemble(
    spots: list[Spot],
    atmosphere: dict[str, AtmosphereForecast],
    marine: dict,
    status: OfficialStatus | None,
    attributions: list[str],
    grid: CloudGrid | None = None,
    observed: ObservedCloud | None = None,
    hours: SpotHours | None = None,
    air: dict[str, AirForecast] | None = None,
) -> dict:
    now = datetime.now(tz=timezone.utc)
    entries = []
    for spot in spots:
        forecast = atmosphere.get(spot.id)
        # A viewpoint without a vertical profile cannot be scored at all, so it
        # is dropped here and validate() then refuses to publish the document.
        # Never let a viewpoint quietly disappear from the map.
        if forecast is None and spot.type == "viewpoint":
            continue
        base = {
            "id": spot.id,
            "type": spot.type,
            "name": {"pt": spot.name_pt, "en": spot.name_en},
            "lat": spot.lat,
            "lon": spot.lon,
            "elevation_m": spot.elevation_m,
            "ipma_area": spot.ipma_area,
            # The web side needs this to word the verdict: at Fanal "inside the
            # cloud" is the good answer, and saying so is the whole point of
            # scoring it differently.
            "fog_is_the_view": spot.fog_is_the_view,
            "notes": spot.notes,
        }
        if spot.type == "viewpoint":
            base.update(build_viewpoint(spot, forecast, (air or {}).get(spot.id)))
        else:
            spot_marine = marine.get(spot.id)
            if spot_marine is None:
                continue
            base.update(build_beach(spot, spot_marine, forecast, status))

        entries.append(base)

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": _iso(now),
        "stale_at": _iso(now + FRESHNESS),
        "attribution": attributions,
        "official": {
            "source": status.source if status else None,
            "issued_at": _iso(status.issued_at) if status else None,
            "warnings": [dict(w) for w in status.warnings] if status else [],
            "uv_index": status.uv_index if status else {},
            # IPMA publishes fire risk for the mainland only; there are no
            # Madeira municipalities in the RCM product.
            "fire_risk_available": False,
        },
        # Absent when the gridded fetch failed. The map then falls back to
        # shaping cloud from the per-spot profiles, which is the pre-volume
        # behaviour - degraded, but not wrong, so it does not fail the run.
        "cloud_grid": grid_header(grid, now) if grid is not None else None,
        # Observed cloud-top altitude from the satellite mosaic. Absent for the
        # same reason the volume can be: it is the one layer on the map that is
        # measured rather than modelled, and it would be worth showing alone -
        # but the scores do not read it, so it never fails a run.
        "cloud_observed": (
            observed_header(observed, now) if observed is not None else None
        ),
        # The per-spot hourly series, quantised beside the document rather than
        # written into it. Absent when no spot came back with a forecast, which
        # is the same condition that already stops the run.
        # The per-spot hourly series, quantised into a blob beside the document
        # rather than written into it - see scoring/spothours.py. Absent when
        # the atmosphere fetch gave nothing, and absent is survivable: the
        # readouts then fall back to the day summary, which is where they were
        # before this existed.
        "spot_hours": spothours_header(hours, now) if hours is not None else None,
        "spots": entries,
    }


# --- validation: the fail-closed gate -------------------------------------


class ValidationError(Exception):
    """Raised when the assembled document is not safe to publish."""


def _validate_profile(spot_id: str, day: dict) -> None:
    """The vertical profile is what the 3D deck is drawn from.

    An empty or unordered profile does not degrade the picture, it draws a
    wrong one - a deck at the wrong altitude looks exactly as authoritative as
    a right one. Same fail-closed rule as the scores.
    """
    profile = day.get("profile") or []
    if not profile:
        raise ValidationError(f"{spot_id} {day['date']}: empty vertical profile")
    heights = [point[0] for point in profile]
    if heights != sorted(heights) or len(set(heights)) != len(heights):
        raise ValidationError(
            f"{spot_id} {day['date']}: vertical profile not sorted by altitude"
        )
    for height, cover in profile:
        if not 0.0 <= cover <= 1.0:
            raise ValidationError(
                f"{spot_id} {day['date']}: cloud fraction out of range at {height}m"
            )


def _validate_grid(document: dict, blob_length: int | None) -> None:
    """The volume ships as raw bytes with no header of its own.

    Nothing in the blob identifies its own shape, so if the description in the
    document and the file on disk disagree the renderer reads a transposed
    volume and draws confident cloud in the wrong place. Length and identity
    are checked here; there is no second chance downstream.
    """
    meta = document.get("cloud_grid")
    if meta is None:
        return

    expected = (
        meta["cols"] * meta["rows"] * len(meta["altitudes_m"]) * len(meta["times"])
    )
    if meta["bytes"] != expected:
        raise ValidationError(
            f"cloud grid declares {meta['bytes']} bytes for a {expected}-byte volume"
        )
    if blob_length is not None and blob_length != meta["bytes"]:
        raise ValidationError(
            f"cloud grid blob is {blob_length} bytes, document says {meta['bytes']}"
        )
    if meta["altitudes_m"] != list(ALTITUDES):
        raise ValidationError("cloud grid altitude ladder does not match the renderer")
    if not meta["times"]:
        raise ValidationError("cloud grid has no time axis")
    if meta["generated_at"] != document["generated_at"]:
        # Two files, one pair. A mismatch means last run's weather is about to
        # be drawn over this run's scores.
        raise ValidationError("cloud grid and document were generated apart")


def _validate_observed(document: dict, blob_length: int | None) -> None:
    """Same contract as the volume: raw bytes, described only from here.

    An observed field is the layer people will trust most, because it is the
    one that is measured. That makes a misdescribed blob worse here than
    anywhere else in the document, not better.
    """
    meta = document.get("cloud_observed")
    if meta is None:
        return

    expected = meta["rows"] * meta["cols"] * len(meta["times"])
    if meta["bytes"] != expected:
        raise ValidationError(
            f"observed cloud declares {meta['bytes']} bytes for {expected} cells"
        )
    if blob_length is not None and blob_length != meta["bytes"]:
        raise ValidationError(
            f"observed cloud blob is {blob_length} bytes, document says {meta['bytes']}"
        )
    if len(meta["lats"]) != meta["rows"] or len(meta["lons"]) != meta["cols"]:
        raise ValidationError("observed cloud footprint does not match its shape")
    if meta["lats"] != sorted(meta["lats"], reverse=True):
        # Row 0 is north. Upside down is indistinguishable from weather.
        raise ValidationError("observed cloud rows do not run north to south")
    if not meta["times"]:
        raise ValidationError("observed cloud has no time axis")
    if meta["generated_at"] != document["generated_at"]:
        raise ValidationError("observed cloud and document were generated apart")


def _validate_spot_hours(document: dict, blob_length: int | None) -> None:
    """The third blob, and the one whose header carries an index.

    A reader finds a spot's block by that spot's position in `spots`, so a
    header that lists a different number of spots than the blob was packed for
    does not fail loudly - it reads the wrong spot's weather and shows it
    under the right spot's name. Checked here for that reason.
    """
    meta = document.get("spot_hours")
    if meta is None:
        return

    expected = len(meta["spots"]) * len(meta["series"]) * meta["count"]
    if meta["bytes"] != expected:
        raise ValidationError(
            f"spot hours declares {meta['bytes']} bytes for {expected} samples"
        )
    if blob_length is not None and blob_length != meta["bytes"]:
        raise ValidationError(
            f"spot hours blob is {blob_length} bytes, document says {meta['bytes']}"
        )
    if not meta["spots"]:
        raise ValidationError("spot hours has no spots")
    if meta["count"] < 1:
        raise ValidationError("spot hours has no time axis")

    published = {entry["id"] for entry in document.get("spots") or []}
    unknown = set(meta["spots"]) - published
    if unknown:
        # A spot in the blob that is not in the document shifts every index
        # after it, silently.
        raise ValidationError(f"spot hours names unpublished spots: {sorted(unknown)}")


def validate(
    document: dict,
    spots: list[Spot],
    blob_length: int | None = None,
    observed_length: int | None = None,
    hours_length: int | None = None,
) -> None:
    if document.get("schema_version") != SCHEMA_VERSION:
        raise ValidationError("schema_version mismatch")

    entries = document.get("spots") or []
    if len(entries) != len(spots):
        missing = {s.id for s in spots} - {e["id"] for e in entries}
        raise ValidationError(f"missing spots: {sorted(missing)}")

    for entry in entries:
        days = entry.get("days") or []
        if not days:
            raise ValidationError(f"{entry['id']}: no forecast days")
        for day in days:
            if entry["type"] == "viewpoint":
                _validate_profile(entry["id"], day)
            scores = (
                [day["visibility"], day["cloud_sea"]]
                if entry["type"] == "viewpoint"
                else [day["score"]]
            )
            for score in scores:
                if not 0.0 <= score["value"] <= 100.0:
                    raise ValidationError(
                        f"{entry['id']} {day['date']}: score out of range"
                    )
                if not 0.0 <= score["confidence"] <= 1.0:
                    raise ValidationError(
                        f"{entry['id']} {day['date']}: confidence out of range"
                    )
                if not score["reasons"]:
                    # A number with no explanation is not publishable; the UI
                    # has nothing to show beside it.
                    raise ValidationError(
                        f"{entry['id']} {day['date']}: score has no reasons"
                    )

    _validate_grid(document, blob_length)
    _validate_observed(document, observed_length)
    _validate_spot_hours(document, hours_length)

    stale_at = datetime.fromisoformat(document["stale_at"].replace("Z", "+00:00"))
    if stale_at <= datetime.now(tz=timezone.utc):
        raise ValidationError("document is already stale on generation")


# --- entry point ----------------------------------------------------------


def _load_offline(spots: list[Spot]):
    """Rebuild from committed fixtures, for CI and for working without network."""
    viewpoints = by_type(spots, "viewpoint")
    beaches = by_type(spots, "beach")
    atmosphere = OpenMeteoAtmosphere.parse(
        viewpoints, json.loads((FIXTURES / "openmeteo_viewpoints.json").read_text())
    )
    marine = OpenMeteoMarine.parse(
        beaches, json.loads((FIXTURES / "openmeteo_marine.json").read_text())
    )
    return atmosphere, marine, None


def run(out: Path | None, dry_run: bool, offline: bool) -> dict:
    spots = load_spots()
    attributions: list[str] = []

    grid: CloudGrid | None = None
    observed: ObservedCloud | None = None
    air: dict[str, AirForecast] = {}

    if offline:
        # Fixtures cover viewpoints and beaches separately and carry no wind
        # for beaches, so only the viewpoint half round-trips faithfully here.
        atmosphere, marine, status = _load_offline(spots)
        # No dust in the fixtures. `assess(None)` is a no-op by construction,
        # so an offline build scores exactly as it did before calima existed.
        spots = [s for s in spots if s.id in atmosphere or s.id in marine]
        attributions = [OpenMeteoAtmosphere.attribution, OpenMeteoMarine.attribution]
    else:
        atmosphere_source = OpenMeteoAtmosphere()
        marine_source = OpenMeteoMarine()
        official_source = IPMA()

        # Atmosphere for every spot: viewpoints need the vertical profile,
        # beaches need surface wind.
        atmosphere = atmosphere_source.fetch(
            spots, FORECAST_HOURS, past_days=GRID_PAST_DAYS
        )
        marine = marine_source.fetch(by_type(spots, "beach"), FORECAST_HOURS)
        air_source = OpenMeteoAir()
        try:
            air = air_source.fetch(
                spots, past_days=GRID_PAST_DAYS, forecast_days=FORECAST_DAYS
            )
        except Exception as error:
            # Dust sharpens a forecast, it is not the forecast. Losing it costs
            # the calima warning and the haze term; every other number stands.
            print(f"air quality unavailable: {error}", file=sys.stderr)
            air = {}
        try:
            status = official_source.fetch()
        except Exception as error:
            # IPMA answers 403 to datacentre IP ranges, so the hourly CI run
            # cannot reach it even though a laptop can. Losing the official
            # warnings is a real loss, but it is not a reason to publish
            # nothing: the forecast is the product, the warnings are a relay,
            # and the page already tells people to check IPMA themselves. The
            # document says so plainly with a null source rather than pretending
            # there are no warnings today.
            print(f"official warnings unavailable: {error}", file=sys.stderr)
            status = None
        try:
            grid = OpenMeteoCloudGrid().fetch(
                past_days=GRID_PAST_DAYS, forecast_days=FORECAST_DAYS
            )
        except Exception as error:
            # Eighty extra locations are the most fragile call in the run and
            # the least load-bearing: the scores do not depend on them. Publish
            # without the volume rather than losing the forecast over it.
            print(f"cloud grid unavailable: {error}", file=sys.stderr)
            grid = None
        satellite_source = GmgsiLongwave()
        try:
            observed = fuse(
                satellite_source.fetch(OBSERVED_SCANS),
                lambda when: _reference_levels(atmosphere, when),
            )
        except Exception as error:
            # Reading cloud tops needs h5py and a 40MB download against an AWS
            # bucket we do not control. None of the scores read it, so a bad
            # hour there costs the observed layer and nothing else.
            print(f"observed cloud unavailable: {error}", file=sys.stderr)
            observed = None
        attributions = [
            atmosphere_source.attribution,
            marine_source.attribution,
        ]
        if observed is not None:
            attributions.append(satellite_source.attribution)
        if air:
            attributions.append(air_source.attribution)
        # Only credited when its data is actually in the document.
        if status is not None:
            attributions.append(official_source.attribution)

    hours = pack_hours(spots, atmosphere, air)
    document = assemble(
        spots, atmosphere, marine, status, attributions, grid, observed, hours, air
    )
    validate(
        document,
        spots,
        len(grid.values) if grid else None,
        len(observed.values) if observed else None,
        len(hours.values) if hours else None,
    )

    if dry_run or out is None:
        return document

    out.parent.mkdir(parents=True, exist_ok=True)
    # The blob lands before the document that points at it, so a reader that
    # catches the pair mid-publish never sees a header for a file that is not
    # there yet. Both are staged and moved for the same reason: a crash
    # mid-write must not leave a truncated file being served.
    if grid is not None:
        blob = out.parent / document["cloud_grid"]["file"]
        blob_staging = blob.with_suffix(blob.suffix + ".tmp")
        blob_staging.write_bytes(grid.values)
        blob_staging.replace(blob)

    if observed is not None:
        observed_blob = out.parent / document["cloud_observed"]["file"]
        observed_staging = observed_blob.with_suffix(observed_blob.suffix + ".tmp")
        observed_staging.write_bytes(observed.values)
        observed_staging.replace(observed_blob)

    if hours is not None:
        hours_blob = out.parent / document["spot_hours"]["file"]
        hours_staging = hours_blob.with_suffix(hours_blob.suffix + ".tmp")
        hours_staging.write_bytes(hours.values)
        hours_staging.replace(hours_blob)

    staging = out.with_suffix(out.suffix + ".tmp")
    staging.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    staging.replace(out)
    return document


def summarise(document: dict) -> str:
    lines = [
        "generated {}  stale after {}".format(
            document["generated_at"], document["stale_at"]
        ),
        "official warnings: {}".format(len(document["official"]["warnings"])),
    ]
    meta = document.get("cloud_grid")
    lines.append(
        "cloud grid: none (map falls back to per-spot profiles)"
        if meta is None
        else "cloud grid: {}x{} cells, {} levels, {} hours, {:.0f} KiB".format(
            meta["cols"],
            meta["rows"],
            len(meta["altitudes_m"]),
            len(meta["times"]),
            meta["bytes"] / 1024,
        )
    )
    observed_meta = document.get("cloud_observed")
    lines.append(
        "observed cloud: none (forecast only)"
        if observed_meta is None
        else "observed cloud: {}x{} cells, {} hours, {} to {}".format(
            observed_meta["cols"],
            observed_meta["rows"],
            len(observed_meta["times"]),
            observed_meta["times"][0],
            observed_meta["times"][-1],
        )
    )
    hours_meta = document.get("spot_hours")
    lines.append(
        "spot hours: none"
        if hours_meta is None
        else "spot hours: {} spots x {} series x {} hours, {} KiB from {}".format(
            len(hours_meta["spots"]),
            len(hours_meta["series"]),
            hours_meta["count"],
            hours_meta["bytes"] // 1024,
            hours_meta["t0"],
        )
    )
    lines.append("")
    for entry in document["spots"]:
        day = entry["days"][0]
        if entry["type"] == "viewpoint":
            lines.append(
                "  {:22} {:>6.0f}m  vis {:5.1f}  sea {:5.1f}  {}".format(
                    entry["id"],
                    entry["elevation_m"],
                    day["visibility"]["value"],
                    day["cloud_sea"]["value"],
                    day["date"],
                )
            )
        else:
            lines.append(
                "  {:22} {:>6}   score {:5.1f}  sst {}  wave {}".format(
                    entry["id"],
                    "beach",
                    day["score"]["value"],
                    day["sst_c"],
                    day["wave_height_m"],
                )
            )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("dist/conditions.json"))
    parser.add_argument("--dry-run", action="store_true", help="print, write nothing")
    parser.add_argument("--offline", action="store_true", help="use committed fixtures")
    args = parser.parse_args(argv)

    try:
        document = run(args.out, args.dry_run, args.offline)
    except Exception as error:
        # Non-zero exit fails the CI job, which is what keeps the previously
        # published good file in place.
        print(f"ingest failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1

    print(summarise(document))
    if not args.dry_run:
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
