# aiostreams-curatio — AIOStreams fork with native Deepbrid

A fork of **[Viren070/AIOStreams](https://github.com/Viren070/AIOStreams)** (GPL-3.0, pinned at
`v2.30.6`) that adds a **native Deepbrid debrid service**. Curatio bundles this image, keeps it
**fully internal**, and manages it as **two profiles**, each an AIOStreams user config with a stable
stream URL. **Debrid keys are entered in AIOStreams' own `/configure` UI and live inside each config —
Curatio never stores them.** See `NOTICE-CURATIO.md` for licensing/attribution.

> **Build gate:** the monorepo requires **Node 24** + **pnpm 11**. Don't rely on local typechecking
> below Node 24 — the GitHub Actions workflow `.github/workflows/curatio-publish.yml` builds the full
> monorepo via the upstream Dockerfile and publishes the image. That is the source of truth for "it
> compiles."

---

## 1. What changed (native Deepbrid)

All changes are additive and grep-able by the `curatio:` marker.

**`packages/core/src/debrid/deepbrid.ts`** (new) — `class DeepbridService implements
TorrentDebridService`. Deepbrid (`https://www.deepbrid.com/api/v1`, `Authorization: Bearer <apiKey>`)
has **no infoHash cache-check** and returns **already-direct** torrent links, so:
- `checkMagnets()` reports every magnet as uncached (`status: 'unknown'`) → the client resolves on
  demand;
- `resolve()` does `POST /torrents/add` → poll `GET /torrents/info?id=` until `ready` /
  `ready_missing_links` → pick the video file's direct link;
- `generateTorrentLink()` returns the link unchanged (no unrestrict);
- `listMagnets` / `getMagnet` / `addMagnet` / `removeMagnet` map to `/torrents/*`.

**`packages/core/src/utils/constants.ts`** — added `const DEEPBRID_SERVICE = 'deepbrid'` to:
- the `SERVICES` array (→ `ServiceId`, and `ServiceIds = z.enum(constants.SERVICES)` in
  `db/schemas.ts`, so user configs accept `{id:'deepbrid', enabled, credentials:{apiKey}}`);
- `BUILTIN_SUPPORTED_SERVICES` (→ `ServiceAuthSchema`, marks it natively supported);
- `SERVICE_DETAILS` with an `apiKey` credential.

**`packages/core/src/debrid/index.ts`** — `export * from './deepbrid.js'`, import `DeepbridService`,
and a `case 'deepbrid'` branch in `getDebridService()` **before** the `default` (which would
otherwise throw, since Deepbrid is intentionally **not** in `StremThruPreset.supportedServices`).

That's the whole native-service wiring. `services.ts` / `helpers.ts` derive from `SERVICE_DETAILS`,
so no schema edit is needed.

