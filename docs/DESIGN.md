# cloudtak-plugin-print — Design

PDF map generation for CloudTAK.

Status: **design draft**. Sections marked **OPEN** are proposed defaults awaiting review.

---

## 0. Verified on paper

**2026-09-05 — a printed sheet measures exactly against a 1:24,000 UTM tool, and the grid labels read as expected.**

That single check validates the whole chain at once, because every link has to be right simultaneously for it to pass: the scale-to-zoom geodesy, the Web Mercator projection used to place the grid, the mark-scaling pass that lays the map out at output resolution, the `@page` declaration, the PDF MediaBox, and the grid's registration against the map beneath it. An error in any one of them would show up as a measurable offset.

Anything that changes those pieces should be re-checked the same way: print it and put a grid tool on it. Nothing in the test suite can substitute for that, because the suite cannot see the paper.

## 1. Goals

Produce a print-quality PDF map from CloudTAK — basemap plus live operational overlays — at a chosen scale on a standard American sheet, suitable for use in the field with a map, compass, and UTM grid tool.

Non-goals for v1: georeferenced PDF, USNG/MGRS grid, sheet rotation, multi-page series.

---

## 2. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Overlay content | Live CloudTAK overlays, not basemap only | A printed map without the search assignments is not the map anyone wants |
| Basemap types | Vector + raster | Forces a style-aware renderer; rules out tile mosaicing |
| Renderer | Headless Chromium + maplibre-gl-js | Pixel fidelity with CloudTAK's own client; same style spec, sprites, glyphs; no native build |
| Area selection | Scale-first (primary), fit-to-area (secondary) | Round scales are measurable in the field; fit-to-area is a convenience |
| Sheet rotation | **North-up only** | Used with map, compass, and UTM grid; rotation would make grid lines run diagonally and force per-edge label intersection |
| Grid system | **UTM only** in v1 | USNG deferred; grid engine built zone-aware so USNG is a labeling layer later, not a rewrite |
| Grid interval | Derived from scale, no UI control | Printed grid tools are cut for specific scale/interval pairings |
| Preview | Client-side box while dragging + one server render on demand | One layout engine; no per-drag server cost |
| Composition | HTML page layout via Chromium `page.pdf()` | Vector text and vector grid lines; only map imagery is raster |
| Georeferencing | Deferred, but the page-to-ground affine transform is kept in the pipeline | GeoPDF becomes an output step, not a rewrite |

---

## 3. User flow

1. Open the print panel from the CloudTAK main menu.
2. Pick a **scale**.
3. Pick a **paper size** and orientation.
4. Scale + paper + margins fully determine the ground rectangle. A box of that exact footprint appears on the map.
5. Pan/drag to position the box. The box outline and grid preview update instantly, client-side.
6. Optional: **Preview** — one low-DPI server render of the actual sheet.
7. **Print** — full-resolution job, queued. Progress reported, then a download link.

Fit-to-area mode inverts steps 2–4: draw a rectangle, pick paper, the plugin computes the scale and snaps it to the nearest standard value (adding margin rather than cropping).

### Scale math

Ground footprint is fully determined:

```
ground_meters = map_area_inches x scale x 0.0254
```

At 1:24,000, one paper inch = 609.6 m. Examples with the proposed margins:

| Paper | Orientation | Map area | Footprint @ 1:24,000 |
|---|---|---|---|
| Letter 8.5x11 | portrait | 7.5 x 8.6 in | 4.6 x 5.2 km |
| Tabloid 11x17 | portrait | 10.0 x 14.6 in | 6.1 x 8.9 km |
| ANSI D 22x34 | portrait | 21.0 x 31.6 in | 12.8 x 19.3 km |
| Arch D 24x36 | portrait | 23.0 x 33.6 in | 14.0 x 20.5 km |

---

## 4. Architecture

```
Browser (CloudTAK SPA)                  tak-network (internal)
+-------------------------+
| cloudtak-plugin-print   |
|  - menu item + route    |
|  - sheet box on map     |   POST /print-api/jobs
|  - preview outline      | ----------------------->  cloudtak-print:5010
|  - job poll + download  |                            |
+-------------------------+                            | verify JWT (SigningSecret)
                                                       | headless Chromium
                                                       |   - load style
                                                       |   - replay overlays
                                                       |   - render map raster
                                                       |   - compose HTML page
                                                       |   - page.pdf()
                                                       v
                                            cloudtak-tiles:5002  (tiles, internal)
                                            cloudtak-api:5000    (style, sprites, icons)
                                            cloudtak-store:9000  (PDF out, presigned URL)
```

