# Overwatch

Static Niskayuna parcel and ADS-B overflight viewer. The repository is scoped to files needed to build and host the map app.

## What is included

- `src/` - Vite + TypeScript app code.
- `public/parcels.pmtiles` - parcel vector tiles.
- `public/indexes/` - address, PIN, owner, and parcel identity search indexes.
- `public/adsb/` - static ADS-B snapshot files consumed by the current aircraft, accumulated corridor, and flight watch layers.
- `docs/` - generated static site for GitHub Pages when you run `npm run build`.

Generated folders such as `node_modules/` are ignored. Raw PDFs, CSV/XLSX extracts, caches, logs, and scraping/collection scripts stay outside this publish repo.

## Local development

```sh
npm install
npm run dev
```

## Build

```sh
npm run typecheck
npm run build
```

For GitHub Pages under `capitaldistrict.github.io/overwatch/`, build with:

```sh
npm run build:pages
```

If `VITE_PMTILES_URL` is set, the app loads parcels from that fully qualified PMTiles URL instead of `public/parcels.pmtiles`.

## UI testing

Playwright covers the responsive map shell, mobile drawer states, drag snapping, and parcel-search expansion.

```sh
npm run test:ui
npm run test:ui:mobile
```

The test runner starts its own local Vite server on `127.0.0.1:49173` and stubs external OpenStreetMap tile responses so layout checks are not dependent on public tile availability.

## ADS-B snapshots

The hosted Pages site is static. It does not talk to dump1090 or third-party ADS-B providers from the browser. Instead, a local collector should periodically refresh `public/adsb/`, rebuild `docs/`, commit the new static snapshot, and push to GitHub Pages.

The map UI labels this as a published snapshot. Browser-side refreshes only re-read the static JSON files currently deployed by GitHub Pages; they do not make the public site real-time. Data freshness is controlled by the local publish job and the Pages deployment finishing after each push.

Recommended cadence:

- dump1090 writes local receiver JSON every 1 second.
- the collector polls at 5-30 seconds and updates local history.
- the public snapshot is rebuilt and pushed at most every 5 minutes.
- GitHub Pages publishes after the new commit is pushed to the configured Pages source. Expect a short deployment delay; if no local publish job runs, the public site remains at the last pushed snapshot indefinitely.

The current ADS-B files expected by the app are:

- `public/adsb/live-aircraft.geojson`
- `public/adsb/live-trails.geojson`
- `public/adsb/corridor-markers.geojson`
- `public/adsb/accumulated-corridors.geojson`
- `public/adsb/flight-summaries.json`

For a five-minute static publish job from the parent workspace, the practical flow is:

```sh
export PROPDATA_ROOT=/path/to/parent-workspace
cd "$PROPDATA_ROOT"
python3 adsb_collector.py \
  --source adsb_receiver_json/aircraft.json \
  --output-dir adsb_data \
  --once \
  --viewer-public-dir overwatch/public/adsb \
  --live-history-minutes 120

cd "$PROPDATA_ROOT/overwatch"
npm run build:pages
git add public/adsb docs
git commit -m "Update ADS-B snapshot"
git push origin main
```

This repo includes local operational scripts for that flow:

```sh
npm run publish:snapshot
npm run publisher:install
```

`publisher:install` installs `com.overwatch.publish_snapshot` as a per-user macOS `launchd` job at a 300-second cadence and runs one publish immediately. To use a shorter cadence, run the installer directly:

```sh
./scripts/install_launchd_publisher.sh 90
./scripts/install_launchd_publisher.sh 60
```

The publisher commits only `public/adsb` and `docs` snapshot changes, and skips the commit when nothing changed. Logs stay outside the repo at `../adsb_data/logs/overwatch_publisher.launchd.log` and `../adsb_data/logs/overwatch_publisher.launchd.err.log`. Keep receiver logs, raw ADS-B history, and launchd plists outside this repo.

## Enrichment strategy

Use enrichment in this order:

1. Local dump1090/readsb aircraft database fields (`r`, `t`, `desc`, `dbFlags`) and computed U.S. N-number registration.
2. Callsign/operator hints for simple class sorting.
3. Cached server-side lookups from open services when a local field is missing.

Candidate services:

- Airplanes.live REST API: useful `/hex`, `/reg`, `/type`, and `/point` endpoints; non-commercial use and rate limits should be respected.
- ADSB.lol API: open-data API with hex, registration, type, military, LADD, PIA, and point-radius endpoints; license is ODbL.
- OpenSky Network: useful for state, flight, and track lookups, but authenticated API access and credit limits make it better as a selective enrichment source than a high-frequency poller.
- ADS-B Exchange: rich API fields but API-key/commercial constraints mean it should be optional, not required for the static public app.

## Publish plan

1. In `capitaldistrict/overwatch`, keep GitHub Pages set to Deploy from branch -> `main` -> `/docs`.
2. Initialize this directory as a git repo if it is not already one.
3. Run the `/docs` build.
4. Add the remote `https://github.com/capitaldistrict/overwatch.git`.
5. Commit this clean source tree, including the generated `docs/` directory.
6. Confirm the site at `https://capitaldistrict.github.io/overwatch/`.

Suggested commands:

```sh
cd /path/to/overwatch
git init
git branch -M main
npm install
npm run build:pages
git add .
git commit -m "Prepare static map viewer for hosting"
git remote add origin https://github.com/capitaldistrict/overwatch.git
git push -u origin main
```
