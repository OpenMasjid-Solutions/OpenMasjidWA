<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# OpenMasjidWA — OpenWA, packaged for OpenMasjidOS

This repository contains **no application code**. It is the packaging that lets
[OpenWA](https://github.com/rmyndharis/OpenWA) — a free, MIT-licensed, self-hosted
WhatsApp API gateway by [rmyndharis](https://github.com/rmyndharis) — be installed
from the OpenMasjidOS App Store with one click.

We run upstream's published image **unmodified**, pinned by digest. All credit for
the software belongs to its authors.

| | |
|---|---|
| Catalog app id | `openwa` |
| Upstream | `rmyndharis/OpenWA` |
| Image | `ghcr.io/rmyndharis/openwa:0.18.0@sha256:e576c215…` |
| Port | `2785` (REST API and the setup UI are the same port) |
| Gateway key env var | `API_MASTER_KEY` (seeded from the `OPENWA_API_KEY` setting) |
| Session id | **not settable from env** — OpenWA mints a UUID; see below |

## Why this repo exists at all

Upstream's own `docker-compose.yml` cannot be listed in the catalog. Run through
OpenMasjidAPPS' safety gate it produces **ten hard errors** — it builds from source
rather than referencing a published image, mounts the host Docker socket through a
socket proxy, and attaches to pre-existing external volumes and networks. Those are
refused both by the catalog build and by OpenMasjidOS at install time, by design.

None of that is a criticism of upstream: their compose is built for an operator who
owns the host, and it is careful and well-documented. It simply is not the shape a
one-click app store can accept. So this repo carries a minimal, least-privilege
stack — one container, one named volume, configuration entirely from settings — and
nothing else.

## The manual step, and why

OpenMasjidOS drives everything else, but **someone must create AND START the OpenWA
session by hand, once.** Three facts combine to force it:

1. **OpenWA has no way to create a session from configuration.** There is no env var
   for it in v0.18.0 — `AUTO_START_SESSIONS` only re-starts a session that was
   *already* linked (it selects rows with a non-null `phone`), which is why we set it:
   a reboot does not cost you a re-link, but it cannot bootstrap anything.
2. **The session id is a server-generated UUID.** Every session route is declared
   `@Param('id', ParseUUIDPipe)`; `POST /api/sessions` takes a `name`, and OpenWA
   assigns the id. So the id cannot be agreed in advance by either side.
3. **Creating a session does not start it.** `SessionService.create()` persists the
   row with `status: CREATED` and registers no engine, and the dashboard's create
   form does not start it either. `POST /api/sessions/{id}/pairing-code` then throws
   `BadRequestException('Session is not started. Call POST /sessions/:id/start
   first.')` — and OpenMasjidOS discards the gateway's response body, so the admin
   sees a bare `gateway returned 400` with no clue what to do.

So the documented flow is: create the session, press **Start**, then press **View**
and copy the full **Session ID** (the card truncates it to 12 characters and offers
no copy control — the details panel is the only place the whole UUID is shown).

**All of this disappears** if OpenMasjidOS calls `POST /api/sessions` and then
`POST /api/sessions/{id}/start` itself, storing the returned id — it already holds
the key and the base URL. That is a platform-side change, not a packaging one, and
it is the single biggest usability win available here.

## Configuration decisions worth knowing

- **`whatsapp-web.js` is the default engine.** Upstream rates its ban risk lower than
  baileys because it drives a real headless Chromium — at ~300–500 MB per session.
- **Upstream's `SEND_PACING_*` governor is OFF.** OpenMasjidOS owns the single paced
  queue for the whole masjid. A second governor would refuse sends with HTTP 429, and
  the platform's queue currently reads a 429 as a failed send rather than "retry after
  N seconds" — so a message would be dropped rather than delayed.
- **`SIMULATE_TYPING=false`.** The platform sends its own typing indicators, scaled to
  message length; upstream's would stack a second delay on every send.
- **`CSP_UPGRADE_INSECURE_REQUESTS=false`.** Apps are served over plain HTTP, and at
  its production default the dashboard's own CSP upgrades its scripts to `https://`,
  which the non-TLS server cannot answer — the setup page renders blank white
  (upstream #611/#731).
- **`MAX_CONCURRENT_SESSIONS=1`.** One masjid, one number, and a hard bound on the
  memory story.

## Releasing

Follow OpenMasjidAPPS `docs/BUILDING_AN_APP.md`, including §2b.1: bump `version`, let
CI publish, commit the `@sha256` digest, and **tag the commit that carries the
digest** — not the one before it.

## Licence

The packaging in this repository is **AGPL-3.0-only**. **OpenWA itself is MIT** and is
neither modified nor relicensed here; the manifest's `license` field reports `MIT`,
because that is the licence of the software a masjid actually installs.
