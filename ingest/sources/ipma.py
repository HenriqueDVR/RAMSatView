"""IPMA source: the official Portuguese meteorological authority.

This layer exists to be displayed verbatim and to gate our own scores. It is
never overridden by the model. If IPMA has a maritime warning up for the north
coast, no north-coast beach scores well, regardless of what the wave model says.

Two things worth knowing about IPMA's Madeira coverage:

  - Only two point forecast locations exist for the whole archipelago: Funchal
    (2310300) and Porto Santo (2320100). Far too coarse for per-spot scoring,
    which is why gridded data does that job and IPMA does this one.
  - The RCM fire-risk product is mainland-only. It contains no Madeira
    municipalities, so fire risk is simply not available from this source.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ingest.sources.base import OfficialStatus
from ingest.sources.http import get_json, make_session

BASE = "https://api.ipma.pt/open-data"
WARNINGS_URL = f"{BASE}/forecast/warnings/warnings_www.json"
UV_URL = f"{BASE}/forecast/meteorology/uv/uv.json"

# The four Madeira warning areas. Everything else IPMA publishes is mainland
# or Azores and is discarded.
MADEIRA_AREAS = frozenset({"MRM", "MCN", "MCS", "MPS"})

# IPMA point-forecast locations in the archipelago.
FUNCHAL = "2310300"
PORTO_SANTO = "2320100"

# Ordered least to most severe, so callers can compare.
SEVERITY = {"green": 0, "yellow": 1, "orange": 2, "red": 3}


def severity_of(level: str | None) -> int:
    return SEVERITY.get((level or "green").lower(), 0)


def _parse_time(value: str | None) -> datetime | None:
    """IPMA emits naive local timestamps; Madeira runs on UTC+0/+1.

    We treat them as UTC. The error is at most an hour and only affects when a
    warning is considered active at its boundary, which is acceptable for a
    display-and-gate layer. Do not use these for precise scheduling.
    """
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


class IPMA:
    name = "ipma"
    attribution = "Official warnings and UV index: IPMA (api.ipma.pt)"

    def __init__(self, session=None):
        self._session = session or make_session()

    def fetch(self) -> OfficialStatus:
        warnings = self._fetch_warnings()
        uv = self._fetch_uv()
        return OfficialStatus(
            source=self.name,
            issued_at=datetime.now(tz=timezone.utc),
            warnings=warnings,
            uv_index=uv,
            fire_risk=None,  # not published for Madeira; see module docstring
        )

    def _fetch_warnings(self) -> tuple[dict, ...]:
        payload = get_json(self._session, WARNINGS_URL, {})
        madeira = [
            item
            for item in payload
            if item.get("idAreaAviso") in MADEIRA_AREAS
            and severity_of(item.get("awarenessLevelID")) > 0
        ]
        return tuple(
            {
                "area": item["idAreaAviso"],
                "type": item.get("awarenessTypeName"),
                "level": item.get("awarenessLevelID"),
                "severity": severity_of(item.get("awarenessLevelID")),
                "text": item.get("text"),
                "start": item.get("startTime"),
                "end": item.get("endTime"),
            }
            for item in madeira
        )

    def _fetch_uv(self) -> dict[str, float]:
        payload = get_json(self._session, UV_URL, {})
        peaks: dict[str, float] = {}
        for item in payload:
            location = str(item.get("globalIdLocal"))
            if location not in (FUNCHAL, PORTO_SANTO):
                continue
            try:
                value = float(item["iUv"])
            except (KeyError, TypeError, ValueError):
                continue
            # Several periods per day are published; keep the daily peak, which
            # is the number that matters for sun exposure advice.
            peaks[location] = max(peaks.get(location, 0.0), value)
        return peaks


def active_warnings(
    status: OfficialStatus, area: str, at: datetime | None = None
) -> list[dict]:
    """Warnings in force for one area at a given moment, most severe first."""
    moment = at or datetime.now(tz=timezone.utc)
    live = []
    for warning in status.warnings:
        if warning["area"] != area:
            continue
        start = _parse_time(warning.get("start"))
        end = _parse_time(warning.get("end"))
        if start and moment < start:
            continue
        if end and moment > end:
            continue
        live.append(warning)
    return sorted(live, key=lambda w: w["severity"], reverse=True)
