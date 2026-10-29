# PROTOCOL.md — How the Urja Meter Ops portal actually works

Everything below was discovered by logging into the portal and inspecting it with
`curl`, by reading the JavaScript bundles the site ships, and by exercising the
endpoints with controlled requests. Where a claim is inference rather than a
direct observation, it's marked as such.

## 1. The stack

The portal is a **SvelteKit** single-page-style app (Svelte, `_app/immutable/*`
bundles, `x-sveltekit-page` headers) with **better-auth** for identity. Pages:

| Page              | Path              | Notes                                          |
| ----------------- | ----------------- | ---------------------------------------------- |
| Login             | `/login`          | Plain HTML `<form method="POST">`, no JS needed |
| Meters (list)     | `/meters`         | Search box, paginated table (20/page)          |
| Meter detail      | `/meters/{id}`    | Nameplate + location + consumption chart       |
| Transformers (DT) | `/transformers`   | DT table + **hidden "Export all meters" button** |

## 2. Authentication

- **Login**: `POST /login` with form-encoded `email` + `password`.
  - The server enforces a SvelteKit CSRF rule: form POSTs must carry a header
    `Origin` matching the portal host, otherwise it answers
    `403 Cross-site POST form submissions are forbidden`. A script must send
    `Origin: https://urja-ops.flockenergy.tech` explicitly (curl does not set it).
- **Session**: the response sets
  `Set-Cookie: __Secure-better-auth.session_token=...; Max-Age=3600` (1 hour).
  All subsequent requests carry it via `Cookie`.
- better-auth's own JSON API is exposed: `GET /api/auth/get-session` returns the
  session object (user id, email, expiry). We only use it to sanity-check the
  session; the portal data endpoints below just need the cookie.

## 3. Data endpoints (the useful part)

All under the same host, all cookie-authenticated, all JSON:

