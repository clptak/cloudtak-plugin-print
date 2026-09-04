# plugin/

The CloudTAK client-side plugin. Not built yet — that is phase 5.

## harvest-console.js

A stand-in for the plugin's submit path, so the render service can be proven
against a real vector basemap before any of the layout work is built on top of it.

Paste it into the browser console on an open CloudTAK map. It downloads
`print-job.json`.

It does the three things that can only be done in the browser, and which the
plugin will therefore have to do:

1. **Resolves `cloudtak-tilejson://<id>` overlay sources** to concrete tile URLs.
   Every overlay is fronted by that protocol, backed by the client's Dexie
   database; the service has no equivalent and drops what it cannot resolve. The
   script reads the resolved TileJSON off the live MapLibre source rather than
   reaching into Dexie.
2. **Harvests sprite images.** Most CoT icons are not in any sprite sheet — they
   are resolved lazily per id through a `styleimagemissing` handler — so without
   this the sheet renders with no icons.
3. **Captures the style exactly as it is**, including layer visibility, filters
   and any user tweaks. That is what makes the print match the screen.

It does not harvest your auth token; mint one on the VPS.

### Using it

On the dev CloudTAK, with the map view open and fully loaded, showing the area you
want:

```js
// paste the contents of harvest-console.js
```

The map is not on `window` — CloudTAK keeps it on a Pinia store
(`defineStore('cloudtak', ...)` in `api/web/src/stores/map.ts`), so the script
reaches it through the Vue app that Vue 3 stamps onto `#app` as `__vue_app__`.
It caches what it finds at `window.__map`, which is also handy for poking at the
map by hand.

Then on the VPS:

```sh
TOKEN=$(docker exec cloudtak-print node -e "
const jwt=require('jsonwebtoken');
console.log(jwt.sign({email:'fidelity@local',access:'user'},process.env.SigningSecret));
")

curl -sS -X POST http://127.0.0.1:5010/print-api/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @print-job.json | python3 -m json.tool

# then poll, and fetch the result
curl -sS "http://127.0.0.1:5010/print-api/jobs/<id>?token=$TOKEN" | python3 -m json.tool
curl -sS "http://127.0.0.1:5010/print-api/jobs/<id>/result?token=$TOKEN" -o sheet.png
```

`warnings` on the job is the thing to read: it names any source that was dropped
and why.