### Why a separate service and not the CloudTAK API

Chromium is a ~1 GB image with a very different resource profile and failure mode than the API. Colocating it would put a CPU-saturating, OOM-prone renderer in the same container as live traffic.

### Request contract (sketch)

```jsonc
POST /print-api/jobs
{
  "title": "Assignment 3 - North Drainage",
  "incident": "24-0417",
  "scale": 24000,
  "paper": { "size": "arch-d", "orientation": "portrait" },
  "center": [-111.6543, 34.2211],       // scale-first mode
  "bbox": null,                          // fit-to-area mode (mutually exclusive)
  "dpi": 200,
  "style": { /* MapLibre style JSON as the client has it */ },
  "images": [ /* sprite images harvested from the live map, base64 RGBA */ ],
  "overlays": [ { "source": "cot", "data": { /* FeatureCollection */ } } ],
  "furniture": {
    "grid": "utm",
    "legend": true,
    "declination": true,
    "branding": "tak"
  }
}
-> 202 { "job": "01J...", "status": "queued" }

GET /print-api/jobs/:id -> { status, progress, url? }
```

The client sends the style **as it currently has it**, rather than the service re-fetching it. That is what guarantees the print matches the screen — same layer visibility, same filters, same user tweaks. `warnings` comes back on the job whenever a source was dropped or a request blocked, so a blank map is never silent.

---

## 5. Rendering pipeline

1. **Verify** the caller's CloudTAK JWT against `SigningSecret`.
2. **Rewrite** tile hosts via Chromium request interception:
   `https://tiles.cloudtak.<domain>` -> `http://cloudtak-tiles:5002`. Roughly a thousand tile requests per sheet; none of them should leave the box for a TLS handshake and a Caddy hop.  The caller's token is forwarded so a user can only print what they can already see.
3. **Render the map** into a MapLibre canvas sized in CSS pixels at the sheet's *layout* resolution, with Playwright `deviceScaleFactor` supplying the print resolution.  This is the important trick. Label collision and symbol placement happen in CSS-pixel space, so a sheet laid out at ~67 CSS DPI gets label density appropriate to a printed map viewed at arm's length, while the backing store renders at 3x for 200 DPI output. Rendering at a naive 4800x7200 CSS pixels instead would produce a map with correct resolution and absurdly sparse labels.

4. **Compose the page** as HTML with `@page { size: 24in 36in }`, the map raster placed in a frame, and the furniture laid out in CSS around it.
5. **Overlay the grid** as inline SVG so lines and labels stay vector.
6. `page.pdf()`.
7. **Upload** to MinIO, return a presigned URL.

### Canvas size limit — MEASURED

Chromium in a GPU-less Linux container reports:

```
renderer:            ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)
version:             WebGL 2.0 (OpenGL ES 3.0 Chromium)
MAX_TEXTURE_SIZE:    8192
MAX_RENDERBUFFER:    8192
```

**8192, not the 16384 typical of real hardware.** This is the binding constraint on sheet size, and it is half what the earlier arithmetic assumed. The backing store is CSS size x deviceScaleFactor, so the longest edge of the map frame caps DPI:

    max_dpi = 8192 / longest_frame_edge_inches

Output resolution is chosen from a ladder (300 / 200 / 150 / 120 / 100 / 72) rather than an arbitrary number, taking the highest rung that fits under both the texture limit and `PRINT_MAX_DPI`. A sheet too large for even 72 DPI is rejected with an explicit error rather than rendered wrong. See `service/lib/resolution.ts`.

Measured render times, bare map with no tiles, labels or overlays — a floor, not a forecast:

| Paper | DPI chosen | Backing store | Render | Bound by |
|---|---|---|---|---|
| Letter 8.5x11 | 300 | 2250 x 2700 | 3.1 s | nothing |
| Tabloid 11x17 | 300 | 3000 x 4500 | 4.3 s | nothing |
| ANSI D 22x34 | 200 | 4200 x 6400 | 6.3 s | texture limit |
| Arch E 36x48 | 150 | 5250 x 6900 | 9.4 s | texture limit |

Two things to read from this. First, the adaptive-DPI proposal was right, but for a measured reason rather than a guessed one: E-size cannot exceed 150 DPI on this box, and ANSI D cannot exceed 200. Second, **the GL rasterisation floor is single
digit seconds, not tens of seconds** — earlier estimates were pessimistic. Real sheets will be slower, but the added time will come from tile fetching and label layout, not from SwiftShader.

