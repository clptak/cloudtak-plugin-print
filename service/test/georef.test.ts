import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import { georeference, frameCorners, frameBox, toMercator, fromMercator } from '../lib/georef.js';
import { zoomForScale } from '../lib/geo.js';
import { sheet, MARGINS } from '../lib/paper.js';

const M_PER_INCH = 0.0254;

/** A Letter sheet over Oak Creek Canyon, the geometry every sheet here uses. */
const LETTER = sheet('letter', 'portrait');
const OPTS = {
    sheet: LETTER.sheet,
    frame: LETTER.frame,
    origin: { left: MARGINS.left, top: MARGINS.top },
    center: [-111.7574, 34.943] as [number, number],
    scale: 24000,
};

test('mercator conversion round-trips', () => {
    for (const [lon, lat] of [[0, 0], [-111.7574, 34.943], [151.2, -33.86], [-149.9, 61.2]]) {
        const [x, y] = toMercator(lon, lat);
        const [back, backLat] = fromMercator(x, y);

        assert.ok(Math.abs(back - lon) < 1e-9, `${back} != ${lon}`);
        assert.ok(Math.abs(backLat - lat) < 1e-9, `${backLat} != ${lat}`);
    }
});

test('the frame corners are square and centred on the requested point', () => {
    const { sw, nw, ne, se } = frameCorners(OPTS);

    // Order is SW, NW, NE, SE — everything downstream depends on it.
    assert.equal(sw[0], nw[0]);
    assert.equal(ne[0], se[0]);
    assert.equal(sw[1], se[1]);
    assert.equal(nw[1], ne[1]);
    assert.ok(sw[0] < ne[0] && sw[1] < ne[1]);

    assert.ok(Math.abs((sw[0] + ne[0]) / 2 - OPTS.center[0]) < 1e-9);

    // Latitude is not linear in Mercator, so the centre only returns through the
    // projection — which is exactly the property that makes a lat/lon
    // registration wrong and a projected one right.
    const [, cy] = toMercator(OPTS.center[0], OPTS.center[1]);
    const mid = (toMercator(sw[0], sw[1])[1] + toMercator(ne[0], ne[1])[1]) / 2;
    assert.ok(Math.abs(mid - cy) < 1e-6);
});

test('the frame spans exactly the ground distance the scale promises', () => {
    // 7.5in at 1:24,000 is 4572m across, whatever the projection does in between.
    const { sw, ne } = frameCorners(OPTS);
    const metresPerDegreeLon = (40075016.686 / 360) * Math.cos(OPTS.center[1] * Math.PI / 180);
    const ground = (ne[0] - sw[0]) * metresPerDegreeLon;

    assert.ok(
        Math.abs(ground - OPTS.frame.width * OPTS.scale * M_PER_INCH) < 0.5,
        `frame spans ${ground.toFixed(1)}m, expected ${(OPTS.frame.width * OPTS.scale * M_PER_INCH).toFixed(1)}m`,
    );
});

test('the corners agree with the zoom the map was actually rendered at', () => {
    // The registration has to describe the raster, not an ideal of it. If these
    // two ever drift apart the sheet prints correctly and lands in the wrong
    // place, which is the one failure worth a dedicated test.
    const layoutDpi = 200;
    const zoom = zoomForScale(OPTS.scale, layoutDpi, OPTS.center[1]);
    const worldPx = 512 * 2 ** zoom;
    const mercatorPerPx = (2 * Math.PI * 6378137) / worldPx;
    const expected = OPTS.frame.width * layoutDpi * mercatorPerPx;

    const { sw, ne } = frameCorners(OPTS);
    const span = toMercator(ne[0], ne[1])[0] - toMercator(sw[0], sw[1])[0];

    assert.ok(Math.abs(span - expected) / expected < 1e-6, `${span} vs ${expected}`);
});

test('the viewport box is the map frame, flipped into PDF user space', () => {
    const [left, bottom, right, top] = frameBox(OPTS);

    assert.equal(left, MARGINS.left * 72);
    assert.equal(right, (MARGINS.left + LETTER.frame.width) * 72);
    assert.equal(top, (LETTER.sheet.height - MARGINS.top) * 72);
    assert.ok(Math.abs(bottom - (top - LETTER.frame.height * 72)) < 1e-9);

    // The bottom margin is the deep one; the frame must not be centred on the page.
    assert.ok(bottom > 0);
    assert.ok(bottom > LETTER.sheet.height * 72 - top);
});

async function blank(): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.addPage([LETTER.sheet.width * 72, LETTER.sheet.height * 72]);

    return Buffer.from(await doc.save());
}