| Endpoint                              | Returns                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /portal/meters/search?q&page`    | `{data, total, page, pageSize}` — meter list, 20/page                                       |
| `GET /portal/meters/{id}/energy`      | `{data: EnergyPoint[]}` — half-hourly readings                                              |
| `GET /portal/meters/{id}/geo`         | `{data: {latitude, longitude}}` — **strings**, not numbers                                  |
| `GET /portal/dts?page`                | `{data, total}` — distribution transformer master list, 20/page                              |
| `GET /portal/keys`                    | `{data: {signingSecret}}` — HMAC secret for the export endpoint (§4)                         |
| `GET /portal/export?page=1`           | `{data, total}` — **the whole dataset**, HMAC-signed (§4)                                    |
| `GET /meters/{id}/__data.json`        | SvelteKit load data for the meter page — devalue-encoded nameplate + hierarchy (§6)          |

### Search semantics
- `q` is a **case-insensitive substring match on meter id or serial number only**.
  `?q=hpl` matches nothing even though `make: "HPL"` is right there — the portal
  does not search on make.
- `page` is 1-based; `?page=abc` is silently treated as page 1.
- Results: `{data, total, page, pageSize: 20}`.

### Energy semantics
- Query params `from` / `to`, date-only `YYYY-MM-DD`; **both bounds inclusive**,
  `to` alone means "7 days ending at `to`".
- With no params the portal serves its last `from`–`to` window (23/06–30/06
  during our observation, i.e. the end of the dataset).
- Points: `{timestamp, kwh, kvah, voltR}` with values as **strings**:
  - `timestamp` is **day-first** `DD/MM/YYYY HH:mm` with no timezone marker
    (see assumptions in the README — we treat it as IST).
  - empty string = missing value (`J100089` on 30/06 has `kwh: ""`).
- `kwh`/`kvah` are **cumulative register readings**, not per-interval consumption.
- `voltR` = phase voltage, values ~180–270 V across the dataset.
- Data window: exactly `01/06/2026 00:00 → 30/06/2026 23:30` IST, half-hourly
  (1440 points/meter) for most meters. Requests outside the window simply
  return whatever overlaps.

### metre IDs
- Meter ids run `J100000`–`J100402` with no gaps (403 total). Serial numbers are
  2 letters + 5 digits, one contains an `&` (`L&84997`).

## 4. The bulk export + request signing (the nice surprise)

The Transformers page has a non-obvious *Export all meters* button. Reading the
page bundle (`nodes/4.2Bgc2kUI.js` minified) reveals how it works:

1. `GET /portal/keys` → `{"data":{"signingSecret":"..."}}` — the portal hands
   the HMAC secret to every authenticated user (we observed the same secret
   across sessions; it appears static rather than per-session).
2. The client builds a canonical string and signs it:
   ```
   canonical = "GET\n" + "/portal/export" + "\n" + "page=1" + "\n" + <epoch-seconds>
   signature = lowercase hex of HMAC-SHA256(signingSecret, canonical)
   ```
3. `GET /portal/export?page=1` with headers `x-timestamp` (the epoch seconds)
   and `x-signature`.

Validation details we observed:
- The timestamp window is **tight**: ±90s was accepted, ±600s rejected with
  `401 {"error":"signature_invalid","message":"Missing or invalid request signature."}`.
- `POST /portal/export` → `405` — GET only.
- The server replays the canonical string with the *exact* query string, so the
  signature must be recomputed per request (we always send both the cookie and
  the signature; we did not test the two in isolation).
- Although the button sends `page=1`, `page` is ignored — the body is always the
  complete export (~230 KB). `pageSize`/`limit` are ignored too.

The export payload is the richest view of the data and includes fields the UI
never shows:

```json
{
  "meterId": "J100000",
  "serialNo": "SE33962",
  "make": "HPL",
  "phaseType": "single",
  "installStatus": "Decommissioned",
  "installType": "Whole Current",   // also "CT Operated"
  "build": "legacy",                // also "v2"
  "dtCode": "DT-001",
  "hierarchy": {
    "zone":       {"name": "Jaipur Zone 1", "code": "Z-01"},
    "circle":     {"name": "Circle 1",      "code": "C-01"},
    "division":   {"name": "Division 1",    "code": "D-01"},
    "subdivision":{"name": "Subdivision 1", "code": "SD-01"},
    "substation": {"name": "Substation 1",  "code": "SS-01"},
    "feeder":     {"name": "Feeder 1",      "code": "F-001"},
    "dt":         {"name": "Malviya Nagar DT 1", "code": "DT-001"}
  },
  "geo": {"lat": 26.93896, "lng": 75.83095}   // numbers here, strings via /geo
}
```

## 5. The network hierarchy is denormalized and messy

The portal has no "hierarchy" entity — the chain above is attached to each
meter individually. Cross-checking the 403 chains against the `/portal/dts`
master list and against each other:

- **Blank codes**: some meters have a level with `code: ""` (e.g. `J100044`'s
  chain has `feeder: {"name": "Feeder 5", "code": ""}`). A node with no code
  can't be pinned into a tree.
- **Same code, different names**: `DT-007` is `Sanganer DT 7` on 10 meters and
  `Old Malviya Nagar Xfmr` on 3 (the legacy ones).
- **Conflicting parents**: the same subdivision sits under different divisions
  depending on which meter you ask (D-01 appears under C-01, C-03 *and* C-05 in
  various meters).
- **The `/dts` master list disagrees with the meter chains for 8 meters** —
  e.g. `J100400–J100402` say `DT-007`/name `Old Malviya Nagar Xfmr`, while
  `/portal/dts` calls that code `Sanganer DT 7`.
- Code counts: zones 3 → circles 7 → divisions 10 → subdivisions 14 →
  substations 19 → feeders 29 → DTs 40. Codes are sequential per level
  (`Z-01…`, `SS-01…`) which suggests a 3-2-1 tree internally, too tidy to trust.

We therefore resolved the tree by **majority vote per code** and surface every
disagreement on the node instead of hiding it (see README §Design).

## 6. SvelteKit `__data.json` (cleaner than scraping HTML)

Any SvelteKit page can be fetched as its raw server `load` data by appending
`__data.json`, e.g. `GET /meters/J100001/__data.json`. That gives the nameplate
parameter list and the human-readable hierarchy strings in SvelteKit's devalue
JSON (an indexed string format) without parsing HTML. We don't use it in the
service (the export carries richer data), but it's a cleaner fallback for
nameplate data than screen-scraping.

## 7. Rate limiting (the trap)

- Roughly **120 requests per minute per session/IP**, then
  `429 {"error":"rate_limited", ...}` (no `Retry-After` header).
- In our tests the cooldown lasted ~45–60 s; hammering through it just
  re-triggers 429s.
- Sequential bulk pulls must therefore pace themselves. Our client defaults to
  ≥550 ms between portal requests (~109/min) and backs off for 60 s after a 429,
  retrying up to 3 times.

## 8. Error shapes

| Status | Body                                                  | When                              |
| ------ | ----------------------------------------------------- | --------------------------------- |
| 401    | `{"error": "...", "message": "..."}`                  | No/expired session, bad signature |
| 404    | `{"error":"not_found","message":"Meter not found"}`   | Unknown meter id on /energy, /geo |
| 429    | `{"error":"rate_limited", ...}`                       | >~120 req/min                     |

Sessions expire after 1 hour (`Max-Age`); we re-login transparently when any
request comes back 401.

## Summary of quirks a consumer must handle

1. `Origin` header required on the login POST (CSRF guard), else 403.
2. Session cookie rotates hourly → re-login on 401.
3. Day-first ambiguous timestamps, no timezone marker (assumed IST).
4. Numbers served as strings; missing values as empty strings; geo via `/geo`
   are strings while the export has numeric geo.
5. Mixed cadence: some meters are daily (±30 points/month), most are half-hourly.
6. Malformed rows and duplicate timestamps exist (J100089).
7. Hierarchy conflict and blank codes; the DT master list and meter chains
   disagree for 8 meters.
8. HMAC-signed bulk export whose secret is given to the client — the "one more
   way to get data out" that makes a clean API genuinely tractable.
9. Radically tight timestamp window (~±90 s) on signed requests — watch clock
   skew between your box and the portal's.
10. Rate limit ~120/min with ~1 min cooldown and no `Retry-After`.
