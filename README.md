# Urja Ops API

A clean, documented REST API over the **Urja Meter Ops** legacy portal
(`https://urja-ops.flockenergy.tech`), built as part of Flock Energy's
engineering take-home. Programmatic consumers never touch the portal; they hit
this service.

- **What's here**: meter catalogue with filters, per-meter geolocation,
  consumption time series, a reconstructed network hierarchy
  (zone → circle → division → subdivision → substation → feeder → DT) with
  conflict flags, "meters near a point", and an authenticated bulk export path.
- **How it works**: on startup (and TTL-driven afterwards) the service pulls the
  portal's HMAC-signed bulk export into a local SQLite index. Energy series are
  fetched on demand, normalized (ISO 8601 IST timestamps, real numbers,
  consumption deltas computed from cumulative registers) and cached.
- **Where to learn more**: [`PROTOCOL.md`](PROTOCOL.md) explains how the portal
  actually works — endpoints, auth, signing, quirks — as discovered.
  [`REFLECTION.md`](REFLECTION.md) answers the reflection questions.

---

## Quickstart

```bash
git clone <this repo> && cd urja-ops-api
npm install
cp .env.example .env          # fill PORTAL_PASSWORD (or keep the given one)
npm start                     # http://127.0.0.1:8000
```

Then:

```bash
TOKEN=dev-token-change-me   # from .env API_TOKEN

# browsable API docs (Swagger UI)
open http://127.0.0.1:8000/docs

curl -s http://127.0.0.1:8000/health
curl -s -H "Authorization: Bearer $TOKEN" \
     'http://127.0.0.1:8000/v1/meters?status=Faulty&limit=3'
```

## Sample request / response

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:8000/v1/meters/J100001/energy?from=2026-06-01&to=2026-06-01'
```

```json
{
  "meter_id": "J100001",
  "from": "2026-06-01",
  "to": "2026-06-01",
  "interval_minutes": 30,
  "points": [
    {
      "timestamp": "2026-06-01T00:00:00.000+05:30",
      "kWh": 42138.41,
      "kVAh": 45509.49,
      "voltR": 234,
      "consumption_kWh": null
    },
    {
      "timestamp": "2026-06-01T00:30:00.000+05:30",
      "kWh": 42138.83,
      "kVAh": 45509.93,
      "voltR": 235,
      "consumption_kWh": 0.42
    }
  ],
  "data_quality": {
    "malformed_rows": 0,
    "duplicate_timestamps": 0,
    "regressed_readings": 0,
    "irregular_gaps": 0
  },
  "cache": { "served_from": "portal" }
}
```

Note what happened between portal and API: the portal hands out
`"timestamp": "01/06/2026 00:00", "kwh": "42138.41"` strings; we emit ISO 8601
with an explicit IST offset, typed numbers, and derived consumption.

## The API surface

Base URL `/v1`, all endpoints require `Authorization: Bearer <API_TOKEN>`
(except `/health`, `/docs`). Full detail lives in [`openapi.json`](openapi.json),
served live at `/openapi.json` and browsable at `/docs`.

| Method | Path                              | Purpose                                                        |
| ------ | --------------------------------- | -------------------------------------------------------------- |
| GET    | `/health`                          | Service + index freshness status (no auth)                     |
| GET    | `/v1/meters`                       | Filterable meter list (`q`, `status`, `phase`, `make`, `build`, `install_type`, `dt`, `feeder`, `zone`, `circle`, `division`, `subdivision`, `substation`, `limit`, `offset`) |
| GET    | `/v1/meters/{meterId}`             | Meter detail incl. geo and resolved hierarchy path             |
| GET    | `/v1/meters/nearby`                | `latitude`, `longitude`, `radius_m` → nearest meters (haversine) |
| GET    | `/v1/meters/{meterId}/energy`      | Normalized readings + computed consumption, `from`/`to` optional |
| GET    | `/v1/network/tree`                 | Canonical network hierarchy with conflict annotations          |
| GET    | `/v1/network/transformers`         | DT master list enriched with meter counts                      |

Conventions:

- Errors are always `{"error": "<code>", "message": "<detail>"}` with truthful
  status codes (400/401/404/429/502); portal outages surface as `502 portal_*`.
- Timestamps are ISO 8601 **with explicit +05:30 offset** (assumption: the
  portal is IST; see PROTOCOL §7).
- `limit` ≤ 100, `offset`-based pagination with `{total, limit, offset}` meta.
- The current dataset is June 2026 (half-hourly except some daily meters);
  `data_quality` on every energy response reports rows we could not trust.
- Coordinates are WGS-84 decimal degrees (from the portal's own export).

## Configuration

| Env var                        | Default                              | Notes                                          |
| ------------------------------ | ------------------------------------ | ---------------------------------------------- |
| `PORTAL_PASSWORD`              | —                                    | Required                                       |
| `PORTAL_EMAIL`                 | `operator@urja.local`                |                                                |
| `PORTAL_BASE_URL`              | `https://urja-ops.flockenergy.tech`  |                                                |
| `API_TOKEN`                    | `dev-token-change-me`                | Our own API's bearer token                     |
| `PORT` / `HOST`                | `8000` / `127.0.0.1`                 |                                                |
| `DB_PATH`                      | `data/urja.db`                       | SQLite (WAL); `:memory:` for tests             |
| `INDEX_TTL_SECONDS`            | `600`                                | How long the local meter index is trusted      |
| `ENERGY_TTL_SECONDS`           | `300`                                | Energy cache freshness (stale-while-revalidate) |
| `PORTAL_MIN_REQUEST_INTERVAL_MS` | `550`                              | Rate-limit pacing (~109 req/min)               |
| `PORTAL_COOLDOWN_MS`           | `60000`                              | After a 429                                    |
| `PORTAL_REQUEST_RETRIES`       | `3`                                  | 429 retry budget per request                   |

