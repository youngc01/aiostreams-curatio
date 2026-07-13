# NOTICE — Curatio fork of AIOStreams

This repository is a fork of **[Viren070/AIOStreams](https://github.com/Viren070/AIOStreams)**,
licensed under the **GNU General Public License v3.0 (GPL-3.0)**. This fork remains under
GPL-3.0. See `LICENSE` for the full text.

## Changes in this fork

- Added a **native Deepbrid debrid service** (`packages/core/src/debrid/deepbrid.ts`) and wired it
  into the service list, `SERVICE_DETAILS`, and the debrid factory. Deepbrid is resolved via
  Deepbrid's own API and does **not** route through StremThru.

The Deepbrid integration is ported in spirit from **[Cxsmo-ai/Deepbridge](https://github.com/Cxsmo-ai/Deepbridge)**
(Apache License 2.0). Where code or non-trivial logic is derived from Deepbridge, its Apache-2.0
license and attribution are preserved. The Apache-2.0 material is redistributed here as part of a
GPL-3.0 work (Apache-2.0 → GPL-3.0 is one-way compatible).

## Trademark

"AIOStreams" is the name of the upstream project. This fork is **based on AIOStreams** and is not the
official AIOStreams addon.
