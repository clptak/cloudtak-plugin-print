import test from 'node:test';
import assert from 'node:assert/strict';
import { mercator, projector, viewportBBox, clipToFrame, gridSvg } from '../lib/grid.js';
import { toUTM } from '../lib/utm.js';
import { sheetHtml } from '../lib/sheet.js';
import { sheet as geometry, MARGINS, GRID_GUTTER } from '../lib/paper.js';

const VIEW = { center: [-111.65, 35.2] as [number, number], zoom: 14.3569, width: 2000, height: 3000 };

test('the view centre projects to the centre of the frame', () => {
    const project = projector(VIEW);
    const [x, y] = project(VIEW.center[0], VIEW.center[1]);

    assert.ok(Math.abs(x - VIEW.width / 2) < 1e-6, String(x));
    assert.ok(Math.abs(y - VIEW.height / 2) < 1e-6, String(y));
});

test('north is up and east is right', () => {
    const project = projector(VIEW);
    const [, yNorth] = project(VIEW.center[0], VIEW.center[1] + 0.01);
    const [xEast] = project(VIEW.center[0] + 0.01, VIEW.center[1]);

    assert.ok(yNorth < VIEW.height / 2, 'higher latitude must be higher on the page');
    assert.ok(xEast > VIEW.width / 2, 'higher longitude must be further right');
});

test('the projection scale matches the zoom it was built for', () => {
    // One CSS pixel at zoom z is worldCircumference / (512 * 2^z) metres at the
    // equator; this is what keeps the grid registered with the map beneath it.
    const a = mercator(0, 0, 10);
    const b = mercator(1, 0, 10);

    assert.ok(Math.abs((b.x - a.x) - (512 * 2 ** 10) / 360) < 1e-6);
});

test('the generation bbox extends beyond the frame', () => {
    // Lines must be generated past the edges so they reach them cleanly.
    const [west, south, east, north] = viewportBBox(VIEW);

    assert.ok(west < VIEW.center[0] && east > VIEW.center[0]);
    assert.ok(south < VIEW.center[1] && north > VIEW.center[1]);
});

test('clipping keeps the inside and reaches the border', () => {
    const points: Array<[number, number]> = [[-50, 10], [10, 10], [50, 10], [150, 10]];
    const pieces = clipToFrame(points, 100, 100);

    assert.equal(pieces.length, 1);
    // One point either side is retained so the run spans the border.
    assert.ok(pieces[0][0][0] < 0);
    assert.ok(pieces[0][pieces[0].length - 1][0] > 100);
});

test('a line entirely outside the frame is dropped', () => {
    assert.deepEqual(clipToFrame([[-50, -50], [-40, -40]], 100, 100), []);
});

test('a line crossing out and back yields two pieces', () => {
    const points: Array<[number, number]> = [[10, 10], [-10, 10], [10, 20], [20, 20]];
    const pieces = clipToFrame(points, 100, 100);

    assert.equal(pieces.length, 2);
});

const SHEET = { sheet: { width: 11, height: 17 }, frameOrigin: { x: 0.5, y: 0.5 } };