Node RSS stayed near 200 MB across all four, so the 4 GB container limit is generous; Chromium's own memory is the figure to watch under concurrency.

Lowering DPI costs less than it sounds like: in the finished PDF only the basemap imagery is raster. Text, grid lines and the scale bar are vector and unaffected.

### Serving the render page

MapLibre v6 ships ESM only, has no default export, and locates its worker with `import.meta.url` before spawning it as a module Worker. None of that functions on `about:blank` or a `data:` URL, so the render page is served from a synthetic
origin (`http://cloudtak-print.local`) fulfilled entirely from disk by Playwright's `page.route()`. No listening socket, and no way to reach the network by accident.

This is not scaffolding — it is the same interception hook that will rewrite public tile hosts to `cloudtak-tiles:5002`.

Playwright is also pinned to the full Chromium build in new-headless mode (`channel: 'chromium'`) rather than the default `chrome-headless-shell`, whose GL support is the weaker of the two. That matters when SwiftShader is the only renderer available.

### Translating the client's style

Three things in CloudTAK's live style only work inside a browser tab, and each needed an answer.

**Sprites are a custom protocol.** `sprite` is `cloudtak-sprite://<id>`, a MapLibre protocol backed by the client's Dexie database (`api/web/src/stores/modules/icons.ts`). There is no Dexie here, so it is rewritten to `/api/iconset/<id>/sprite` on `cloudtak-api` — the same endpoint the client's own cache-miss path falls back to, not an invented one.

**Most CoT icons are not in any sprite.** CloudTAK resolves them lazily through a `styleimagemissing` handler that reads Dexie per icon id. Reimplementing that resolver server-side would mean guessing at the same bitmap. Instead the plugin harvests the images from the live map (`map.listImages()` / `map.getImage()`) and ships them with the job as base64 RGBA; the service replays them with `map.addImage()`, both up front and from its own `styleimagemissing` handler. What prints is then literally the bitmap the user was looking at.

**Glyphs and tiles point at public hostnames.** Rewritten to the internal service addresses so a thousand requests per sheet stay on the docker network. The public hostnames are derived from CloudTAK's own `API_URL` and `PMTILES_URL` rather than configured again — a hand-written guess at the hostname silently turns every internal rewrite into an allowlist rejection.

**Overlays are fronted by a third browser-only protocol.** Overlay sources are `cloudtak-tilejson://<id>`, resolved from Dexie (`api/web/src/stores/modules/tilejson.ts`). Unlike sprites there is no server-side equivalent, so **the plugin must resolve these to concrete tile URLs before submitting**. If one reaches the service it is dropped with a warning naming the protocol, because silently losing every overlay on a printed sheet is the worst available outcome.

### The allowlist is enforced twice, on purpose

`lib/style.ts` drops sources whose host is not allowed and records a warning. That alone is not sufficient: **a TileJSON document fetched from an allowed host can name tile URLs pointing anywhere**, and nothing in the submitted style would reveal it. So `lib/render.ts` also enforces the same allowlist inside the browser, on every request, aborting anything else and reporting it on the job.

The allowlist is the internal services plus hosts named explicitly in `PRINT_ALLOW_HOSTS`, and in practice it stays **empty**. That is not a limitation: CloudTAK already proxies every non-hosted basemap through its own API. From `api/stateless/lib/tilejson.ts`, a basemap's tile URL stays its own only when it is on the PMTiles host; otherwise it becomes `${API_URL}/api/basemap/:id/tiles/{z}/{x}/{y}`. So the browser fetches `cloudtak-api`, and `cloudtak-api` fetches Caltopo, Google, ArcGIS, USGS and the rest. Adding those hosts here would widen the SSRF surface for no gain.

A consequence worth knowing: a large sheet pushes several hundred proxied tile requests through `cloudtak-api`, the same container serving live users. `PRINT_CONCURRENCY=1` bounds it, and it is the reason concurrency should not be raised casually. Non-http schemes are refused outright, and suffix matching is anchored so `basemap.nationalmap.gov.evil.com` cannot pass as a subdomain of an allowed host.

The caller's token is forwarded on every permitted request rather than the service minting one, so a user can only print what they can already see.

### Settling a render

**Do not wait on MapLibre's `idle` event.** When every source fails to fetch — an expired token, a blocked host, an unreachable API — MapLibre fires neither `load` nor `idle`, even though `map.loaded()` becomes true within a second or two. Waiting on the event hangs until the timeout on exactly the sheets that most need diagnosing, and anything hung off `load` (installing harvested icons, applying overlay data) silently never happens.

