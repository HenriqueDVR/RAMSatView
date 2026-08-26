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
from ingest.scoring.inversion import score_sunrise
from ingest.sources.base import AtmosphereForecast, OfficialStatus
from ingest.sources.ipma import IPMA, active_warnings
from ingest.sources.openmeteo import OpenMeteoAtmosphere
from ingest.sources.openmeteo_grid import (
    ALTITUDES,
    CloudGrid,
    OpenMeteoCloudGrid,
)
from ingest.sources.openmeteo_grid import header as grid_header
from ingest.sources.openmeteo_marine import OpenMeteoMarine
from ingest.spots import REPO_ROOT, Spot, by_type, load_spots

SCHEMA_VERSION = 2
FORECAST_HOURS = 72
FORECAST_DAYS = 3

# How far back the gridded volume reaches. The scrubber runs backwards as well
# as forwards, and a week is what Open-Meteo serves from the forecast endpoint
# without moving to the archive API, which lags by days.
GRID_PAST_DAYS = 7

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


def build_viewpoint(spot: Spot, forecast: AtmosphereForecast) -> dict:
    days = []
    for index in range(FORECAST_DAYS):
        outlook = score_sunrise(spot, forecast, index)
        if outlook is None:
            continue
        days.append(
            {
                "date": outlook.day.isoformat(),
                "sunrise_utc": _iso(outlook.sunrise_utc),
                "visibility": _score(outlook.visibility),
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


def assemble(
    spots: list[Spot],
    atmosphere: dict[str, AtmosphereForecast],
    marine: dict,
    status: OfficialStatus | None,
    attributions: list[str],
    grid: CloudGrid | None = None,
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
            "notes": spot.notes,
        }
        if spot.type == "viewpoint":
            base.update(build_viewpoint(spot, forecast))
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


def validate(document: dict, spots: list[Spot], blob_length: int | None = None) -> None:
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

    if offline:
        # Fixtures cover viewpoints and beaches separately and carry no wind
        # for beaches, so only the viewpoint half round-trips faithfully here.
        atmosphere, marine, status = _load_offline(spots)
        spots = [s for s in spots if s.id in atmosphere or s.id in marine]
        attributions = [OpenMeteoAtmosphere.attribution, OpenMeteoMarine.attribution]
    else:
        atmosphere_source = OpenMeteoAtmosphere()
        marine_source = OpenMeteoMarine()
        official_source = IPMA()

        # Atmosphere for every spot: viewpoints need the vertical profile,
        # beaches need surface wind.
        atmosphere = atmosphere_source.fetch(spots, FORECAST_HOURS)
        marine = marine_source.fetch(by_type(spots, "beach"), FORECAST_HOURS)
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
        attributions = [
            atmosphere_source.attribution,
            marine_source.attribution,
        ]
        # Only credited when its data is actually in the document.
        if status is not None:
            attributions.append(official_source.attribution)

    document = assemble(spots, atmosphere, marine, status, attributions, grid)
    validate(document, spots, len(grid.values) if grid else None)

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
