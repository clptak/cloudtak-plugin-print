# Georeferencing

A printed sheet carries a geospatial viewport over its map frame, which makes it
a geospatial PDF: the same file prints identically, and anything driven by GDAL
can put it back on a map.

The point is not Avenza or desktop GIS. It is that a sheet produced for the
field can be re-imported into **CloudTAK, ATAK and TAK Aware** as an overlay —
so a printed operational period, with its search segments, assignments and grid,
goes back onto everyone's screen rather than ending its life on paper.

---

## 1. Why CloudTAK needs nothing added

CloudTAK's importer already accepts this. `tasks/events/src/transforms/translate.ts`
registers `.pdf`, `.tif`, `.tiff`, runs `gdal raster info --format=json` on the
upload, and refuses anything with no geotransform and no GCPs:

> The uploaded PDF does not contain geospatial information. Please upload a
> GeoPDF file with embedded georeferencing data

If it passes, CloudTAK converts it to MBTiles at `GDAL_PDF_DPI=300`, adds
overviews, and serves it through the usual PMTiles path. A sheet from this
service satisfies that check as-is.

Measured on a real 1:6,000 Letter sheet, GDAL 3.8.4:

```
Driver: PDF/Geospatial PDF
Coordinate System is: PROJCRS["WGS 84 / Pseudo-Mercator" ... ID["EPSG",3857]]
geoTransform  [-12441564.3342, 1.2394, 0.0, 4157097.5769, 0.0, -1.2394]
NEATLINE      POLYGON ((-12441471.376 4155266.298, ... ))
```

Clipped to that neatline at `GDAL_PDF_DPI=300` the raster comes out 2250 x 2805
— exactly 7.5in x 9.35in at 300 DPI — and its corners match the declared corners
to seven decimal places.

---

## 2. What is written

A `/VP` array on the page, holding one viewport over the map frame, whose
`/Measure` dictionary is subtype `/GEO`. This is the Adobe Supplement to
ISO 32000 encoding — the one GDAL writes by default and the one to prefer; the
older OGC best-practice encoding is deprecated and the TerraGo encoding is
proprietary.

```
/VP [ << /Type /Viewport
         /BBox    [ 36 118.8 576 792 ]        % map frame, PDF points, y up
         /Name    (Map frame)
         /Measure << /Type /Measure /Subtype /GEO
                     /Bounds [0 0 0 1 1 1 1 0]
                     /GPTS   [ lat lon lat lon lat lon lat lon ]
                     /LPTS   [0 0 0 1 1 1 1 0]
                     /GCS    << /Type /PROJCS /EPSG 3857 >>
                  >>
      >> ]
```

Three things are easy to get wrong here, so they are stated plainly:

**`GPTS` is latitude first.** Every other coordinate in this codebase is
`[lon, lat]`. This one is not. `test/georef.test.ts` asserts the order against
`frameCorners` so a silent transposition cannot survive.

**The corner order is SW, NW, NE, SE**, matching `LPTS` and `Bounds` read
pairwise as unit-space points. In PDF user space y increases upward, so `(0,0)`
is the bottom-left of the `BBox`.

**`GCS` is the PROJECTED system, not `/GEOGCS` with EPSG 4326.** The map is
drawn in Web Mercator, which is linear in projected metres and *not* linear in
latitude. Declaring a geographic CS makes the four-corner registration an affine
fit against latitude, which bows in the middle of the sheet: negligible at
1:6,000, worth millimetres of paper at 1:100,000. Declaring EPSG:3857 lets the
reader do the affine fit in the space the map was actually drawn in, where it is
exact.

---

## 3. Mercator inflation

A paper inch is `scale` inches on the ground, but the sheet is drawn in Web
Mercator, whose metre is inflated by `1 / cos(latitude)` — about 22% at Coconino
County's latitude. The frame therefore spans more *projected* metres than ground
metres, and it is the projected span that has to be declared.

This is the same relation `zoomForScale` in `lib/geo.ts` uses to choose the
render zoom. If the two ever drift apart the sheet prints correctly and lands in
the wrong place, which is the one failure mode worth a dedicated test — see
"the corners agree with the zoom the map was actually rendered at".

---

## 4. The neatline and the collar

GDAL rasterizes the **whole page**, not the map frame. It records the viewport
as a neatline, but CloudTAK's importer does not clip to it — it just runs
`gdal raster convert`. So an imported sheet arrives with its margins and title
block georeferenced by extrapolation, sitting over real ground: at 1:6,000 that
is about 76m on three sides and 175m below the map.

Nothing about the georeferencing is wrong; the collar is simply included. Two
ways to deal with it:

**Accept it.** The overlay has a white border and a title strip along the
bottom. Usable, and it costs nothing.

**Clip at import.** Roughly ten lines in a CloudTAK fork's `translate.ts`: read
`NEATLINE` from the `gdal raster info` JSON that transform already parses, and
pass `-projwin` on the convert. Worth doing on its own merits — every USGS 7.5'
GeoPDF has a collar too, so CloudTAK currently imports those with the legend
lying across the map.

```
gdal_translate -projwin <minX> <maxY> <maxX> <minY> sheet.pdf clipped.tif
```

Not done here, because it belongs to CloudTAK rather than to this plugin.

---

## 5. The frame had to be fixed first

`.frame` in `lib/sheet.ts` used `border: 0.5pt` with `box-sizing: border-box`,
so the map image sat half a point inside the box — while the UTM grid, drawn
from `MARGINS` directly in `routes/jobs.ts`, assumed no such inset. Map and grid
were out of register by 0.5pt.

On paper that is 0.18mm and nobody would ever see it. On the ground it is 1m at
1:6,000 and 4.2m at 1:24,000, measured against the very grid that exists to be
measured against — and georeferencing would have inherited the same error. The
neatline is now an `outline`, which takes no part in layout, so the map raster,
the grid and the declared viewport all describe one rectangle.

---

## 6. Turning it off

`georeference: false` in the print request. On by default: it costs nothing to
print, and a sheet that cannot be put back on a map is a dead end. If the step
fails the job still returns the sheet and adds a warning rather than throwing
away an expensive render.

---

## 7. Verifying a sheet

```sh
# Does it carry georeferencing at all — the check CloudTAK runs.
gdalinfo -json sheet.pdf | jq '.geoTransform, .coordinateSystem.wkt'

# Where does GDAL think the map frame is?
gdalinfo -json sheet.pdf | jq -r '.metadata."".NEATLINE'

# What CloudTAK will actually import.
GDAL_PDF_DPI=300 gdal_translate sheet.pdf sheet.tif
```

GDAL needs a PDF backend (Poppler, PDFium or PoDoFo) compiled in for any of
this; `gdalinfo --formats | grep PDF` should report `PDF -raster,vector- (rw+vs)`.

---

## 8. Still open

- Confirm the PDF driver is present in the CloudTAK events image
  (`ghcr.io/osgeo/gdal:alpine-normal-3.13.1`). The transform assumes it.
- `translate.ts` passes `SRC_METHOD=NO_GEOTRANSFORM` as `--oo`, but that is a
  warp transformer option (`-to`), not a PDF open option. It only affects the
  downsample path, which sheets from this service do not trigger — a 1:6,000
  Letter sheet computes zoom 18, under the zoom-22 clamp — but it looks like a
  latent bug.
- Confirm the import end to end in ATAK and TAK Aware, not just CloudTAK.
- No plugin UI for the toggle yet; the request field is the only control.