The renderer therefore polls `map.loaded()` and requires two consecutive true readings, because applying overlay data makes the map dirty again and a single reading can catch the quiet moment in between. Measured: a style whose every source fails settles in about 7s this way, against a 60s timeout before.

Tokens in the style are also **replaced, not preserved**. The style is a snapshot of the client's map, and CloudTAK stamps tokens into tile URLs when it builds TileJSON; by the time a harvested job is submitted that token can be hours old. An expired token on every tile URL fails the whole sheet, and Chromium reports the result as an opaque `net::ERR_FAILED`. The caller's token is the authoritative one — and it is only ever applied to CloudTAK's own hosts, never to a third-party basemap.

### Screen styles do not print

The first real sheet came back with ghost contours and blocky hillshading, and both had the same root cause: **the map was being laid out for a 96 dpi screen and then enlarged to 200 dpi.**

With `layoutDpi` at 96 and `deviceScaleFactor` around 2, MapLibre selects raster tiles for the *screen* zoom and Chromium stretches them to fill the page — hence visible tile blocks in anything raster, which on that sheet was two basemap layers at 0.3 and 0.4 opacity. Marks suffer the mirror-image problem: they keep their pixel size and so shrink physically. Measured on the real style, `26-Contour_12/0` is `line-width: 0.6`, which is **0.16 mm on paper** — under what most printers reproduce.

The fix has two halves and they only work together:

1. **Lay out at the output resolution** (`layoutDpi` defaults to the chosen DPI). `deviceScaleFactor` becomes 1, so MapLibre fetches tiles for the zoom actually being printed. The output pixel count is unchanged — this costs nothing.
2. **Scale every mark back up** by `layoutDpi / 96`, so a line that read as 1 px on screen occupies the same physical width on paper.

Then `PRINT_MIN_LINE_MM` (default 0.2) puts a floor under printed line width, because a style may simply specify marks too fine to print however the page is laid out. `lib/cartography.ts` handles all three forms a numeric style property can take — plain number, legacy `{base, stops}`, and expression, which is wrapped as `["max", ["*", expr, scale], min]` rather than evaluated, since it may be data-driven.

The globe projection CloudTAK uses on screen is also forced to mercator: a print sheet is a flat north-up page, and near the poles a globe would put a visible scale error on a sheet whose whole promise is that an inch means something.

### One dev-environment trap

esbuild's `keepNames`, which `tsx` enables, wraps named function expressions in a `__name()` helper. `page.evaluate` serialises its function to a string and runs it in the page, where that helper does not exist — so everything evaluated fails with `__name is not defined` under `npm run dev` and works after `tsc`. A one-line shim is installed via `addInitScript` so dev and production behave identically instead of leaving a trap that appears in only one of them.

### Measured, phase 2

Full ANSI D sheet at 200 DPI (4200 x 6400), 40 CoT symbols with harvested icons, submitted and retrieved over HTTP: **10.7 s** end to end, from an 8 KB request payload. That still contains no vector basemap tiles — the remaining unknown, and one that will be dominated by tile fetch and label layout rather than rasterisation.

## 6. UTM grid engine

The grid is drawn in UTM while the page is Web Mercator, so grid lines are **not** exactly parallel to the page edges. The skew is small near a zone's central meridian and grows toward
the edges. Lines are generated by walking UTM eastings/northings, projecting each vertex to page coordinates, and clipping to the map frame.

**Zone boundary.** Arizona straddles UTM zones 11 and 12 at 114 deg W. A sheet crossing that line has two grids that do not meet. Standard handling: extend a single zone across the whole
sheet and state it in the margin (`UTM Zone 12N (extended)`). The zone is chosen by the sheet center unless overridden.

**Labels.** Full easting/northing at the sheet corners, principal digits along the edges. Building this zone-aware from the start is what makes USNG a labeling layer later rather than a second implementation.

---

## 7. Page furniture

| Element | v1 | Notes |
|---|---|---|
| Scale bar | Yes | Dual, miles and kilometers |
| North arrow | Yes | With magnetic declination |
| UTM grid + edge labels | Yes | See section 6 |
| Title block | Yes | Map name, incident number, date/time, scale, datum, grid zone, author |
| Agency branding | Yes | Logo + incident number |
| Legend | Optional | User toggle; resizes the map frame |

