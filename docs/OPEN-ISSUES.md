# Open issues

Parked problems, with what is already known and the exact next step. Written so
that picking one up later does not mean re-deriving the investigation.

---

## 1. Raster terrain shade does not render on the sheet

**Status:** open, worked around. Raised 2026-09-04, after the print-cartography fix.

**Symptom.** With the map laid out at output resolution (`layoutDpi = dpi`, zoom
14.36), the sheet renders cleanly — sharp labels, clean linework, no tile
blocking — but the raster terrain shading is entirely absent. Before that change,
at zoom 13.30 with `deviceScaleFactor` ~2, the shading *was* present, just blocky
from upsampling.

**What the shading actually is.** Two raster layers over the vector basemap, in
the harvested style:

| layer | source | type | paint |
|---|---|---|---|
| `37` | 37 | raster | `raster-opacity: 0.4` |
| `4`  | 4  | raster | `raster-opacity: 0.3` |

Source `4` is `maxzoom 16, tileSize 256`; source `37` is `maxzoom 22`. Both are
Caltopo-style tiles, so both are **proxied through `cloudtak-api`** rather than
fetched directly. Neither has a zoom range that excludes 14.36, so the style is
not filtering them out.

Note there is no `hillshade` layer and no `style.terrain` — the `raster-dem`
source `59` (`terrarium`, `minzoom 14`, `maxzoom 14`) is loaded but unused. So
this is a **raster tile problem, not a DEM/hillshade problem**, despite looking
like hillshading.

**Leading hypothesis.** Going from z13.30 to z14.36 quadruples the tile count for
every raster source. Those tiles are proxied by `cloudtak-api`, which fetches
Caltopo upstream one request at a time; the likely outcome is upstream rate
limiting, timeouts, or 403s, leaving the layers empty. The renderer would then
carry on and produce a sheet without them — which is exactly what happened.

**Next step, in order.**

1. Read `warnings` on the job. Every failed request is recorded there with its
   reason. If Caltopo/proxy failures appear, the hypothesis is confirmed and this
   is a throughput/upstream problem rather than a rendering one.
2. If `warnings` is empty, the tiles arrived and were not drawn — check whether
   `raster-opacity` at 0.3/0.4 is simply invisible against the vector basemap at
   the new zoom, and compare a `format: "png"` render at z13.3 and z14.36 of the
   same area.
3. Fetch one of those tile URLs directly from inside the container at both zooms
   and compare status codes:
   ```sh
   docker exec cloudtak-print node -e '
   const u = "http://cloudtak-api:5000/api/basemap/37/tiles/14/3111/6478?token=...";
   fetch(u).then(r => console.log(r.status, r.headers.get("content-type")));
   '
   ```

**Workaround in use.** Use a raster basemap as the base rather than a vector
basemap with raster shading over it. Loses the crisp vector labels, but the shading
is then part of the base image rather than a separate layer that can fail.

**Do not** "fix" this by reverting the layout-resolution change. That change is
what made labels and linework printable; the two are unrelated, and going back
would trade a missing overlay for an unusable sheet.
