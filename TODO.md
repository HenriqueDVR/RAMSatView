# TODO

What is wanted and not built, in one place. Tick items off in the same commit
that lands them, and add new ones here before starting rather than after.

Kept in the repo on purpose: the previous list lived in a plan file outside it,
and a phase got marked finished with two of its items missing because nothing
here recorded the gap.

---

## Wrong today

Things the app currently gets wrong, rather than things it does not do yet.

- [ ] **Spot coordinates and elevations are ~100m guesses.** From general
      knowledge, never verified against a real source - and elevation drives
      the entire inversion model, since every verdict is "is the deck above or
      below *this* number". Worth an afternoon with official data.
- [ ] **`/favicon.ico` 404s.** The static export ships no icon.

## Data the model is missing

- [ ] **Ground-truth calibration loop.** The tunables at the top of
      `ingest/scoring/inversion.py`, `HAZE_K` in `ingest/scoring/calima.py` and
      the shape constants in `ingest/scoring/colour.py` are all first guesses and have never been
      checked against what actually happened. Without a way to record "the deck
      was at X this morning" there is no way to know how often the model is
      wrong, or in which direction. The largest single thing standing between
      this and being trustworthy.
- [ ] **Copernicus raster ingest.** Listed as outstanding since the first
      session; never started.

## Interface

- [ ] **Play/pause on the scrubber.** The slider, the ticks, the day marks and
      the "now" button are all there; nothing lets the day run by itself.
      Arrow-key stepping already works - it is a real `<input type="range">`.
- [ ] **The panel mixes the hour with the day, without saying so.** The
      verdict, the temperature and the wind follow the scrubber; the profile
      chart and the reasons list are the sunrise summary. On screen right now
      Fanal reads "No mist forecast" directly above "Cloud in the forest (45%)"
      - both true, about different moments, and it reads as a contradiction.
      The curve staying daily is deliberate (hourly profiles per spot would
      duplicate `cloud-grid.bin`); what is missing is a heading on the reasons
      list saying they describe the sunrise.
- [ ] **The root layout cannot know the locale.** Only the root layout may
      carry `<html>` and it sits above the `[locale]` segment, so the language
      is stamped after export by `web/scripts/set-html-lang.mjs`. It works and
      it is tested by eye; restructuring the routes so the segment owns the
      element would remove the post-processing step.

## Verification owed

- [ ] **Screenshots the plan asked for**: the sunrise sky at several bearings;
      the same scene at 04:00 and 09:00 through the scrubber; the heatmap on a
      day with the deck below Arieiro and one with it above. The rule from the
      plan still stands - *if the picture and the number disagree, the picture
      is wrong*.
- [ ] **The deck's slice budget** in `web/components/Map.tsx`, now that it
      samples two data textures per fragment.

## Deployment

- [ ] **Self-hosted PMTiles** before any launch. See README, "Basemap".
- [ ] **`pages.yml` runs deprecated action versions.** The runner warns it is
      forcing Node 20 actions onto Node 24. `ci.yml` is already on current
      majors; the publish workflow was left alone because it is the thing that
      ships hourly.

## Parked, needing a decision first

- **Ground-truth reporting** needs somewhere to put what people submit, and
  this is a static export with no backend. Three ways in: prefilled GitHub
  issues (free, crude, works today), a real backend (first server this project
  would own), or nothing. Decide before building.
- **Road and access conditions.** The ER202 to Arieiro closes for wind, ice and
  works, and a perfect forecast is worthless if the road is shut. Estradas da
  Madeira and IFCN publish notices, but scraping them is fragile and relaying a
  road as open when it is not lands squarely in the safety liability this
  project has deliberately stayed out of.

## Deliberately not doing

- **Trails and landslide risk.** Real physical-safety liability; needs IFCN
      integration and insurance first. This is a decision, not a backlog item.

---

## Done

- [x] Sidebar replaces the card grid; horizon seam closed; cloud-top heatmap;
      camera freed from the data bbox. (`b921e3c`)
- [x] CI gates - lint, typecheck, build and the browser suite. (`bdfe5fd`)
- [x] Observed cloud drawn in the heatmap's colours, over the camera's box
      rather than the archipelago's. (`f7a588a`)
- [x] The phone keeps the map; the numbers arrive on a bottom sheet.
      (`acf07f4`)
- [x] A callout on the selected pin, and the two pin bugs anchoring it turned
      up: MapLibre's positioning and the pin's own scale were fighting over one
      `transform`. (`76334ee`)
- [x] Per-spot hourly numbers, so the readouts follow the scrubber instead of
      contradicting the map.
- [x] The suite split by cost: `npm test` is the logic half and takes seconds,
      `npm run test:map` is the map half and runs on CI. (`701433a`)
- [x] Fanal scored by its mist rather than against it. `fog_is_the_view` in
      `data/spots.yaml`; its score went from 11 to 50 on the same morning.
- [x] Calima. Open-Meteo's air-quality endpoint (free, no key) for aerosol
      optical depth and surface dust; a haze factor on visibility, a severity
      published per day, a sixth channel on the hourly blob so it follows the
      scrubber, and a line in the panel. The coefficient is a first guess and
      is named as one - it wants the same calibration as the inversion
      tunables.
- [x] Reasons are codes with their numbers, not English sentences, so the
      Portuguese half of the site is no longer explained in English. Schema 4.
      `reason()` refuses an unknown code and `test_reasons.py` reads
      `web/lib/i18n.ts` to check both languages can say all of them.
- [x] Claude is no longer named anywhere in the public repository: only
      `.claude/launch.json` was tracked, and no file content, commit message or
      trailer ever mentioned it.
- [x] Sunrise colour: whether the sky will *do* something, rather than whether
      it is merely visible. `ingest/scoring/colour.py`. Confidence is capped at
      0.55 on purpose - the light comes from hundreds of kilometres east of
      anything the model can see, and cirrus is among the worst-forecast
      fields there is.