**Declination** is computed offline from the World Magnetic Model (`geomagnetism` npm package), not fetched from NOAA — the container should not need egress. Note the model epoch: WMM2025 is valid through 2030 and the package must be refreshed before then.

**Legend** has a hidden dependency: it needs CloudTAK's sprite sheet and the CoT type-to-icon mapping, pulled from `cloudtak-api`. This is the main reason it is a toggle rather than always-on.

---

## 8. OPEN — proposed defaults for review

### 8.1 Paper sizes

Letter 8.5x11, Legal 8.5x14, Tabloid 11x17, ANSI C 17x22, ANSI D 22x34, Arch D 24x36, Arch E 36x48 — each in both orientations.

Reasoning: Letter and Tabloid are the workhorses because they come out of an office printer at an ICP. ANSI D and Arch D are what plotters actually take. Arch E is included for planning maps but is where the canvas limit bites.

### 8.2 Scales

1:6,000 / 1:12,000 / 1:15,840 / 1:24,000 / 1:25,000 / 1:50,000 / 1:62,500 / 1:100,000, plus custom entry. Default 1:24,000.

Reasoning: 1:24,000 is the USGS quad scale and what most people's grid tools are cut for. 1:15,840 is the old inch-to-the-quarter-mile forest scale — include it or drop it, your call.

### 8.3 Grid interval by scale

| Scale | Interval | Paper spacing |
|---|---|---|
| 1:6,000 | 200 m | 1.31 in |
| 1:12,000 | 500 m | 1.64 in |
| 1:24,000 | 1000 m | 1.64 in |
| 1:25,000 | 1000 m | 1.57 in |
| 1:50,000 | 1000 m | 0.79 in |
| 1:62,500 | 1000 m | 0.63 in |
| 1:100,000 | 5000 m | 1.97 in |

**The rows I am least sure about are 1:50,000 and 1:62,500.** Pure spacing math says use 2000 m there. Military convention says 1000 m at 1:50,000, and issued protractors assume it. I have followed convention over math — confirm that is what your teams expect.

### 8.4 Output

200 DPI default, dropped automatically where the texture limit requires it (150 for E-size) — see section 5, now measured rather than assumed. PDF to MinIO with a 7-day presigned URL.
The job returns a link, not a file body — a 24x36 sheet is large enough that streaming it back through the generating request is a bad idea.

### 8.5 Overlays included

Everything currently visible on the user's map, with a checklist in the print panel to exclude layers. Reasoning: "what I see is what prints" is the least surprising default, and exclusion is easier to reason about than opt-in.

### 8.6 Deferred to v2

Multi-page map series, GeoPDF, USNG grid, sheet rotation, saved print templates.

If the drawn area in fit-to-area mode does not fit one sheet, v1 shows the overflow and asks the user to zoom out or pick a larger sheet, rather than silently cropping.

---

## 9. Deployment

### Compose service

```yaml
  cloudtak-print:
    container_name: cloudtak-print
    build:
      context: ${HOME_DIRECTORY_PATH}/tak-stack/cloudtak-plugin-print/service
      dockerfile: Dockerfile
    restart: unless-stopped
    depends_on: [cloudtak-api, cloudtak-tiles, cloudtak-store]
    expose:
      - "5010"
    shm_size: '1gb'
    env_file: .env
    environment:
      - API_URL=${API_URL}
      - SigningSecret=${SigningSecret}
      - ASSET_BUCKET=${ASSET_BUCKET}
      - AWS_S3_Endpoint=${AWS_S3_Endpoint}
      - AWS_S3_AccessKeyId=${AWS_S3_AccessKeyId}
      - AWS_S3_SecretAccessKey=${AWS_S3_SecretAccessKey}
      - TILES_INTERNAL_URL=http://cloudtak-tiles:5002
      - PRINT_CONCURRENCY=${PRINT_CONCURRENCY:-1}
      - PRINT_MAX_DPI=${PRINT_MAX_DPI:-200}
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 4G
```

Notes:

- **Port 5010, not 5003** — `cloudtak-events` already publishes 5003.
- **`expose`, never `ports`** — following the `webhook-server` / `nodered` pattern. A service whose job is to fetch arbitrary URLs and render them is an SSRF engine on a network carrying PostGIS, MinIO, and TAK Server. It must be reachable only through Caddy, only authenticated, and it should validate requested tile URLs against an allowlist derived from CloudTAK's own basemap records.
- **`shm_size: 1gb`** — Docker's 64 MB `/dev/shm` default crashes Chromium on large canvases.
- **`PRINT_CONCURRENCY` defaults to 1** — the box's CPU limits already sum to roughly 19 and it carries live traffic. Raise it after measuring, or after TAK Server moves off this host.
- **`PRINT_MAX_DPI` defaults to 200.** Both knobs are env vars precisely because this box's resource budget is expected to change.

