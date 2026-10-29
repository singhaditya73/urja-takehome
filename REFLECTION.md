# REFLECTION.md — follow-up questions, answered

## What assumptions did you make?

1. **Timestamps are IST (+05:30).** The portal emits `DD/MM/YYYY HH:mm` with no
   timezone marker. The site is an Indian electricity distribution utility
   (Jaipur locality names), every finding is local to that, and DST doesn't
   exist in India, so a static +05:30 offset is a safe call. Our API is
   explicit about the offset in every timestamp it emits.
2. **The dataset is frozen at end-of-June 2026.** Every meter stores exactly
   `01/06/2026 00:00 → 30/06/2026 23:30`; requests outside that window return
   whatever overlaps. We treat "freshness" as "how old is our local index vs.
   the portal", not as a wall-clock question.
3. **The signing secret is stable.** We observed the same `signingSecret` from
   `/portal/keys` across hours and sessions, so we cache it for an hour and
   refetch only when a signature is rejected. If the portal rotates it per
   session in future our re-fetch logic covers it anyway.
4. **Majority vote is the right conflict-resolution rule for the hierarchy.**
   The portal gives no authority information about which name/parent is
   correct, so we pick the plurality answer and surface the rest. Choosing
   e.g. "always trust /dts" would have been wrong for DT-007 (the master list
   itself is the outlier).
5. **The portal is read-only and we should behave like a polite user.** We
   never tried to enumerate or attack anything that isn't reachable through
   normal logged-in use; bulk pulls pace themselves well below the rate limit.

## Which part was the most difficult, and how did you get unstuck?

Two spots stand out.

*Finding the data path.* The portal renders empty tables server-side, so it was
not obvious where meter data came from. The unblock was reading the JS bundles
the page ships: grep for `fetch(` in `/_app/immutable/nodes/*.js` immediately
listed every data endpoint, and the minified code of the Transformers page
contained the full HMAC export routine, which became the backbone of the
integration.

*Interpreting the energy series.* `kwh`/`kvah` strings, a day-first timestamp
format, and two cadences (half-hourly vs daily mixes) made the first
normalization pass produce nonsense — including the classic `01/06` read as
January 6th. We generated tests from the real anomalies (the `J100089`
malformed row, daily-cadence meters, duplicate timestamps) so normalization now
has an explicit, tested contract.

## If you had another day, what would you improve?

1. **A web client (done, delivered at `/app/`).** With the coordinates indexed
   from the export, the map + consumption-over-time charts + per-DT load view
   became a single-file page served by the API itself, verified in headless
   Chrome against the live service.
2. **Rolling consumption aggregates in SQLite** (last 7/30-day kWh, current
   average load) so product questions — "which DT is running hot?" — become one
   query. The data is already there; only the summarization query layer is missing.
3. **Better staleness protocol.** The index refresh is TTL + on-demand. A
   conditional/ETag revalidation would be ideal, but the portal has no last-
   modified semantics; instead we'd add a background refresher task with jitter
   instead of on-demand inference.
4. **Integration tests against a recorded portal** (vcr-style, from a real
   session) to complement the hand-made MockAgent fixtures.
5. **CI + Dockerfile** so a reviewer gets the service with `docker compose up`
   without installing Node 20+.

## What mistake did you make while solving this?

We sent a correct HMAC signature with a stale session at the very start (we
manually passed a cookie into `urllib` without reading `Set-Cookie` on the
first call, which rotates), concluded the signing scheme was "wrong", and spent
a while debugging the wrong thing — until the same 401 reappeared for
`/portal/keys`, proving the failure was authentication transport, not signature
math. The lesson: when an auth failure seems to contradict captured evidence,
reproduce it with the *whole* request flow, not just the signature.

The second mistake is small but telling: earlier in the day we hammered the
portal at ~30 rps while profiling all 403 meters' energy series, tripped the
429 line, and polluted half the profile with rate-limit noise (we then had to
re-understand that "len_30" meters were that way by design, not by throttling).
That's what pushed us to build pacing into the client rather than around it.

## If you were reviewing your own submission, what would you criticise?

1. **The web client is thin by design** (single file, CDN libraries, no build
   step). It's delivered at `/app/` and works, but it has no automated tests —
   a reviewer will click it, not unit-test it. Production would want a real
   frontend build (Vite/Svelte) with component tests.
2. **Pagination on `/v1/meters/{id}/energy` is portal-bounded**: portals slice data
   by date, and we mirror that. For meters with local backfill we could serve
   arbitrary windows with real pagination; today a full-series request on a
   long history returns an unpaginated list (fine at 1440 points, ugly at 10^6).
3. **Conflicting-name resolution is per-code majority**; it works but has no
   notion of "this meter's chain disagrees about a *level above itself*", so a
   meter can end up attached to a division whose majority parent doesn't match
   its own chain's majority circle. Where strict consistency matters, resolve
   the disagreement downward from the top level (roots outward).
4. **The auth story is thin**: one static bearer token in env. Fine for an
   internal service, but real deployment would want OIDC or at least per-consumer
   keys with rate-limit accounting.
5. **TypeBox schemas duplicate interface shapes** the domain objects already
   define — there's one place where the hand-off between the two could drift.
   A single-source-of-truth codegen would trim that.