### Verify the Deepbrid field names
The client uses documented fields (`add.id`, torrents/info `status` + `links[]`). Cross-check against
the live API (<https://www.deepbrid.com/api-docs>) and Deepbridge's
`src/deepbrid/{apiClient,torrents}.ts`; adjust `mapTorrent` / `READY_STATUSES` / `add.id` if needed.
Optional enhancement: use Deepbrid's official Stremio addon
(`/stremio/{apiKey}~qall.s0.rar1/stream/...`) as an instant-availability source in `checkMagnets`.

---

## 2. (Optional) Make TorBox StremThru-free

Curatio runs AIOStreams' **built-in proxy off** and consolidates debrid IP-limits through its own byte
proxy (see §4), so it doesn't lean on StremThru for the *stream-proxy* role. But in stock AIOStreams,
**TorBox _torrents_ still call StremThru** for the store ops: `packages/core/src/debrid/torbox.ts`
delegates `checkMagnets` / `addMagnet` / `addTorrent` / `generateTorrentLink` / `listMagnets` /
`getMagnet` / `removeMagnet` and the torrent branch of `resolve()` to an internal `StremThruService`
(defaulting to the public `builtins.stremthru.url`). To make TorBox fully native, reimplement those
methods against TorBox's own API (`@torbox/torbox-api`, already a dependency) — the operations map to:

| Method | TorBox API |
|---|---|
| `checkMagnets(hashes)` | `torrents.getTorrentCachedAvailability` |
| `addMagnet(magnet)` | `torrents.createTorrent` (magnet) |
| `resolve` (torrent) / `generateTorrentLink` | `torrents.requestDownloadLink` |
| `listMagnets` / `getMagnet` | `torrents.getTorrentList` |
| `removeMagnet` | `torrents.controlTorrent` (`delete`) |

This mirrors how `torbox.ts` already implements **usenet** natively via `this.torboxApi.usenet.*`.
Until then, TorBox torrents fall back to the public StremThru.

**RD / Premiumize caveat:** AIOStreams has *no* native clients for RealDebrid/Premiumize — they only
resolve via StremThru. To run fully StremThru-free, keep RD/Premiumize resolution in your
**external self-resolving addons** (Comet / MediaFusion / Debridio) and avoid built-in torrent
scrapers (TorrentGalaxy / Knaben / Zilean) resolving through RD/Premiumize in your profile templates.

---

## 3. Build & run

**Local (Node 24 + pnpm 11):**
```bash
corepack enable
pnpm install
pnpm -r build          # or: pnpm --filter @aiostreams/core typecheck
```

**Docker (the image Curatio consumes):**
```bash
docker build -t ghcr.io/youngc01/aiostreams-curatio:dev .
```

**CI:** push to `main` / `curatio-deepbrid` (or a `v*` tag) → `curatio-publish.yml` builds and pushes
`ghcr.io/youngc01/aiostreams-curatio:<tag>` to GHCR.

Runtime env is set by Curatio's compose on the internal `aiostreams` service — see
**§4 → Runtime env**.

---

## 4. Curatio integration (configure-first)

Curatio bundles this image, keeps it **fully internal**, and manages it as **two profiles**
("Low Bandwidth" / "High Bandwidth"), each an AIOStreams user config with a stable stream URL. Curatio
seeds the two configs, serves their streams, and reverse-proxies AIOStreams' own `/configure` UI behind
admin auth so an operator edits a profile in place. **Debrid keys are entered in `/configure` and live
inside each AIOStreams config — Curatio never stores them.**

### Image

Curatio pulls this fork via `AIOSTREAMS_IMAGE` in its own `docker-compose.yml`:

```env
# Curatio .env
AIOSTREAMS_IMAGE=ghcr.io/youngc01/aiostreams-curatio:latest   # pin a v* or <sha> tag in production
```

Published by `.github/workflows/curatio-publish.yml` on push to `main` / `curatio-deepbrid` / a `v*`
tag → tags `main`, `latest`, `v*`, `<sha>`.

> Deploy with **Curatio's** `docker-compose.yml` (it defines the internal-only `aiostreams` service),
> **not** this repo's `compose.yaml`.

### Runtime env (Curatio's compose sets these on the `aiostreams` service)

| Env | Value | Notes |
|---|---|---|
| `BASE_URL` | `http://aiostreams:3000` (or `AIOSTREAMS_PUBLIC_URL`) | internal only; never exposed to clients |
| `SECRET_KEY` | 64-hex | **immutable after first run** (encrypts stored configs) |
| `DATABASE_URI` | `sqlite:////app/data/db.sqlite` | self-contained; volume `aiostreams_data` |
| `INTERNAL_URL` | `http://aiostreams:3000` | |
| `PORT` | `3000` | |
| `AIOSTREAMS_AUTH` | `user:pass` | Curatio sends this as Basic auth on the `/configure` reverse-proxy |
| `AIOSTREAMS_AUTH_REQUIRED` | **`true`** | locks the config API |
| `CONFIG_ACCESS_KEY` | random secret | Curatio stamps `config.accessKey` on every create/update so the write gate passes |

> **Changed from the previous docs:** run with `AIOSTREAMS_AUTH_REQUIRED=true` **and** a
> `CONFIG_ACCESS_KEY` (Curatio stamps it) — do **not** leave `AIOSTREAMS_AUTH_REQUIRED` unset. The
> built-in proxy stays **off**: Curatio does debrid IP-limit consolidation with its own byte proxy, so
> no `proxy.id: "builtin"` is needed and the instance needs no public exposure.

### Config-API contract Curatio depends on

Curatio's `app/aiostreams_provision.py` speaks the stock AIOStreams config API — keep these stable
across upstream rebases:

| Call | Auth | Body / result |
|---|---|---|
| `POST {INTERNAL_URL}/api/v1/user` | — | `{config:{…,"accessKey":<CONFIG_ACCESS_KEY>}, password}` → `{data:{uuid, encryptedPassword}}` |
| `GET {INTERNAL_URL}/api/v1/user` | Basic `(uuid, password)` | → `{data:{userData}}` |
| `PUT {INTERNAL_URL}/api/v1/user` | Basic `(uuid, password)` | `{config:{…,"accessKey":…}}` |

Stream URL Curatio builds and serves to clients:
`{BASE_URL}/stremio/{uuid}/{encryptedPassword}/stream/{type}/{id}.json`.

### Operator flow (new server)

```bash
git clone <curatio> && cd curatio
./scripts/setup.sh          # generates POSTGRES_PASSWORD, SECRET_KEY, AIOSTREAMS_SECRET_KEY,
                            # AIOSTREAMS_CONFIG_ACCESS_KEY, AIOSTREAMS_AUTH
# then fill in .env: TMDB_API_KEY, GEMINI_API_KEY, BASE_URL, MASTER_PASSWORD
docker compose up -d
```

Then in **/admin → Streaming (AIOStreams)**:

1. **Seed profiles** — creates the two AIOStreams configs from the bundled SEL templates and stores
   their stream URLs.
2. **Edit** a profile — opens the reverse-proxied `/configure`; enter Deepbrid (+ RealDebrid / TorBox /
   Premiumize) keys and adjust filters/sorting → **Save**. Edits are live; the stream URL never changes.
3. **Update preset** (optional) — roll a new SEL baseline into a profile; Curatio reads the live config,
   merges the operator's debrid keys into the new baseline, and PUTs it back (same URL, keys preserved).
4. **Route playback through server** toggle — on: all debrid playback egresses from the server's IP
   (one IP for debrid IP-limits); off: viewers stream directly.

### `/configure` under a subpath (confirm on a running instance)

Curatio proxies `{CURATIO_ORIGIN}/admin/aiostreams/{tier}/configure/…` → internal
`/stremio/{uuid}/{encryptedPassword}/configure/…`. For the `/configure` SPA's assets and `/api/v1/*`
calls to resolve under that admin subpath, either:

- **(a)** confirm this build honors a URL base-path in `BASE_URL` (check
  `packages/core/src/config/bootstrap.ts` + the frontend base-href / API-base wiring) and set
  `BASE_URL={CURATIO_ORIGIN}/admin/aiostreams/{tier}/configure`; or
- **(b)** serve `/configure` on a dedicated internal subdomain and point the admin "Edit" link there.

Seeding and Deepbrid stream resolution work regardless of this — it only affects the in-place
config-editing UI.

---

## 5. Keeping up with upstream

`main` tracks upstream `v2.30.6`; the Deepbrid work is on branch **`curatio-deepbrid`**. To take
upstream releases: add upstream as a remote (`git remote add upstream
https://github.com/Viren070/AIOStreams`), fetch the new tag, and rebase `curatio-deepbrid` onto it —
the changes are small and marked `curatio:`.
