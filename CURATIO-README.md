# aiostreams-curatio — AIOStreams fork with native Deepbrid

A fork of **[Viren070/AIOStreams](https://github.com/Viren070/AIOStreams)** (GPL-3.0, pinned at
`v2.30.6`) that adds a **native Deepbrid debrid service**. Curatio bundles this image and provisions
it over the AIOStreams config API — operators only enter debrid keys in Curatio. See
`NOTICE-CURATIO.md` for licensing/attribution.

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

Curatio uses AIOStreams' **built-in proxy** (`proxy.id: "builtin"`), which replaces StremThru's
*stream-proxy* role. But in stock AIOStreams, **TorBox _torrents_ still call StremThru** for the
store ops: `packages/core/src/debrid/torbox.ts` delegates `checkMagnets` / `addMagnet` /
`addTorrent` / `generateTorrentLink` / `listMagnets` / `getMagnet` / `removeMagnet` and the torrent
branch of `resolve()` to an internal `StremThruService` (defaulting to the public
`builtins.stremthru.url`). To make TorBox fully native, reimplement those methods against TorBox's
own API (`@torbox/torbox-api`, already a dependency) — the operations map to:

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

### Runtime env (matches Curatio's compose service)
| Env | Value |
|---|---|
| `BASE_URL` | Public origin (must equal Curatio's `AIOSTREAMS_PUBLIC_URL`) |
| `SECRET_KEY` | 64-hex, **immutable after first run** |
| `DATABASE_URI` | `sqlite:////app/data/db.sqlite` |
| `AIOSTREAMS_AUTH` | operator `user:pass` (built-in proxy + Curatio provisioning) |
| `INTERNAL_URL` | `http://aiostreams:3000` |

Leave `AIOSTREAMS_AUTH_REQUIRED` unset so Curatio can `POST /api/v1/user`.

---

## 4. Wire into Curatio

1. Point Curatio's `docker-compose.yml` at the published image:
   `AIOSTREAMS_IMAGE=ghcr.io/youngc01/aiostreams-curatio:<tag>`.
2. In Curatio admin → **Streaming (AIOStreams)**, enter the Deepbrid key (+ RD/TorBox/Premiumize).
   Curatio injects `services:[{id:'deepbrid', enabled:true, credentials:{apiKey}}]` and provisions
   both profiles (`app/aiostreams_provision.py`).
3. In your two profile templates, set `proxy.id: "builtin"` and remove the `stremthruTorz` source
   (your operator-owned rebuild). Enable the `deepbrid` service.

---

## 5. Keeping up with upstream

`main` tracks upstream `v2.30.6`; the Deepbrid work is on branch **`curatio-deepbrid`**. To take
upstream releases: add upstream as a remote (`git remote add upstream
https://github.com/Viren070/AIOStreams`), fetch the new tag, and rebase `curatio-deepbrid` onto it —
the changes are small and marked `curatio:`.