## Project layout

```
src/
  index.ts            server bootstrap (config, services, listen)
  app.ts              Fastify app: plugins, auth hook, error mapping, swagger
  config.ts           env config
  schemas.ts          TypeBox schemas = request validation + OpenAPI spec
  portal/
    client.ts         portal client: login, pacing, 429 backoff, re-auth
    sign.ts           HMAC canonical string + signature (reverse engineered)
    types.ts          wire-format types (strings! quirky field names)
  domain/
    energy.ts         normalization: IST parsing, deltas, data quality
    energyService.ts  cache + in-flight coalescing for energy series
    indexService.ts   export-driven index freshness (stale-on-failure)
    hierarchy.ts      majority-vote tree builder from per-meter chains
  store/
    db.ts             better-sqlite3 schema
    queries.ts        filters, nearby (haversine), caches
    ingest.ts         export -> index (transformers + meters + hierarchy)
  routes/             meters.ts, network.ts — thin HTTP layer
scripts/
  generate-openapi.ts writes openapi.json from the live app (npm run openapi)
  backfill-energy.ts  optional: warm energy cache for all 403 meters
web/
  index.html          the web client, served by the API at /app/
test/                 vitest: sign, energy normalization, portal client, ingest, API e2e
```

## Testing

```bash
npm test         # 32 tests, all offline (portal mocked with undici MockAgent)
```

The test suite covers: the HMAC publishing scheme's canonical form, login flow /
session-cookie handling, 401 → re-auth, 429 → backoff + retry, 404 mapping and
export signing; energy normalization (day-first dates, malformed rows, duplicate
timestamps, regressed registers, mixed cadence, consumption deltas); export
ingestion + hierarchy conflict resolution; and end-to-end API behavior against a
fully mocked portal.

A live smoke pass `LIVE=1 npm run dev` isn't scripted; simply start the service
and hit `/health` — the index refresh attempts a portal round trip on boot.

## Design decisions & trade-offs

1. **Local index from the signed export, not portal search.** The portal's
   `/portal/meters/search` only matches id/serial and exposes no filters. The
   export has everything (including `build`, `install_type`, coordinates,
   hierarchy) in one request — so one paced call replaces hundreds. Filter
   queries are served locally, always fast, and survive portal outages.
   *Trade-off*: data staleness (bounded by `INDEX_TTL_SECONDS`; served stale
   with a flag if the portal is unreachable).
2. **Energy stays live-on-demand with a cache.** 403 meters × 1440 readings is
   small by data standards but takes ~6 min at rate-limit pace, so fetching the
   full history on every start is silly. Requests are fetched per meter/date
   range, cached with a TTL, coalesced while in flight, and stale-while-
   revalidated after expiry. `scripts/backfill-energy.ts` warms everything
   when you really do want the full set (see "The full dataset" below).
3. **Consumption is derived, never invented.** The portal only provides
   cumulative registers; we compute per-interval kWh and *refuse* to guess on
   regressed readings (reported in `data_quality.regressed_readings`
   instead).
4. **Conflicts in the hierarchy are surfaced, not silently resolved.** Blank
   codes can't be placed (nodes stay top-level with `unresolved_parents`),
   names are majority-voted with variants kept, parent conflicts recorded.
   Hiding data-quality problems in an integration around an *ageing* system
   would be the wrong engineering trade.
5. **Auth is a single static bearer token.** This is a PoC for an internal
   consumer; a real deployment wants per-consumer keys/OIDC. Cheap to swap
   because the hook lives in one place.