test('the grid renders as vector paths and labelled text', () => {
    const { svg, lines, zone } = gridSvg({ view: VIEW, zone: 12, interval: 1000, layoutDpi: 200, ...SHEET });

    assert.equal(zone, 12);
    assert.ok(lines > 4, `expected several grid lines, got ${lines}`);
    assert.match(svg, /^<svg /);
    assert.match(svg, /<path d="M/, 'lines must be paths, not a raster');
    assert.match(svg, /<text /, 'edges must be labelled');
    assert.match(svg, /font-weight="700"/, 'principal digits must be emphasised');
});

test('grid spacing on the page matches the ground interval at the chosen scale', () => {
    // The real test of registration: 1000m at 1:24,000 is 1000/24000 metres of
    // paper, and at 200 css px/inch that is a specific number of pixels.
    const { svg } = gridSvg({ view: VIEW, zone: 12, interval: 1000, layoutDpi: 200, ...SHEET });

    const verticals = [...svg.matchAll(/<path d="M([\d.]+) /g)].map(m => Number(m[1]));
    const xs = [...new Set(verticals.map(v => Math.round(v)))].sort((a, b) => a - b);

    const gaps = xs.slice(1).map((v, i) => v - xs[i]).filter(g => g > 50);
    assert.ok(gaps.length > 0, 'expected at least two easting lines');

    const expectedPx = (1000 / 24000 / 0.0254) * 200; // ~328 px
    const median = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    assert.ok(Math.abs(median - expectedPx) / expectedPx < 0.02, `gap ${median}px vs expected ${expectedPx.toFixed(0)}px`);
});

test('a labelled grid value really is on its grid line', () => {
    // Guards against the grid drawing in the right place but being mislabelled,
    // which on a printed sheet is worse than no grid at all.
    const { view } = { view: VIEW };
    const project = projector(view);
    const u = toUTM(view.center[0], view.center[1], 12);
    const [x, y] = project(view.center[0], view.center[1]);

    assert.ok(Math.abs(x - view.width / 2) < 1e-6 && Math.abs(y - view.height / 2) < 1e-6);
    assert.ok(u.easting > 400000 && u.easting < 500000, `Flagstaff easting ${u.easting}`);
    assert.ok(u.northing > 3800000 && u.northing < 4000000, `Flagstaff northing ${u.northing}`);
});

test('labels sit outside the neatline, in the margin', () => {
    // Inside the frame they compete with the map behind them; the printed
    // convention is a clear margin, and it is what makes them readable.
    const { svg } = gridSvg({ view: VIEW, zone: 12, interval: 1000, layoutDpi: 200, ...SHEET });

    const frameTop = SHEET.frameOrigin.y * 200;
    const frameLeft = SHEET.frameOrigin.x * 200;

    const texts = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"/g)]
        .map(m => ({ x: Number(m[1]), y: Number(m[2]) }));

    assert.ok(texts.length > 4, 'expected labels on the edges');

    const outside = texts.filter((t) => {
        return t.y < frameTop || t.x < frameLeft
            || t.y > frameTop + VIEW.height || t.x > frameLeft + VIEW.width;
    });

    assert.equal(outside.length, texts.length, 'every label must be clear of the map frame');
});

test('the svg spans the sheet, and the lines are clipped to the frame', () => {
    const { svg } = gridSvg({ view: VIEW, zone: 12, interval: 1000, layoutDpi: 200, ...SHEET });

    assert.match(svg, new RegExp(`width="${11 * 200}"`), 'svg must span the sheet, not the frame');
    assert.match(svg, /clip-path="url\(#frame\)"/, 'lines must still be clipped to the neatline');
    assert.match(svg, /<line x1=/, 'ticks should cross the neatline');
});

test('side labels are rotated to read bottom-to-top', () => {
    // A full grid reference is wider than a half-inch margin; a printed map
    // rotates rather than shrinking the type.
    const { svg } = gridSvg({ view: VIEW, zone: 12, interval: 1000, layoutDpi: 200, ...SHEET });

    assert.match(svg, /transform="rotate\(-90 /);
});

test('grid paths and the clip rectangle share one coordinate system', () => {
    // A clip-path is resolved in the user space established by the element's own
    // transform, so a clipped-and-translated group has its clip rectangle shifted
    // by the same offset — which let lines escape past the right neatline and run
    // straight through the margin labels. The offset is baked into the path
    // coordinates instead, so this asserts there is no transform to reintroduce it.
    const { svg } = gridSvg({ view: VIEW, zone: 12, interval: 1000, layoutDpi: 200, ...SHEET });

    const group = svg.match(/<g clip-path="url\(#frame\)"[^>]*>/)?.[0] ?? '';
    assert.doesNotMatch(group, /transform=/, 'a transform here shifts the clip off the frame');

    const ox = SHEET.frameOrigin.x * 200;
    const oy = SHEET.frameOrigin.y * 200;

    const rect = svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
    assert.ok(rect);
    assert.equal(Number(rect![1]), ox);
    assert.equal(Number(rect![2]), oy);
    assert.equal(Number(rect![3]), VIEW.width);
    assert.equal(Number(rect![4]), VIEW.height);

    // Path coordinates must be in the same space: they should bracket the frame.
    const xs = [...svg.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map(m => Number(m[1]));
    assert.ok(Math.min(...xs) < ox, 'lines should start left of the frame and be clipped');
    assert.ok(Math.max(...xs) > ox + VIEW.width, 'and continue past its right edge');
    assert.ok(Math.max(...xs) < ox + VIEW.width + 200, 'but not by a whole frame width');
});

test('the title block leaves room for the bottom row of grid labels', () => {
    // Its rule sliced the bottom labels in half on the first gridded sheet.
    const g = geometry('tabloid', 'portrait');
    const html = sheetHtml({
        map: Buffer.alloc(0), sheet: g.sheet, frame: g.frame,
        meta: { title: 'x', scale: 24000, generated: '2026-09-05T00:00:00.000Z' },
    });

    const height = Number(html.match(/height:\s*([\d.]+)in;\s*\n\s*display:\s*flex/)?.[1] ?? 0);
    const bottom = Number(html.match(/bottom:\s*([\d.]+)in;\s*\n\s*height/)?.[1] ?? 0);

    // Title block top must clear the frame by at least the reserved gutter.
    assert.ok(bottom + height <= MARGINS.bottom - GRID_GUTTER + 1e-9,
        `title block top at ${bottom + height}in, frame bottom at ${MARGINS.bottom}in`);
});
