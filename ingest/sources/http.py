"""Shared HTTP session with retries.

Ingest runs unattended on a cron. A transient 5xx must not publish a partial
file, so every request retries with backoff and then raises.
"""

from __future__ import annotations

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

USER_AGENT = "madeira-conditions/0.1 (+https://github.com/)"
TIMEOUT = 30


def make_session(total_retries: int = 4) -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=total_retries,
        backoff_factor=1.5,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update({"User-Agent": USER_AGENT})
    return session


def get_json(session: requests.Session, url: str, params: dict) -> dict | list:
    response = session.get(url, params=params, timeout=TIMEOUT)
    response.raise_for_status()
    return response.json()
