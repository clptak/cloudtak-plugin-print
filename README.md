# cloudtak-plugin-print

Generate print-quality PDF maps from CloudTAK — basemap plus live operational
overlays — at a chosen scale on a standard American sheet, for use in the field
with a map, compass, and UTM grid tool.

Modeled on Caltopo's print feature.

> **This repo is not shaped like the other `cloudtak-plugin-*` repos.**
> It contains both a client-side plugin *and* a Docker service, so the symlink
> into CloudTAK points at `plugin/`, not at the repo root. See below.

## Layout

```
plugin/     Vue plugin, symlinked into CloudTAK's web tree
service/    Node render service (headless Chromium), Docker build context
deploy/     Compose service block and Caddyfile snippet
docs/       DESIGN.md — read this first
```

One repo because the job-request contract spans both halves: every change to it
touches the plugin and the service together, and one commit beats a cross-repo
version-compatibility problem discovered during a callout.

## Status

**Phase 1 — service skeleton.** Auth, job queue, Chromium lifecycle, sheet
geometry, and WebGL diagnostics. It renders a dependency-free test map at real
sheet dimensions; it does not yet render your basemap, overlays, grid, or a PDF.

See `docs/DESIGN.md` section 10 for the phase plan.

## Install

### Plugin

```sh
ln -s ~/dev/cloudtak-plugin-print/plugin ~/CloudTAK/api/web/plugins/print
```

Note the `/plugin` suffix. The other plugins symlink their repo root; this one
cannot.

### Service

Add `deploy/compose.service.yml` to the tak-stack `docker-compose.yml`, and the
`handle /print-api/*` block from `deploy/Caddyfile.snippet` to the existing
`cloudtak.{$PRIMARY_DOMAIN}` site block.

Copy `service/.env.example` for the variable list. Only `SigningSecret` is
strictly required — it is the same value the other CloudTAK services already use.

```sh
docker compose build cloudtak-print
docker compose up -d cloudtak-print
```

## Verifying the render path

The one genuine unknown is whether Chromium under SwiftShader gives MapLibre a
working GL context on your box. Two endpoints answer that without involving
tiles, styles, or CloudTAK auth, so a failure is unambiguously a Chromium problem:

```sh
# What WebGL does Chromium actually provide?
curl -s "https://cloudtak.$DOMAIN/print-api/smoke/webgl?token=$TOKEN" | jq

# Render a trivial MapLibre map and look at it.
curl -s "https://cloudtak.$DOMAIN/print-api/smoke/render?token=$TOKEN&scale=2" -o smoke.png
```

A healthy result reports `"ok": true` with a `renderer` naming SwiftShader or
ANGLE. If `ok` is false, nothing downstream can work — fix that first.

`$TOKEN` is any valid CloudTAK JWT; grab one from the browser's network tab.

## Local development

```sh
cd service
npm install
npx playwright install chromium
SigningSecret=dev npm run dev
```

```sh
npm run lint     # eslint
npm run check    # tsc --noEmit
npm test         # node:test via tsx
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/print-api` | no | Service info, paper sizes, current limits |
| GET | `/print-api/health` | no | Liveness probe for Gatus and the healthcheck |
| GET | `/print-api/smoke/webgl` | yes | WebGL context diagnostics |
| GET | `/print-api/smoke/render` | yes | Dependency-free MapLibre render, PNG |
| POST | `/print-api/jobs` | yes | Queue a sheet |
| GET | `/print-api/jobs/:id` | yes | Poll status |
| GET | `/print-api/jobs/:id/result` | yes | Download the artifact |

Auth is a CloudTAK JWT, HS256 against the shared `SigningSecret`, sent as a
`Bearer` header or a `?token=` query parameter. Jobs are readable only by the
identity that submitted them.

## License

See `LICENSE`.
