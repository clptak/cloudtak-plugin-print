# plugin/

The CloudTAK client-side plugin.

## Installation

Symlink this directory — not the repository root — into the CloudTAK web tree:

```sh
ln -sfn ~/dev/cloudtak-plugin-print/plugin ~/CloudTAK/api/web/plugins/print
```

`api/web/plugins/` is gitignored, so this leaves no trace in the CloudTAK repo.
Or bake it in at image build time with the `WEB_PLUGINS` build arg on `cloudtak-api`.

## Layout

| File | What it does |
|---|---|
| `index.ts` | Registers the `home-menu-print` route and the Print menu item |
| `MenuPrint.vue` | The panel: scale, paper, orientation, title block fields, submit and poll |
| `lib/api.ts` | Client for the print service behind `/print-api` |
| `lib/harvest.ts` | Captures the live style, resolves overlay sources, harvests icons |
| `lib/sheetbox.ts` | Draws and drags the sheet box on the map |
| `lib/geometry.ts` | The box's maths, kept pure so it can be tested |

## Two things worth knowing before changing this

### The route is referenced by name, not path

`PluginAPI.menu.add()` guards with `router.hasRoute()`, which only resolves route
**names**, while `MainMenuContents` pushes a menu item by name unless the string
starts with `/`. So a plugin menu item must carry the route name — `home-menu-print`,
not `/menu/print`. A path-style route is rejected before it reaches the menu, with
nothing but a `console.warn` to say so.

### The sheet box is computed in Mercator

The printed frame is a Web Mercator viewport, and Mercator inflates ground distance
by `1/cos(latitude)`. A box drawn by offsetting true ground metres would be too small
on the map by that factor — about 22% at Coconino County's latitude. Wrong in a way
that still looks plausible, which is why `lib/geometry.ts` is pure and tested rather
than inlined into the MapLibre binding.

The plugin ships inside CloudTAK's bundle and the service ships inside its own
container, so they cannot share an import of the footprint maths.
`service/test/sheetbox-geometry.test.ts` asserts the two implementations agree across
every paper size, orientation and standard scale. If they ever drift, the box on the
map stops describing the paper that comes off the plotter, and that test is the only
thing that would say so.

## Margins and scales come from the service

The panel does not carry its own copy of the margins or the scale list. `GET
/print-api` publishes `margins`, `gridGutter` and a `scales` table pairing each scale
with the UTM grid interval it prints, and the panel computes the footprint from
those. A duplicated margin constant is exactly how a box on screen silently stops
matching the sheet.

## Pointing the panel at the print service

By default the panel calls `/print-api` on the CloudTAK origin, because Caddy routes
that path inside the CloudTAK site block. Two situations break that, and both look
identical from the panel — a 200 carrying `index.html` instead of JSON:

- **`npm run serve`.** The vite dev server proxies `/api` to `localhost:5001` and
  lets every other path fall through to the SPA.
- **A deployment without `deploy/Caddyfile.snippet` installed.** CloudTAK's catch-all
  answers `/print-api` with the app shell.

Rather than patch CloudTAK's `vite.config.ts` — a tracked file, and one more thing to
carry across a core update — set an override in the browser console:

```js
localStorage.setItem('cloudtak-print-host', 'https://cloudtak.example.org')
```

Then reload. Remove it with `localStorage.removeItem('cloudtak-print-host')`.

The session token travels with the request, so the target must verify against the
same `SigningSecret` as the CloudTAK you are logged in to. Pointing a local dev
session at a production print service will fail auth if the secrets differ.

## Debugging without a build

`tools/harvest-console.js` at the repository root is a standalone version of
`lib/harvest.ts`. It lives outside this directory on purpose: everything under
`plugin/` is copied into CloudTAK's web tree and linted by that project's build, and
a plain-JS console script has no business being a hard gate on a CloudTAK image.

It is still the fastest way to reproduce a render bug against a live map without a
build. Paste it into the browser console on an open CloudTAK map and it downloads
`print-job.json`, which can be POSTed straight at `/print-api/jobs`:

```sh
TOKEN=$(docker exec cloudtak-print node -e "
const jwt=require('jsonwebtoken');
console.log(jwt.sign({email:'fidelity@local',access:'user'},process.env.SigningSecret));
")

curl -sS -X POST http://127.0.0.1:5010/print-api/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @print-job.json | python3 -m json.tool

curl -sS "http://127.0.0.1:5010/print-api/jobs/<id>?token=$TOKEN" | python3 -m json.tool
curl -sS "http://127.0.0.1:5010/print-api/jobs/<id>/result?token=$TOKEN" -o sheet.pdf
```

`warnings` on the job is the thing to read: it names any source that was dropped and
why. The plugin surfaces the same field in the panel.
