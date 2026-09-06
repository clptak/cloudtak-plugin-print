# cloudtak-plugin-print

Generate print-quality PDF maps from CloudTAK — basemap plus live operational overlays — at a chosen scale on a standard American sheet, for use in the field with a map, compass, and UTM grid tool.

> **This repo is not shaped like the other `cloudtak-plugin-*` repos.**
> It contains both a client-side plugin *and* a Docker service, so the symlink into CloudTAK points at `plugin/`, not at the repo root. See below.

## Layout

```
plugin/     Vue plugin, installed into CloudTAK's web tree
service/    Node render service (headless Chromium), Docker build context
deploy/     Compose service block, Caddyfile snippet, VPS runbook
tools/      harvest-console.js — reproduce a render bug without a build
docs/       DESIGN.md — read this first
```

One repo because the job-request contract spans both halves: every change to it touches the plugin and the service together, and one commit beats a cross-repo version-compatibility problem discovered during a callout.

## Status

Working end to end: pick a scale and sheet size in the panel, drag the box on the map, print. The sheet carries your live basemap and overlays, a zone-aware UTM grid with edge labels, a dual metric/imperial scale bar, a three-north diagram with declination from the offline World Magnetic Model, a title block, and optionally a Data Sync invite QR.

Printed sheets measure correctly against a 1:24,000 UTM tool.

Not done: an overlay legend, fit-to-area mode, GeoPDF, USNG. `docs/DESIGN.md` section 10 has the phase plan; `docs/OPEN-ISSUES.md` has the one parked defect (raster terrain shade).

## Install

Three pieces: the plugin goes into CloudTAK's web build, the service becomes a container, and Caddy routes `/print-api` to it. All three are required — the plugin without the service shows an error panel, and the service without Caddy is unreachable from a browser.

### 0. Where to put this repository

Clone it **beside your CloudTAK checkout, inside the stack directory** — the same directory holding `docker-compose.yml`:

```
~/tak-stack/
├── docker-compose.yml
├── Caddyfile
├── CloudTAK/                     your CloudTAK checkout
│   └── api/
│       └── web/plugins/print/    <- the plugin is copied here
└── cloudtak-plugin-print/        <- this repository
    └── service/                  <- the compose build context
```

Compose build contexts are resolved relative to the compose file, so this layout is what makes `context: ./cloudtak-plugin-print/service` work. Anywhere else and you are editing paths.

```sh
cd ~/tak-stack
git clone https://github.com/clptak/cloudtak-plugin-print.git
```

### 1. Plugin

**On a deployment**, copy it into the web tree before building the API image. Docker will not follow a symlink out of its build context, so this is a copy:

```sh
cd ~/tak-stack
rm -rf CloudTAK/api/web/plugins/print
cp -r cloudtak-plugin-print/plugin CloudTAK/api/web/plugins/print
```

**For development**, a symlink is better — edits show up without re-copying:

```sh
ln -sfn ~/dev/cloudtak-plugin-print/plugin ~/CloudTAK/api/web/plugins/print
```

Note the `/plugin` suffix in both. The other plugins install their repo root; this one cannot, because the root also holds the service.

`api/web/plugins/` is gitignored, so neither leaves a mark on your CloudTAK repo.

> `WEB_PLUGINS` cannot install this repo. That build arg clones a repo into
> `plugins/<repo-name>/` and CloudTAK's loader then looks for
> `plugins/<repo-name>/index.ts`, which does not exist here — the plugin is one
> level down. Hence the copy.

Rebuilding the API image is what compiles the plugin in:

```sh
docker compose build cloudtak-api && docker compose up -d cloudtak-api
```

### 2. Service

Paste the `cloudtak-print` block from `deploy/compose.service.yml` into the `services:` section of your `docker-compose.yml`.

Copy `service/.env.example` for the variable list. Only `SigningSecret` is strictly required — the same value the other CloudTAK services already use, which is how the service verifies CloudTAK's own JWTs.

```sh
docker compose build cloudtak-print
docker compose up -d cloudtak-print
```

### 3. Caddy

Follow `deploy/Caddyfile.snippet`. It is deliberately hostname-free: you paste a named snippet at the top level of your Caddyfile, then add **one line** — `import cloudtak_print` — inside whichever site block already serves CloudTAK.

Identify that block by its contents, not its name: it is the one containing `reverse_proxy cloudtak-api:5000`. Deployments call it `cloudtak.example.org`, `map.example.org`, `tak.example.org` — the snippet never needs to know.

```sh
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec caddy caddy reload   --config /etc/caddy/Caddyfile
```

Then check **both** paths:

```sh
curl -sS https://YOURHOST/print-api/health
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://YOURHOST/print-api
```

The second must report `application/json`. `text/html` means CloudTAK's SPA is still answering `/print-api` and the snippet is not in effect.

> Check both, not just the first. A `handle /print-api/*` matcher covers
> `/print-api/health` but **not** the bare `/print-api` — which is the info route
> the panel calls before anything else. The health check passes while the panel is
> broken. The shipped snippet matches both paths; this note is why.

If the build fails at `playwright install` with a download error, the network blocks Playwright's browser CDN. Build against the distro Chromium instead:

```sh
docker compose build \
  --build-arg CHROMIUM_SOURCE=distro \
  --build-arg CHROMIUM_PATH=/usr/bin/chromium \
  cloudtak-print
```

`deploy/VPS-TESTING.md` is the full runbook for bringing this up on the VPS without exposing it.

## Updating

```sh
./cloudtak-plugin-print/deploy/update.sh
```

Pulls, installs the plugin into CloudTAK's web tree, and rebuilds **only what changed**. That distinction matters: `cloudtak-print` builds in seconds, while `cloudtak-api` rebuilds the entire CloudTAK web application and takes minutes of downtime — so a service-only change should never trigger it, and a docs-only change should rebuild nothing at all.

| | |
|---|---|
| `--force` | rebuild both regardless |
| `--check` | report how far behind you are, change nothing |
| `STACK_DIR`, `CLOUDTAK_DIR` | override the assumed layout |
| `PRINT_HOST` | also check the public route through Caddy afterwards |

It refuses to run with uncommitted changes in the repository, refuses if the paths do not look like a stack, and refuses to delete a plugin destination that is not a `.../api/web/plugins/print` path. It also warns if `PRINT_LAYOUT_DPI` is set to 96 anywhere, which lays the map out at 96 DPI and enlarges it — soft contours and
blocky hillshade.

## Verifying the render path

The one genuine unknown is whether Chromium under SwiftShader gives MapLibre a working GL context on your box. Two endpoints answer that without involving tiles, styles, or CloudTAK auth, so a failure is unambiguously a Chromium problem:

```sh
# What WebGL does Chromium actually provide?
curl -s "https://YOURHOST/print-api/smoke/webgl?token=$TOKEN" | jq

# Render a trivial MapLibre map and look at it.
curl -s "https://YOURHOST/print-api/smoke/render?token=$TOKEN&scale=2" -o smoke.png
```

A healthy result reports `"ok": true` with a `renderer` naming SwiftShader or ANGLE. If `ok` is false, nothing downstream can work — fix that first.

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

Auth is a CloudTAK JWT, HS256 against the shared `SigningSecret`, sent as a `Bearer` header or a `?token=` query parameter. Jobs are readable only by the identity that submitted them.

## License

See `LICENSE`.
