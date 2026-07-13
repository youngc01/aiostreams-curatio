# aiostreams-curatio — AIOStreams fork with native Deepbrid

A fork of **[Viren070/AIOStreams](https://github.com/Viren070/AIOStreams)** (GPL-3.0, pinned at
`v2.30.6`) that adds a **native Deepbrid debrid service**. Curatio bundles this image, keeps it
**fully internal**, and manages it as **two profiles**, each an AIOStreams user config with a stable
stream URL. **Debrid keys are set through a Curatio-native form and saved to each config over the
AIOStreams config API — Curatio never stores them.** See `NOTICE-CURATIO.md` for licensing/attribution.

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

## 4. Curatio integration (config-API native)

Curatio bundles this image, keeps it **fully internal**, and manages it as **two profiles**
("Low Bandwidth" / "High Bandwidth"), each an AIOStreams user config with a stable stream URL. Curatio
seeds the two configs, serves their streams, and edits each profile in place over the AIOStreams config
API. AIOStreams' own `/configure` UI is **not** used or exposed. **Debrid keys are set through a
Curatio-native form and live inside each AIOStreams config — Curatio never stores them.**

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

### Runtime env for a Curatio-managed instance

When this image runs as Curatio's bundled, internal AIOStreams (single operator, every config created
by Curatio), run it with the env below. Curatio's `docker-compose.yml` sets all of these; they're
listed here so a fresh deploy has them from the start.

| Env | Value | Why |
|---|---|---|
| `BASE_URL` | internal origin, e.g. `http://aiostreams:3000` (or `AIOSTREAMS_PUBLIC_URL`) | internal only; never exposed to clients |
| `SECRET_KEY` | 64-hex | **immutable after first run** — encrypts stored configs |
| `DATABASE_URI` | `sqlite:////app/data/db.sqlite` | self-contained; back up the volume (`aiostreams_data`) |
| `INTERNAL_URL` | `http://aiostreams:3000` | |
| `PORT` | `3000` | |
| `AIOSTREAMS_AUTH` | `user:pass` | instance operator credential (dashboard / config API); enforced when `AIOSTREAMS_AUTH_REQUIRED=true` |
| `AIOSTREAMS_AUTH_REQUIRED` | **`true`** | gate config writes (locks the config API) |
| `CONFIG_ACCESS_KEY` | shared secret | must **equal** Curatio's `AIOSTREAMS_CONFIG_ACCESS_KEY`; Curatio stamps `config.accessKey` so `POST`/`PUT /api/v1/user` passes the write gate |
| `REGEX_FILTER_ACCESS` | **`all`** | Curatio owns every config; without this, configs that sync regex from external URLs (Tamtaro/Vidhin) fail creation |
| `SEL_SYNC_ACCESS` | **`all`** | same, for Stream Expression Language (SEL) sync URLs |

> The built-in proxy stays **off**: Curatio does debrid IP-limit consolidation with its own byte proxy,
> so no `proxy.id: "builtin"` is needed and the instance needs no public exposure.

#### The two that bite you if missing

- **`REGEX_FILTER_ACCESS=all` + `SEL_SYNC_ACCESS=all`.** The default is `trusted`, which only allows a
  whitelist of regex/SEL sync URLs for non-trusted configs. Curatio-created configs are "non-trusted,"
  so seeding a config that references synced regex/SEL URLs 400s with:
  > `Invalid config for new user: Forbidden URL(s) in regex configuration: https://…`

  Setting both to `all` is correct here because the operator controls every config (there are no
  untrusted public users). For a public multi-user instance you'd keep `trusted` + a whitelist instead.

- **`AIOSTREAMS_AUTH_REQUIRED=true` + a matching `CONFIG_ACCESS_KEY`.** Curatio stamps the access key
  into every config it creates/updates. If the key doesn't match (or the gate is off), config writes
  are rejected. Keep the same value on both sides.

#### Credential-free seeding (no fork change needed)

AIOStreams correctly validates the **required credentials of enabled services and presets at config
creation** — e.g. an enabled `torbox` service or a `debridio` scraper preset with no key fails with
`Option apiKey is required, got undefined`. Curatio handles this on its side (`prepare_seed_config`
disables keyless-enabled services and drops key-required presets before seeding, then adds keys via its
Keys form). So this image needs no change — it validates as normal; just be aware that a raw
credential-free config posted directly (outside Curatio) will be rejected, by design.

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

### Operator flow (no debrid keys in Curatio)

```bash
git clone <curatio> && cd curatio
./scripts/setup.sh          # generates POSTGRES_PASSWORD, SECRET_KEY, AIOSTREAMS_SECRET_KEY,
                            # AIOSTREAMS_CONFIG_ACCESS_KEY, AIOSTREAMS_AUTH
# fill in .env: TMDB_API_KEY, GEMINI_API_KEY, BASE_URL, MASTER_PASSWORD
docker compose up -d
```

Then in **/admin → Streaming (AIOStreams)**:

1. **Seed profiles** — creates the two AIOStreams configs from the bundled SEL templates and
   stores their stream URLs.
2. **Keys** — a Curatio-native form to set each debrid API key (Deepbrid / RealDebrid / TorBox /
   Premiumize) and toggle it on. Saved straight to the profile's live AIOStreams config via the
   config API; the stream URL never changes. Curatio never stores the keys.
3. **Advanced** — a raw-JSON editor over the profile's full live config for filters/sorting and
   any non-debrid service (e.g. StremThru). **Update preset** still ships a new SEL baseline while
   preserving the live debrid keys.
4. **Route playback through server** toggle — on: all debrid playback egresses from the server's
   IP (one IP for debrid IP-limits); off: viewers stream directly.

> Curatio edits AIOStreams entirely over its config API (`GET`/`PUT /api/v1/user`, uuid/password +
> `CONFIG_ACCESS_KEY`). AIOStreams' own `/configure` UI is **not** used or exposed — the instance
> stays fully internal and Curatio is the only public origin.

---

## 5. Keeping up with upstream

`main` tracks upstream `v2.30.6`; the Deepbrid work is on branch **`curatio-deepbrid`**. To take
upstream releases: add upstream as a remote (`git remote add upstream
https://github.com/Viren070/AIOStreams`), fetch the new tag, and rebase `curatio-deepbrid` onto it —
the changes are small and marked `curatio:`.
