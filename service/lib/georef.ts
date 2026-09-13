/**
 * Georeference a printed sheet in place.
 *
 * Chromium's PDF writer knows nothing about geography, so a sheet leaves
 * `composeSheet` as an ordinary picture of a map. This adds the one structure
 * that makes it a geospatial PDF: a viewport over the map frame carrying a
 * `/Measure` dictionary of subtype `/GEO`, per the Adobe Supplement to
 * ISO 32000. Nothing else about the sheet changes -- the same file still prints
 * identically, and a reader with no geospatial support sees no difference.
 *
 * This is what CloudTAK's own importer looks for. tasks/events, transform
 * `GDALTranslate`, registers `.pdf` and runs `gdal raster info` on the upload,
 * rejecting anything with no geotransform and no GCPs before converting it to
 * MBTiles. A sheet carrying this dictionary imports as a map overlay with no
 * change on the CloudTAK side.
 *
 * The registration is declared in WGS 84 lat/lon rather than in the projected
 * system the map is drawn in. That is not the theoretically better choice --
 * see WGS84_WKT below for what it costs and why Acrobat leaves no alternative.
 */

import { PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib';

/** Web Mercator sphere radius, the EPSG:3857 definition. */
const R = 6378137;
const M_PER_INCH = 0.0254;
const PT_PER_INCH = 72;

export type Inches = { width: number; height: number };

export type GeoreferenceOptions = {
    /** Full sheet size in inches. */
    sheet: Inches;
    /** Map frame size in inches. */
    frame: Inches;
    /** Frame offset from the top-left of the sheet, in inches. */
    origin: { left: number; top: number };
    /** Map centre, [longitude, latitude]. */
    center: [number, number];
    /** Scale denominator: 24000 means 1:24,000. */
    scale: number;
};

/** [lon, lat] in degrees -> EPSG:3857 metres. */
export function toMercator(lon: number, lat: number): [number, number] {
    return [
        R * (lon * Math.PI / 180),
        R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)),
    ];
}

