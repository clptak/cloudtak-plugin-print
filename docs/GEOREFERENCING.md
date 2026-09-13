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
/VP [ 22 0 R ]

22 0 obj << /Type /Viewport
            /BBox    [ 36 82.8 576 756 ]      % map frame, PDF points, y up
            /Name    (Map frame)
            /Measure 21 0 R >>
21 0 obj << /Type /Measure /Subtype /GEO
            /Bounds [0 1 0 0 1 0 1 1]
            /GPTS   [ lat lon lat lon lat lon lat lon ]
            /LPTS   [0 1 0 0 1 0 1 1]
            /GCS    20 0 R >>
20 0 obj << /Type /GEOGCS /EPSG 4326 /WKT (GEOGCS["GCS_WGS_1984",DATUM[...]) >>
```

This is GDAL's shape, copied. Read on for why that matters more than the spec
does.

**`GPTS` is latitude first.** Every other coordinate in this codebase is
`[lon, lat]`. This one is not. `test/georef.test.ts` asserts the order against
`frameCorners` so a silent transposition cannot survive.

**The corner order is NW, SW, SE, NE**, matching `LPTS` and `Bounds` read
pairwise as unit-space points. In PDF user space y increases upward, so `(0,0)`
is the bottom-left of the `BBox`. `frameCorners` returns a NAMED record rather
than an array, because two plausible orderings and a bare four-element array is
how a map ends up mirrored.

**`GCS` is GEOGCS with EPSG 4326, even though the map is drawn in EPSG:3857.**
This is the wrong answer on paper and the only one that works — section 2a.

---

## 2a. GDAL reading it is not enough

This took three versions, because GDAL is a tolerant reader and it was the only
one asked. Each version satisfied every check in section 1.

**v1 crashed Acrobat Pro.** The measuring tool took the application down and the
geospatial tool reported nothing. Generating a reference with
`gdal_translate -of PDF` and dumping its objects showed four differences:

| | v1 | GDAL, and now this |
|---|---|---|
| `/GCS` | `/EPSG` alone | `/EPSG` **and** `/WKT`, ESRI dialect |
| `/Bounds`, `/LPTS` | `[0 0 0 1 1 1 1 0]` | `[0 1 0 0 1 0 1 1]` |
| Viewport, Measure, GCS | inline dictionaries | indirect objects |
| whole file | pdf-lib object streams | plain objects, xref table |

The `/WKT` is the one that mattered. Acrobat carries no EPSG database, so a
coordinate system given only as a number is one it cannot build a transform for.

**v2 stopped the crash and still showed no coordinates**, with the dictionaries
now identical in shape and value to GDAL's. The answer only came from driving
Acrobat directly: with the Geospatial Location tool active, right-click offers
*Mark Location*, and the marker it drops carries the coordinate as text. On v2
it read:

```
Lat: 0.00000 Long: 0.00000
```

And so did GDAL's own GeoPDF of the same map. **This Acrobat cannot resolve
EPSG:3857 at all** — it parses the dictionary, recognises the document as
geospatial, and computes zero. The projected coordinate system was never
encodable here, by us or by GDAL.

**v3 declares GEOGCS / EPSG 4326.** `GPTS` are already latitude and longitude,
so no value changes — only the declared system. Acrobat then reports live
coordinates, verified against the declared corners on a 1:6,000 Letter sheet:

| | declared | Acrobat |
|---|---|---|
| west edge | −111.763639 | −111.7636 |
| east edge | −111.751113 | −111.7512 |
| south edge | 34.936583 | 34.9366 |
| centre | −111.757376 | −111.7574 |

### What the geographic CS costs

A lat/lon affine is not linear in Mercator y, so the registration bows slightly
between the north and south edges. Worst case mid-sheet, at this latitude:

| sheet | 1:6,000 | 1:24,000 | 1:100,000 |
|---|---|---|---|
| Letter | 0.03 m | 0.44 m | 7.7 m |
| Tabloid | 0.07 m | 1.20 m | 20.8 m |
| Arch E | 0.68 m | 10.9 m | 189.8 m |

As a fraction of the sheet that is under 0.1 mm of paper everywhere except the
largest sheets at the smallest scales, where it reaches about 2 mm. If that ever
matters, the fix is more `GPTS`/`LPTS` points rather than a different CS: the
spec allows a lattice, and interpolating between rows removes the bow.

GDAL still reads the sheet with the geographic CS — WGS 84, geotransform
present, neatline present — so CloudTAK's import check is unaffected.

The rule this leaves behind: **where the spec allows latitude, match GDAL's
output rather than the prose.** Acrobat is the stricter reader, GDAL's writer is
the one Acrobat has been made to work with, and a reference file is cheap:

```sh
gdal_translate -of GTiff -a_srs EPSG:3857 -a_ullr <ulx> <uly> <lrx> <lry> in.png ref.tif
gdal_translate -of PDF ref.tif ref.pdf   # then read ref.pdf's objects
```

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

## 4. The collar

GDAL rasterizes the **whole page**, not the map frame, and CloudTAK's importer
does not clip to the neatline -- it runs `gdal raster convert` on what it is
given. So the sheet's margins and title strip arrive in the overlay,
georeferenced by extrapolation and lying over real ground: about 300 m on three
sides at 1:24,000 and 700 m along the bottom.

That is a real defect and it looked exactly as bad as it sounds. Two fixes were
tried and rejected before the right one:

- **Clip to the neatline at import.** Correct, about ten lines, and it fixes
  USGS quads too -- every one of them has a collar. But it is a patch to
  CloudTAK, carried across every upstream merge.
- **Remove the margins and run the map to the paper edge**, with the title block
  lying on the map. No collar to clip. It also makes an ugly printed map, which
  is the sheet's primary job, so it lasted one commit.

**The actual cause was never the margin. It was painting it white.**

A page that declares no background is left unpainted, and prints identically --
white paper is white whether or not you put white ink on it. Rendered with
`GDAL_PDF_BANDS=4`, the unpainted area comes through as alpha 0, the MBTiles
tiles are RGBA, and the collar simply is not there in the overlay. The sheet
keeps a proper collar on paper and casts none onto the map.

Measured on a 1:24,000 Letter sheet:

| | |
|---|---|
| page painted white (before) | alpha 255 over 100% of the page |
| page unpainted (now) | alpha 0 over 23.5% -- top margin mean alpha 3.0, map centre 255.0 |
| through to tiles | 62 of 62 RGBA tiles carry transparent pixels |

What still paints in the margin is the ink that was always there: the grid
labels, the title text, the north diagram. In an overlay those read as thin dark
marks over the basemap rather than a white slab, and they are the sheet telling
you which sheet it is.

### The one deployment requirement

`GDAL_PDF_BANDS=4` must be set on CloudTAK's **events** container. The transform
spreads `...process.env` into every GDAL call, so an environment variable is
enough -- there is no code change:

```yaml
    events:
        environment:
            - GDAL_PDF_BANDS=4
```

Without it nothing breaks: GDAL renders RGB, and the collar is white in the
overlay exactly as it is today. The sheet is unchanged either way.

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

A **GeoPDF** toggle in the print panel, on by default, sending `georeference`
in the request. On by default because it costs nothing to print -- the viewport
is invisible to a printer -- and a sheet that cannot be put back on a map is a
dead end. The toggle exists because it is not free everywhere: it adds a
dictionary that third-party PDF tooling has opinions about, as section 2a is
three rounds of evidence for.

If the step fails the job still returns the sheet and adds a warning, rather
than throwing away an expensive render over the last kilobyte of it.

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
- Confirm the import end to end in ATAK and TAK Aware. Acrobat Pro is settled
  (section 2a); CloudTAK is settled by section 1; the two TAK clients are not.
- The toggle is not remembered between sessions, unlike marker size. It defaults
  to on every time, which is the wanted behaviour until somebody says otherwise.
