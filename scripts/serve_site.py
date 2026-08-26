"""Serve the built site locally, correctly enough for the map to work.

`python -m http.server` is almost right, but it has no MIME type for `.mjs`,
and MapLibre v6 loads its worker as an ES module - a module script served as
text/plain is refused by the browser under strict MIME checking, and the map
comes up with no tiles and one cryptic console error. Every real host already
gets this right; this exists so the local launcher matches them.
"""

from __future__ import annotations

import argparse
import mimetypes
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", default="web/out", type=Path)
    parser.add_argument("--port", default=8787, type=int)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    mimetypes.add_type("text/javascript", ".mjs")
    # Windows registry entries have been known to map .js to text/plain, which
    # breaks the whole bundle rather than just the worker.
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("application/wasm", ".wasm")

    handler = partial(SimpleHTTPRequestHandler, directory=str(args.directory))
    with ThreadingHTTPServer((args.host, args.port), handler) as server:
        print(f"serving {args.directory} at http://{args.host}:{args.port}/")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
