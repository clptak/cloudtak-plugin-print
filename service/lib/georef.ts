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
 * The registration is declared in the PROJECTED coordinate system the map was
 * drawn in (EPSG:3857), not in plain latitude and longitude. A Web Mercator
 * sheet is linear in projected metres and is NOT linear in latitude, so a
 * four-corner fit against lat/lon bows in the middle -- negligible at 1:6,000
 * and worth millimetres of paper at 1:100,000.
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

/**
 * Corners of the map frame as [lon, lat], counter-clockwise from the south-west.
 *
 * A paper inch is `scale` inches on the ground, but the sheet is drawn in Web
 * Mercator, whose metre is inflated by 1/cos(latitude) -- about 22% at this
 * county's latitude. The frame therefore spans more PROJECTED metres than
 * ground metres, and it is the projected span that has to be declared.
 *
 * This is the same relation `zoomForScale` in lib/geo.ts uses to pick the render
 * zoom, which is why the two agree; test/parity holds them to it.
 */
export function frameCorners(opts: GeoreferenceOptions): Array<[number, number]> {
    const [cx, cy] = toMercator(opts.center[0], opts.center[1]);
    const inflation = 1 / Math.cos(opts.center[1] * Math.PI / 180);

    const halfWidth = (opts.frame.width * opts.scale * M_PER_INCH * inflation) / 2;
    const halfHeight = (opts.frame.height * opts.scale * M_PER_INCH * inflation) / 2;

    return [
        fromMercator(cx - halfWidth, cy - halfHeight), // SW
        fromMercator(cx - halfWidth, cy + halfHeight), // NW
        fromMercator(cx + halfWidth, cy + halfHeight), // NE
        fromMercator(cx + halfWidth, cy - halfHeight), // SE
    ];
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
 * The four corners in the viewport's own unit space, and the order everything
 * else follows: south-west, north-west, north-east, south-east. In PDF user
 * space y increases upward, so (0,0) is the bottom-left of the BBox.
 */
const LPTS = [0, 0, 0, 1, 1, 1, 1, 0];

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
    const corners = frameCorners(opts);

    const measure = ctx.obj({
        Type: PDFName.of('Measure'),
        Subtype: PDFName.of('GEO'),
        /** The viewport's boundary in its own unit space. */
        Bounds: ctx.obj(LPTS.map(number)),
        /** Pairwise (latitude, longitude) -- note the order, it is not lon/lat. */
        GPTS: ctx.obj(corners.flatMap(([lon, lat]) => [number(lat), number(lon)])),
        /** The same four points in unit space, in the same order. */
        LPTS: ctx.obj(LPTS.map(number)),
        GCS: ctx.obj({
            Type: PDFName.of('PROJCS'),
            EPSG: number(3857),
        }),
    });

    const viewport = ctx.obj({
        Type: PDFName.of('Viewport'),
        BBox: ctx.obj(frameBox(opts).map(number)),
        Name: PDFString.of('Map frame'),
        Measure: measure,
    });

    page.node.set(PDFName.of('VP'), ctx.obj([viewport]));

    return Buffer.from(await doc.save());
}