/** EPSG:3857 metres -> [lon, lat] in degrees. */
export function fromMercator(x: number, y: number): [number, number] {
    return [
        (x / R) * 180 / Math.PI,
        (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI,
    ];
}

export type Corners = {
    nw: [number, number];
    sw: [number, number];
    se: [number, number];
    ne: [number, number];
};

/**
 * Corners of the map frame as [lon, lat].
 *
 * Named rather than ordered on purpose: the write order below is GDAL's, the
 * rest of this codebase reads south-west first, and a bare array of four points
 * is how those two quietly become the same mistake.
 *
 * A paper inch is `scale` inches on the ground, but the sheet is drawn in Web
 * Mercator, whose metre is inflated by 1/cos(latitude) -- about 22% at this
 * county's latitude. The frame therefore spans more PROJECTED metres than
 * ground metres, and it is the projected span that has to be declared.
 *
 * This is the same relation `zoomForScale` in lib/geo.ts uses to pick the render
 * zoom, which is why the two agree; the tests hold them to it.
 */
export function frameCorners(opts: GeoreferenceOptions): Corners {
    const [cx, cy] = toMercator(opts.center[0], opts.center[1]);
    const inflation = 1 / Math.cos(opts.center[1] * Math.PI / 180);

    const halfWidth = (opts.frame.width * opts.scale * M_PER_INCH * inflation) / 2;
    const halfHeight = (opts.frame.height * opts.scale * M_PER_INCH * inflation) / 2;

    return {
        nw: fromMercator(cx - halfWidth, cy + halfHeight),
        sw: fromMercator(cx - halfWidth, cy - halfHeight),
        se: fromMercator(cx + halfWidth, cy - halfHeight),
        ne: fromMercator(cx + halfWidth, cy + halfHeight),
    };
}

/**
 * The map frame in PDF default user space: points, origin at the bottom-left of
 * the page, y increasing upward. Everything else on the sheet is measured from
 * the top-left, so this is the one place the flip happens.
 */
export function frameBox(opts: GeoreferenceOptions): [number, number, number, number] {
    const left = opts.origin.left * PT_PER_INCH;
    const right = (opts.origin.left + opts.frame.width) * PT_PER_INCH;
    const top = (opts.sheet.height - opts.origin.top) * PT_PER_INCH;
    const bottom = (opts.sheet.height - opts.origin.top - opts.frame.height) * PT_PER_INCH;

    return [left, bottom, right, top];
}

/**
 * The four corners in the viewport's own unit space: (0,1) (0,0) (1,0) (1,1) --
 * north-west, south-west, south-east, north-east. y increases upward, so (0,0)
 * is the bottom-left of the BBox.
 *
 * This is the order GDAL's own PDF writer uses, and it is copied deliberately.
 * A different but self-consistent order is legal and GDAL reads it back
 * correctly; the first version of this file used one, and Acrobat did not
 * agree. Where the spec allows latitude, follow the reference implementation.
 */
const LPTS = [0, 1, 0, 0, 1, 0, 1, 1];

/**
 * WGS 84 in the ESRI WKT dialect.
 *
 * Two things here were each established by testing rather than by reading, and
 * both cost a release to find out.
 *
 * The WKT is not optional. `/EPSG 4326` on its own is legal and GDAL reads it
 * happily, but Acrobat carries no EPSG database: with no WKT its geospatial
 * tool reports nothing and its measuring tool takes the application down.
 *
 * And this is GEOGCS, not the PROJCS for EPSG:3857 that the map is actually
 * drawn in. Declaring the projected system is the better answer on paper -- Web
 * Mercator is linear in projected metres, so the four-corner registration would
 * be exact rather than bowed -- and GDAL both writes and reads it that way. But
 * Acrobat resolves it to nothing: a sheet declaring PROJCS 3857 reads out as
 * Lat 0.00000 Long 0.00000, and so does GDAL's own GeoPDF written the same way.
 * Acrobat is the reader that cannot be worked around, so GEOGCS it is.
 *
 * What that costs is a small bow, because a lat/lon affine is not linear in
 * Mercator y. Measured at this latitude, worst case mid-sheet:
 *
 *   Letter   1:6,000   0.03m    1:24,000   0.44m    1:100,000    7.7m
 *   Tabloid  1:6,000   0.07m    1:24,000   1.20m    1:100,000   20.8m
 *   Arch E   1:6,000   0.68m    1:24,000  10.90m    1:100,000  189.8m
 *
 * As a fraction of the sheet that is under 0.1mm of paper everywhere except the
 * largest sheets at the smallest scales, where it reaches about 2mm. If that
 * ever matters, the fix is more GPTS/LPTS points rather than a different CS:
 * the spec allows a lattice, and interpolating between rows removes the bow.
 */
const WGS84_WKT = 'GEOGCS["GCS_WGS_1984",'
    + 'DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],'
    + 'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/**
 * Add the geospatial viewport to a rendered sheet.
 *
 * Returns a new PDF; the input buffer is not modified.
 */
export async function georeference(pdf: Buffer, opts: GeoreferenceOptions): Promise<Buffer> {
    if (!Number.isFinite(opts.center[0]) || !Number.isFinite(opts.center[1])) {
        throw new Error('georeference: centre is not a finite coordinate');
    }

    // cos(latitude) goes to zero at the poles and the inflation factor with it.
    // No sheet is printed there, but an unchecked Infinity would be written into
    // the PDF as a corner coordinate rather than failing here.
    if (Math.abs(opts.center[1]) > 85) {
        throw new Error(`georeference: latitude ${opts.center[1]} is outside the Web Mercator domain`);
    }

    const doc = await PDFDocument.load(pdf);
    const page = doc.getPage(0);
    const ctx = doc.context;

    const number = (n: number) => PDFNumber.of(n);
    const c = frameCorners(opts);

    // Registered as indirect objects rather than inlined, because that is the
    // shape GDAL writes and Acrobat accepts. Inline dictionaries are legal PDF.
    const gcs = ctx.register(ctx.obj({
        Type: PDFName.of('GEOGCS'),
        EPSG: number(4326),
        WKT: PDFString.of(WGS84_WKT),
    }));

    const measure = ctx.register(ctx.obj({
        Type: PDFName.of('Measure'),
        Subtype: PDFName.of('GEO'),
        /** The viewport's boundary in its own unit space. */
        Bounds: ctx.obj(LPTS.map(number)),
        /**
         * Pairwise (LATITUDE, longitude) -- the reverse of every other
         * coordinate here -- in the same order as LPTS: NW, SW, SE, NE.
         */
        GPTS: ctx.obj([c.nw, c.sw, c.se, c.ne].flatMap(([lon, lat]) => [number(lat), number(lon)])),
        LPTS: ctx.obj(LPTS.map(number)),
        GCS: gcs,
    }));

    const viewport = ctx.register(ctx.obj({
        Type: PDFName.of('Viewport'),
        BBox: ctx.obj(frameBox(opts).map(number)),
        Name: PDFString.of('Map frame'),
        Measure: measure,
    }));

    page.node.set(PDFName.of('VP'), ctx.obj([viewport]));

    /*
     * Saved as plain objects with a classic cross-reference table, not the
     * compressed object streams pdf-lib defaults to. Chromium writes the sheet
     * that way and GDAL writes its own GeoPDFs that way; re-serialising into
     * object streams changes the shape of the whole file for the sake of about
     * a kilobyte, and the reader this has to satisfy is the fussy one.
     */
    return Buffer.from(await doc.save({ useObjectStreams: false }));
}