### Caddy

Inside the existing `cloudtak.{$PRIMARY_DOMAIN}` site block, alongside `handle /sync/*`:

```caddyfile
        handle /print-api/* {
                reverse_proxy cloudtak-print:5010
        }
```

Same-origin path rather than a subdomain, because:

- CloudTAK's Caddy block has no `forward_auth`, so XHR never meets Authentik and never gets a 302 into a login page.
- The CSP emitted by `api/nginx.conf.js` already covers same-origin under `connect-src 'self'`. A subdomain would need `NGINX_CSP_CONNECT_SRC` plus CORS.
- No new certificate, no new DNS record.

`/print-api/` and not `/print/` deliberately: CloudTAK's SPA is the catch-all `handle {}`, so a Vue route at `/print` would be intercepted by Caddy on a hard reload or a shared link.

### Repository layout

**One repo**, both halves together:

```
cloudtak-plugin-print/
  plugin/     Vue plugin, symlinked into CloudTAK's web tree
  service/    Node render service, Docker build context
  docs/
```

Chosen because the job-request contract spans both halves — every change to it touches the Vue plugin and the Node service together, and one repo makes that one commit and one diff instead of a cross-repo version-compatibility problem to reason about at deploy time.

The cost: this breaks the pattern of the other twelve `cloudtak-plugin-*` repos, where the repo root *is* the plugin and the symlink points at it directly. Here the symlink points one level in. The README must say so.

### Plugin installation

Symlink into the CloudTAK web tree:

```
~/CloudTAK/api/web/plugins/print -> ~/dev/cloudtak-plugin-print/plugin
```

Note the `/plugin` suffix — unlike the other plugins, this repo root is not the plugin.

Or bake it in at image build time via the `WEB_PLUGINS` build arg on `cloudtak-api`.

---

## 10. Phasing

1. ~~Service skeleton — JWT verification, job queue, Chromium boot, health check.~~ **Done.**
2. ~~Map render only — style + overlays to PNG at a fixed size.~~ **Done and proven**
   on 2026-09-04 against a live CloudTAK style: vector basemap, hillshade,
   contours, raster overlays, glyph labels, harvested CoT icons and cell-site
   overlays all rendered headless from a browser-harvested payload.
3. ~~Page layout — `@page`, map frame, title block. First real PDF.~~ **Done.**
   `lib/sheet.ts` composes the sheet as HTML and prints it with Chromium's
   `page.pdf()`, so the title block and neatline are vector while only the map
   imagery is raster. `@page { size: <W>in <H>in }` with `preferCSSPageSize`
   makes the paper size literal — nothing scales between the map's ground
   resolution and the paper, so a printed inch really is `scale` inches on the
   ground. Verified: an 11x17 request produces a PDF whose MediaBox is exactly
   11.00in x 17.00in. A sheet rendered with failures is stamped INCOMPLETE on the
   page itself, because a field team holding paper cannot see the job status.
4. ~~UTM grid engine, zone-aware, with edge labels.~~ **Done.** `lib/utm.ts` is the
   geodesy (Transverse Mercator series on WGS 84, MGRS bands, both zone
   irregularities); `lib/grid.ts` projects the resulting polylines with the same
   transform MapLibre used, clips them to the neatline, and emits SVG so the grid
   stays vector in the PDF. Zone is taken from the sheet centre and held across
   the whole page, so a sheet crossing 114 deg W gets one continuous grid rather
   than two that do not meet. Verified: grid spacing on the page matches the
   ground interval at the chosen scale to within 2%.
5. Plugin UI — menu, panel, sheet box, drag positioning, job polling.
6. ~~Remaining furniture — scale bar, north arrow, declination, branding.~~ **Done**
   (legend still outstanding). `lib/furniture.ts` draws a dual metric/imperial
   scale bar sized exactly in paper inches, and the three-north diagram — true,
   grid and magnetic — with declination from the offline World Magnetic Model.
   The bottom margin grew to 1.9in to carry a real title block: agency, title,
   fields, scale bar and north arrow.
7. Fit-to-area mode.
8. Benchmark on the target box; tune DPI ceilings and concurrency.
