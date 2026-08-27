"""Observed cloud, from NOAA's global geostationary mosaic.

Everything else in this package is forecast: a model's opinion about what the
sky will do. This module is the only source that says what the sky is actually
doing, which is what makes the map checkable rather than merely plausible.

GMGSI is the NESDIS blend of every geostationary satellite into one global
grid, published hourly on AWS open data with no account and no key. The
longwave channel (`GMGSI_LW`, 10.8um infrared) is the one that sees cloud tops
at night as well as by day - the whole product is aimed at 4am sunrise trips,
so a visible channel would be blind for exactly the hours that matter.

Meteosat covers the Madeira sector; the file's `platform` attribute lists it.
Resolution is ~0.072 degrees, about 8km, so the archipelago window is a couple
of dozen cells across - coarser than the eye but finer than the 9km forecast
model this sits beside.

The counts problem
------------------
`data` is stored as 0-255 counts even though its `units` attribute claims K,
and NOAA publish no conversion beside the file. The values follow the long-
standing NESDIS/GVAR infrared enumeration used by McIDAS, in which counts run
*up* as the scene gets colder. `brightness_temperature_k` implements it, and
the tests pin it against sea-surface temperature: over clear water off Madeira
the curve has to land within a few kelvin of the SST already ingested, or the
calibration is wrong and cloud-top heights built on it would be fiction.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree

import numpy as np

from ingest.sources.http import TIMEOUT, make_session

BUCKET = "https://noaa-gmgsi-pds.s3.amazonaws.com"
CHANNEL = "GMGSI_LW"
S3_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}

# NOAA publish each hour roughly 35 minutes past it, so the current hour is
# usually not there yet. Start looking back from that lag rather than from now.
PUBLISH_LAG = timedelta(minutes=45)

# Each global file is ~7MB and is thrown away once a twenty-cell window is
# cropped out of it, so what this costs is bandwidth, not payload. Nine scans
# three hours apart covers the last full day for 60MB - the alternative, every
# hour of it, is 170MB per run to sharpen a field whose cells are 8km wide and
# whose scrubber steps in hours.
DEFAULT_SCANS = 9

# Hours between the scans that are kept. The newest is always taken; the rest
# step back from it. Must stay in step with the tolerance in
# web/lib/observedCloud.ts, which is what decides when the scrub has left the
# observed window - too wide and stale cloud is shown as current, too narrow
# and the layer blinks out between scans.
STRIDE_HOURS = 3


@dataclass(frozen=True)
class ScanWindow:
    """The lat/lon box cropped out of the global mosaic.

    Deliberately not the forecast grid's shape: satellite cells are where they
    are, and resampling observation onto a model lattice throws away the very
    resolution that makes it worth fetching. The web side gets the native cells
    and the box they cover.
    """

    west: float
    south: float
    east: float
    north: float


# The map bounds, the same box the forecast volume covers.
DEFAULT_WINDOW = ScanWindow(west=-17.5, south=32.3, east=-16.2, north=33.2)


@dataclass(frozen=True)
class SatelliteScan:
    """One hour of observed brightness temperature over the window."""

    time: datetime
    key: str
    #: Cell centres, north to south and west to east - the order the rows run.
    lats: tuple[float, ...]
    lons: tuple[float, ...]
    #: [row][col] brightness temperature in kelvin, row 0 north. NaN where the
    #: mosaic had no retrieval for a cell.
    temperatures_k: np.ndarray

    @property
    def rows(self) -> int:
        return len(self.lats)

    @property
    def cols(self) -> int:
        return len(self.lons)

    def bbox(self) -> tuple[float, float, float, float]:
        """The box the *cells* actually cover, not the box that was asked for."""
        return (min(self.lons), min(self.lats), max(self.lons), max(self.lats))


def brightness_temperature_k(counts) -> np.ndarray:
    """NESDIS infrared count enumeration, counts 0-255 to kelvin.

    Two straight segments meeting at count 176 (242K). Below the break each
    count is half a kelvin, which buys resolution in the warm half where sea
    surface and low cloud have to be told apart; above it each count is a whole
    kelvin, because nothing here cares whether a cirrus top is 190K or 191K.
    Counts rise as the scene gets colder, so both segments subtract.
    """
    values = np.asarray(counts, dtype=np.float32)
    warm = 330.0 - values / 2.0
    cold = 418.0 - values
    return np.where(values > 176.0, cold, warm).astype(np.float32)


def _hour_prefix(when: datetime) -> str:
    return when.astimezone(timezone.utc).strftime(f"{CHANNEL}/%Y/%m/%d/%H/")


def list_hour(session, when: datetime) -> list[str]:
    """Object keys published for one UTC hour. Empty when the hour is not up yet."""
    response = session.get(
        BUCKET,
        params={"list-type": "2", "prefix": _hour_prefix(when), "max-keys": "10"},
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    root = ElementTree.fromstring(response.content)
    return sorted(
        key.text
        for key in root.findall("s3:Contents/s3:Key", S3_NS)
        if key.text and key.text.endswith(".nc")
    )


def recent_keys(
    session,
    count: int,
    now: datetime | None = None,
    stride_hours: int = STRIDE_HOURS,
) -> list[tuple[datetime, str]]:
    """The `count` newest scans at `stride_hours` spacing, oldest first.

    The newest hour is taken first and the rest step back from it, so the
    freshest observation is always in the set - it is the one anybody opening
    the page right now is looking at.

    An hour with nothing published is skipped and the walk continues, rather
    than failing: the mosaic misses one occasionally, and eight scans instead
    of nine is not worth losing the layer over. The search gives up a day past
    what it needs, so a longer outage cannot walk backwards forever.
    """
    now = now or datetime.now(tz=timezone.utc)
    start = (now - PUBLISH_LAG).replace(minute=0, second=0, microsecond=0)
    step = max(1, stride_hours)
    found: list[tuple[datetime, str]] = []
    for index in range(count + 24 // step):
        hour = start - timedelta(hours=index * step)
        keys = list_hour(session, hour)
        if keys:
            found.append((hour, keys[-1]))
        if len(found) == count:
            break
    return sorted(found)


def crop(payload: bytes, window: ScanWindow, time: datetime, key: str) -> SatelliteScan:
    """Cut the window out of a global file and convert counts to kelvin.

    The mosaic stores `lat` and `lon` as full 2D arrays of fifteen million
    cells each, but the projection is a plain equirectangular one: latitude is
    constant along a row and longitude along a column. Reading one row and one
    column is therefore enough to locate the window, and only the window's own
    cells are ever pulled out of the file.
    """
    import h5py  # imported late: only this module needs it, and it is heavy

    with h5py.File(io.BytesIO(payload), "r") as handle:
        lats = np.asarray(handle["lat"][:, 0], dtype=np.float64)
        lons = np.asarray(handle["lon"][0, :], dtype=np.float64)

        rows = np.where((lats >= window.south) & (lats <= window.north))[0]
        cols = np.where((lons >= window.west) & (lons <= window.east))[0]
        if rows.size == 0 or cols.size == 0:
            raise ValueError("GMGSI mosaic does not cover the requested window")

        # Contiguous slices, so the read is one hyperslab rather than fancy
        # indexing. The window never straddles the antimeridian, which is the
        # one place the longitude row wraps and these indices would not be
        # contiguous.
        row_slice = slice(int(rows.min()), int(rows.max()) + 1)
        col_slice = slice(int(cols.min()), int(cols.max()) + 1)
        counts = np.asarray(handle["data"][0, row_slice, col_slice], dtype=np.float32)
        fill = handle["data"].attrs.get("_FillValue")

    if fill is not None:
        counts = np.where(counts == float(np.asarray(fill).ravel()[0]), np.nan, counts)
    kelvin = brightness_temperature_k(counts)
    kelvin = np.where(np.isnan(counts), np.nan, kelvin).astype(np.float32)

    window_lats = lats[row_slice]
    if window_lats[0] < window_lats[-1]:
        # Every published file runs north to south; flip rather than trust it,
        # because a silently upside-down scan is indistinguishable from weather.
        kelvin = kelvin[::-1]
        window_lats = window_lats[::-1]

    return SatelliteScan(
        time=time,
        key=key,
        lats=tuple(float(value) for value in window_lats),
        lons=tuple(float(value) for value in lons[col_slice]),
        temperatures_k=kelvin,
    )


class GmgsiLongwave:
    name = "noaa-gmgsi-lw"
    attribution = "Satellite imagery: NOAA GMGSI (public domain)"

    def __init__(self, window: ScanWindow = DEFAULT_WINDOW, session=None):
        self.window = window
        self._session = session or make_session()

    def fetch(
        self, scans: int = DEFAULT_SCANS, now: datetime | None = None
    ) -> tuple[SatelliteScan, ...]:
        found = recent_keys(self._session, scans, now)
        if not found:
            raise ValueError("no GMGSI scans published in the last few hours")
        out = []
        for time, key in found:
            response = self._session.get(f"{BUCKET}/{key}", timeout=TIMEOUT)
            response.raise_for_status()
            out.append(crop(response.content, self.window, time, key))
        return tuple(out)