6. **SQLite over a DB server.** 403 meters and ~580k June readings fit in tens
   of MB; no operational surface worth paying for. The store is structured so a
   bigger deployment swaps in Postgres with a bounding-box GiST index without
   touching the domain logic.
7. **TypeBox schemas double as OpenAPI.** One source of truth → the spec can't
   drift from the code. `npm run openapi` regenerates the committed file.
8. **Fastify + undici MockAgent for tests.** Straightforward DI: the app builder
   takes injected services, so the portal can be a fully-mocked in-process fake.

## The web client (optional extension, done)

`served at http://127.0.0.1:8000/app/` — a single-file, zero-build page served by
the API itself (same origin, no CORS). It turns the API into a product:

- **Map view** of all 403 meters (Leaflet + OSM tiles, color-coded by install
  status) — the coordinates come straight from `meter.latitude/longitude`.
- **Filters**: status, phase, build, DT, and meter-id/serial search — list and
  markers update together.
- **Slide-over meter panel** with three tabs:
  - *Meter* — nameplate fields, the resolved network path
    (zone › circle › … › DT), and a "meters within 500 m" nearby call.
  - *Consumption* — daily kWh bars + half-hourly consumption/voltage dual-axis
    charts (Chart.js) from `/v1/meters/{id}/energy`, with `data_quality` surfaced
    as warnings (malformed rows, duplicates, regressed registers, irregular gaps).
  - *Network* — the DT master list with meter counts, the selected DT highlighted.
- **Auth**: if a `/v1` call returns 401 and no token is stored, a dialog asks for
  the bearer token (persisted in localStorage). You can also pass it via URL:
  `/app/?token=dev-token-change-me`.

Verified end-to-end in headless Chrome: full boot with all 403 meters rendered.

## What we intentionally left out, and why

- **Public OAuth2/OIDC flows**, rate-limit headers on our own API, request
  auditing log: worth doing in production, both out of scope for a strong PoC.
- **A full test of every hierarchy corner** (e.g. three-level inconsistencies in
  *one* chain): covered at unit level for the discovered anomalies; exhaustive
  fuzzing of the portal's quirks is past diminishing returns.
- **Postgres for the index**; the schema maps straight over when needed.
- **Consumption aggregates** (e.g. "last 7d kWh" precomputed per DT) — cheap to
  add at query time from cached data; not worth persisting until we know who
  queries it.

## The full dataset (optional extension, done)

The portal's signed bulk export is our ingestion backbone: one request returns
all 403 meters with hierarchy + geo. The **energy** dataset (June 2026,
~540k–580k readings) can be optionally pulled into the API's own SQLite with:

```bash
npx tsx scripts/backfill-energy.ts
```

It paces at ~1.8 req/s (safe vs. the portal's ~120/min limit, measured), backs
off correctly on 429s, and warms the cache so `/v1/meters/{id}/energy` answers
from cache. At 403 meters this takes ~4 minutes. A script exists mainly to keep
the bordered-on-rate-limit behavior explicit and restartable.

**Scale limits.** SQLite handles 580k cached energy rows comfortably. Beyond
that (~10^6–10^7 points), the store moves to Postgres partitioned by day and the
nearby-radius search needs a spatial index — at 403 rows we just compute
haversine in JS, cheap; at 10^7 meters we'd feed an in-memory R-tree or
PostGIS.

## Notes on data quality (why the API is opinionated)

- Cumulative **registers** (`kwh`, `kVAh`) become **consumption deltas** in our
  responses; missing/short/battery-swap meters are flagged, not silently zeroed.
- **Malformed rows** (empty `kwh` / `voltR` strings, `J100089`, 30/06) are
  dropped and counted in `data_quality.malformed_rows`.
- **Duplicate timestamps** at the same reading: counts reported; rows dropped.
- **Mixed cadence** (a few meters are daily, not half-hourly): the modal interval
  is `interval_minutes`, distance reported in `data_quality.irregular_gaps`.
- **Hierarchy conflicts** (DT-007 names, blank feeder codes, inconsistent
  parents): listed on each `/v1/network/tree` node with `name_variants`,
  `parent_conflict`, `unresolved_parents`; the tree meta reports the conflict
  count.

## Assumptions (detailed reasoning in PROTOCOL.md / REFLECTION.md)

- Portal timestamps are IST; we always emit explicit `+05:30`.
- The portal's data window is currently fixed to June 2026 — "freshness" means
  our index's age vs. the portal's, not wall-clock time.
- The HMAC signing secret is session-stable; we re-fetch and retry if a signature
  is ever rejected.
- Majority voting best represents "what the network actually is" when the portal
  itself disagrees meter-to-meter; disagreements are always visible.

## Reflection

Answered in full in [`REFLECTION.md`](REFLECTION.md): assumptions, hardest part,
a day more, mistakes, and self-critique.