/**
 * The viewport, its Measure dictionary and its GCS, resolved through the
 * document. Each `lookup` doubles as the assertion that the entry is an
 * indirect reference -- the shape GDAL writes and Acrobat accepts.
 */
async function viewportOf(pdf: Buffer) {
    const doc = await PDFDocument.load(pdf);
    const page = doc.getPage(0);
    const ctx = page.node.context;

    const vp = page.node.lookup(PDFName.of('VP'), PDFArray);
    assert.equal(vp.size(), 1);

    assert.ok(vp.get(0) instanceof PDFRef, 'the viewport is an indirect object');
    const viewport = ctx.lookup(vp.get(0), PDFDict);

    assert.ok(viewport.get(PDFName.of('Measure')) instanceof PDFRef, 'Measure is indirect');
    const measure = viewport.lookup(PDFName.of('Measure'), PDFDict);

    assert.ok(measure.get(PDFName.of('GCS')) instanceof PDFRef, 'GCS is indirect');

    return { viewport, measure, gcs: measure.lookup(PDFName.of('GCS'), PDFDict) };
}

test('the sheet comes back carrying a GEO viewport over the frame', async () => {
    const { viewport, measure } = await viewportOf(await georeference(await blank(), OPTS));
    assert.equal(measure.get(PDFName.of('Subtype')), PDFName.of('GEO'));

    const gpts = measure.lookup(PDFName.of('GPTS'), PDFArray);
    assert.equal(gpts.size(), 8);

    // GPTS is (latitude, longitude) pairwise, which is the opposite of every
    // other coordinate in this codebase and the easiest thing to get backwards.
    // The order is GDAL's: NW, SW, SE, NE, matching LPTS point for point.
    const c = frameCorners(OPTS);
    const at = (i: number) => (gpts.get(i) as PDFNumber).asNumber();

    for (const [i, corner] of [c.nw, c.sw, c.se, c.ne].entries()) {
        assert.ok(Math.abs(at(i * 2) - corner[1]) < 1e-9, `GPTS ${i} latitude`);
        assert.ok(Math.abs(at(i * 2 + 1) - corner[0]) < 1e-9, `GPTS ${i} longitude`);
    }

    // Each GPTS point must sit at the LPTS point of the same index, or the
    // registration is a rotation or a reflection of the map.
    const lpts = measure.lookup(PDFName.of('LPTS'), PDFArray);
    const unit = [0, 1, 2, 3].map((i) => {
        return [(lpts.get(i * 2) as PDFNumber).asNumber(), (lpts.get(i * 2 + 1) as PDFNumber).asNumber()];
    });

    assert.deepEqual(unit, [[0, 1], [0, 0], [1, 0], [1, 1]]);
    // x=0 is west, y=1 is north: check one of each against the corners above.
    assert.ok(at(0) > at(2), 'first GPTS point should be the northern one');
    assert.ok(at(1) < at(5), 'first GPTS point should be the western one');

    const bbox = viewport.lookup(PDFName.of('BBox'), PDFArray);
    assert.deepEqual(
        [0, 1, 2, 3].map(i => (bbox.get(i) as PDFNumber).asNumber()),
        frameBox(OPTS),
    );
});

test('the input buffer is left alone', async () => {
    const input = await blank();
    const before = Buffer.from(input);

    await georeference(input, OPTS);

    assert.ok(input.equals(before));
});

test('a sheet outside the Mercator domain is refused rather than written wrong', async () => {
    const input = await blank();

    await assert.rejects(
        () => georeference(input, { ...OPTS, center: [0, 88] }),
        /outside the Web Mercator domain/,
    );
    await assert.rejects(
        () => georeference(input, { ...OPTS, center: [Number.NaN, 34.9] }),
        /not a finite coordinate/,
    );
});

test('the coordinate system carries a WKT, not only an EPSG code', async () => {
    // Acrobat has no EPSG database. With `/EPSG 3857` alone its geospatial tool
    // reports no coordinates and its measuring tool crashes the application,
    // while GDAL reads the same file without complaint -- so nothing but an
    // explicit check here catches a regression.
    const { gcs } = await viewportOf(await georeference(await blank(), OPTS));

    assert.equal(gcs.lookup(PDFName.of('EPSG'), PDFNumber).asNumber(), 3857);

    const wkt = gcs.lookup(PDFName.of('WKT'), PDFString).asString();
    assert.match(wkt, /^PROJCS\["WGS_1984_Web_Mercator_Auxiliary_Sphere"/);
    assert.match(wkt, /PROJECTION\["Mercator_Auxiliary_Sphere"\]/);
});
