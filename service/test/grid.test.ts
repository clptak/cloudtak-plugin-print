import test from 'node:test';
import assert from 'node:assert/strict';
import { mercator, projector, viewportBBox, clipToFrame, gridSvg } from '../lib/grid.js';
import { toUTM } from '../lib/utm.js';

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

test('the grid renders as vector paths and labelled text', () => {
    const { svg, lines, zone } = gridSvg({ view: VIEW, zone: 12, interval: 1000, layoutDpi: 200 });

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
    const { svg } = gridSvg({ view: VIEW, zone: 12, interval: 1000, layoutDpi: 200 });

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
