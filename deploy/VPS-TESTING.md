# Running the print service on the VPS

The render service is tested on the box it ships to, rather than against a local
CloudTAK stack. A local stack would mean reproducing Postgres with the basemap
rows, MinIO with the PMTiles, and the API — three things to keep in sync with a
fork that is actively patched.

That box also carries live SAR traffic, so every step below is contained and
reversible.

## What keeps this safe

- **No published port on 0.0.0.0.** During testing the service binds to
  `127.0.0.1` only, the same pattern already used for `cloudtak-postgis` and
  `authentik-server`. Nothing is reachable from the internet until the Caddy
  block is added, which is the last step and a separate decision.
- **`PRINT_CONCURRENCY=1`** and a 2 CPU / 4 GB cap, so a runaway render cannot
  starve TAK Server.
- **`PRINT_ALLOW_HOSTS` empty**, so the renderer can reach nothing but
  `cloudtak-api` and `cloudtak-tiles`.
- Nothing in the CloudTAK stack is modified. The service is additive.

## 1. Get the code onto the box

```sh
cd ~/tak-stack
git clone https://github.com/clptak/cloudtak-plugin-print.git
```

The compose build context is `${HOME_DIRECTORY_PATH}/tak-stack/cloudtak-plugin-print/service`,
so the clone must land at that path.

## 2. Add the service to docker-compose.yml

Copy the block from `deploy/compose.service.yml`, with one change for testing —
replace:

```yaml
    expose:
      - "5010"
```

with:

```yaml
    ports:
      - "127.0.0.1:5010:5010"
```

Loopback only. This is what makes the service testable with `curl` from the host
without exposing it; revert it to `expose` before adding the Caddy block.

## 3. Build

```sh
docker compose build cloudtak-print
```

The first build pulls roughly 1 GB. **If it fails at `playwright install` with a
download error**, this network blocks Playwright's browser CDN — which has been
observed on other networks, so it is a normal outcome rather than a broken build.
Use the distro Chromium instead:

```sh
docker compose build \
  --build-arg CHROMIUM_SOURCE=distro \
  --build-arg CHROMIUM_PATH=/usr/bin/chromium \
  cloudtak-print
```

That build needs no CDN access. The Chromium version is then whatever Debian
ships rather than the version Playwright pins, so check step 5 carefully.

To make it stick, add the same two args under `build:` in the compose block:

```yaml
    build:
      context: ${HOME_DIRECTORY_PATH}/tak-stack/cloudtak-plugin-print/service
      dockerfile: Dockerfile
      args:
        CHROMIUM_SOURCE: distro
        CHROMIUM_PATH: /usr/bin/chromium
```

## 4. Start it

```sh
docker compose up -d cloudtak-print
docker compose logs -f cloudtak-print
```

Expected:

```
ok - loaded routes/base.ts
ok - loaded routes/jobs.ts
ok - loaded routes/smoke.ts
ok - print service on http://localhost:5010
ok - concurrency=1 maxDpi=200 layoutDpi=96
ok - chromium ready
```

`ok - chromium ready` is the one that matters. If it says
`not ok - chromium failed to launch`, stop here and send the error.

## 5. Verify the render path

Health needs no auth:

```sh
curl -s localhost:5010/print-api/health
curl -s localhost:5010/print-api | python3 -m json.tool
```

Everything else needs a CloudTAK token. Mint one from the shared secret rather
than copying one out of the browser:

```sh
TOKEN=$(docker exec cloudtak-print node -e "
const jwt=require('jsonwebtoken');
console.log(jwt.sign({email:'$USER@local',access:'user'},process.env.SigningSecret));
")
```

**The important one** — what WebGL this box actually provides:

```sh
curl -s "localhost:5010/print-api/smoke/webgl?token=$TOKEN" | python3 -m json.tool
```

A healthy result looks like:

```json
{
    "ok": true,
    "contextType": "webgl2",
    "renderer": "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
    "maxTextureSize": 8192
}
```

If `maxTextureSize` comes back **above 8192**, raise `PRINT_MAX_TEXTURE` to match
and the large sheets get more resolution for free. If `ok` is false, nothing
downstream can work — send the output.

Then a picture, to confirm it is not just reporting a context but using one:

```sh
curl -s "localhost:5010/print-api/smoke/render?token=$TOKEN&scale=2" -o /tmp/smoke.png
file /tmp/smoke.png
```

A dark green field, a yellow line, three red dots.

## 6. Time a real sheet

```sh
time curl -s -X POST localhost:5010/print-api/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"timing","scale":24000,"paper":{"size":"ansi-d","orientation":"portrait"},"center":[-111.65,35.2]}' \
  | python3 -m json.tool
```

With no `style` this renders the test pattern at full ANSI D dimensions, which
measures this box's rasterisation speed without involving tiles. Poll it:

```sh
curl -s "localhost:5010/print-api/jobs/<id>?token=$TOKEN" | python3 -m json.tool
```

Reference figures from a GPU-less container: 4200 x 6400 at 200 DPI in about 6 s.
A materially slower number means `PRINT_CONCURRENCY` should stay at 1 for good.

## 7. What to report back

- The `smoke/webgl` output, verbatim.
- Whether the build needed `CHROMIUM_SOURCE=distro`.
- The time from step 6.
- The basemap host census (see the queries in `docs/DESIGN.md`, or ask).

## Rollback

```sh
docker compose stop cloudtak-print
docker compose rm -f cloudtak-print
```

Then remove the block from `docker-compose.yml`. Nothing else in the stack was
touched, and no CloudTAK data was written.

## Going live (later, not now)

1. Change `ports:` back to `expose:`.
2. Follow `deploy/Caddyfile.snippet`: paste the `(cloudtak_print)` snippet at the
   top level of the Caddyfile, then add `import cloudtak_print` inside whichever
   site block already serves CloudTAK — the one containing
   `reverse_proxy cloudtak-api:5000`.
3. `docker compose up -d cloudtak-print && docker compose restart caddy`.

Only do this once the plugin UI exists and there is a reason for a browser to
reach the service.
