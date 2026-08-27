# Madeira Conditions

Answers one shape of question for Madeira and Porto Santo: *given this place, at
this time, are conditions good enough to go?*

Two instances of it are implemented:

- **Sea of clouds** — will Pico do Arieiro or Ruivo be above the cloud deck at
  sunrise? People drive an hour at 4am and hit fog about half the time. Global
  weather apps cannot afford island-scale resolution, and the answer depends on
  the trade-wind inversion rather than on any surface forecast.
- **Sea conditions** — SST, waves, wind and UV for beaches and dive sites.

Both run through one engine: `Spot + Time + Signals -> Score`. Adding a feature
later (Saharan dust, whales, reservoirs) means a new spot type and a new rule
module, not a new project.

## Architecture

```
GitHub Actions (hourly)
   |-- Open-Meteo forecast + marine   (gridded, per-spot)
   |-- NOAA GMGSI infrared mosaic     (observed cloud tops)
   |-- IPMA warnings / UV             (official, island-wide)
   |-- score  inversion.py, beach.py, cloudtop.py
   |-- validate  (fail closed)
   `-- conditions.json + .bin  ->  Cloudflare R2  ->  static Next.js on Pages
```

The browser never calls a weather API. Everything is precomputed into a ~20KB
JSON document, so cost is flat under load and API quota is consumed by one cron
job rather than by users. All spots go out in a single multi-coordinate request,
so the hourly job costs ~24 calls/day against a 10,000/day limit.

## Quick start

```bash
pip install -r requirements.txt
python -m pytest -q
python -m ingest.build --dry-run
```

```bash
python -m ingest.build --out web/public/conditions.json
cd web && npm install && npm run dev
```

`--offline` rebuilds from committed fixtures with no network at all.

## How the sea-of-clouds model works

`ingest/scoring/inversion.py`. Open-Meteo publishes cloud cover, temperature and
geopotential height at pressure levels, which lets us reconstruct a vertical
profile in real metres and ask where the cloud actually sits relative to a summit.

1. Map each pressure level to metres using geopotential height.
2. Interpolate cloud cover onto that altitude axis.
3. Compare cloud below the summit, at the summit, and above it.
4. Detect the trade-wind inversion — temperature *increasing* with height between
   950 and 850hPa — which is the mechanism that creates the deck.
5. Score the hours within an hour of true local sunrise.

**Visibility and cloud sea are scored separately** and this is the important
design decision. A cloudless morning is a great sunrise but not a sea of clouds;
a single blended number would destroy that distinction, which is the entire
reason someone would use this over a normal forecast.

### Known limitations

- Vertical resolution near the summits is coarse. Around 1800m the pressure
  levels are roughly 500m apart, so the deck top can hide between them. This
  feeds into the reported confidence rather than being papered over.
- The model has not been calibrated against ground truth yet. The tunables at the
  top of `inversion.py` are first guesses and are expected to move.
- Fanal is scored as an ordinary viewpoint, but fog there is the attraction
  rather than a spoiler. It needs its own rule.

## Data sources

| Source | Use | Licence |
|---|---|---|
| Open-Meteo Forecast | Vertical profiles, cloud, wind | CC BY 4.0, **free tier is non-commercial** |
| Open-Meteo Marine | SST, waves, swell | CC BY 4.0, same restriction |
| NOAA GMGSI | Observed cloud-top altitude | Public domain, no account needed |
| IPMA | Official warnings, UV | Open data, attribution required |

`ingest/sources/base.py` defines the provider protocols. Everything downstream
depends only on the normalised types there, so swapping Open-Meteo for a
self-hosted instance or raw ECMWF open data — which is what commercial use would
require — means writing one new module and changing nothing else.

**GMGSI stores brightness as 0-255 counts**, not the kelvin its `units`
attribute claims, and NOAA publish no conversion beside the file. The NESDIS
infrared enumeration in `ingest/sources/gmgsi.py` is pinned against the sea
surface temperature already ingested: over clear water the two must agree to
within the few kelvin the humid atmosphere accounts for. Cloud-top altitude
then comes from reading that temperature against the vertical profile in
`ingest/scoring/cloudtop.py` — so the map's one measured layer costs no extra
forecast call.

**Observation only ever reaches backwards.** The satellite field covers the
last day at three-hour spacing; scrubbing past it removes the layer rather than
holding the last scan on screen, and the scrubber marks the span that is
actually covered.

**IPMA has only two Madeira point locations** (Funchal `2310300`, Porto Santo
`2320100`), far too coarse for per-spot scoring. It is used for the authoritative
layer instead: warnings, which are published per area — `MRM` mountainous
interior, `MCN` north coast, `MCS` south coast, `MPS` Porto Santo.

**IPMA fire risk is mainland-only.** The RCM product contains no Madeira
municipalities, so the document reports `fire_risk_available: false` rather than
implying we have data we do not.

## Operating rules

These are enforced in code, not left to discipline:

- **Report conditions, never verdicts.** No score says a place is safe.
- **IPMA is never overridden.** An active maritime warning caps what any beach
  can score and its text leads the card.
- **Fail closed.** `validate()` refuses to publish a document with a missing
  spot, an out-of-range score, or any score lacking a reason. A failed CI run
  leaves the last good file in place; the UI badges it stale after six hours.
- **Never claim certainty.** Confidence is capped below 1.0 and decays with lead
  time and with vertical resolution.
- **No webcam scraping.** Third-party feeds are copyrighted; official embeds only.

## Layout

```
ingest/
  sources/      base.py (protocols), openmeteo, openmeteo_marine, ipma, http
  scoring/      inversion.py (sea of clouds), beach.py
  spots.py      registry loader + validation
  build.py      orchestrator, serialisation, fail-closed validate
  tests/        73 tests; fixtures are captured real responses
data/spots.yaml 8 viewpoints, 7 beaches
web/            Next.js static export, MapLibre, PT/EN
```

## Deployment

Set repo variable `R2_BUCKET` and secrets `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, then point
`NEXT_PUBLIC_CONDITIONS_URL` at the published object and deploy `web/out` to
Cloudflare Pages.

The basemap currently uses the MapLibre demo style, which needs no API key but is
low detail and not intended for production traffic. Before launch, swap in
self-hosted PMTiles — a Madeira extract is a few tens of MB and fits in the same
R2 bucket.

## Not built yet

Trails and landslide risk are deliberately excluded. They carry real
physical-safety liability and need IFCN integration and insurance first. Also
outstanding: ground-truth reporting (the calibration loop the inversion model
needs), Copernicus raster ingest, and Saharan dust.
