import test from 'node:test';
import assert from 'node:assert/strict';
import { gridSvg, squareLabels, usngDigits, type Viewport } from '../lib/grid.js';
import { fromUTM } from '../lib/utm.js';
import { zoomForScale } from '../lib/geo.js';

/** A Letter sheet's map frame at 1:24,000 and 200 dpi, centred wherever asked. */
function letter(center: [number, number]): Viewport {
    return { center, zoom: zoomForScale(24000, 200, center[1]), width: 1500, height: 1850 };
}

const SHEET = { sheet: { width: 8.5, height: 11 }, frameOrigin: { x: 0.5, y: 0.5 }, layoutDpi: 200 };

test('a USNG line is labelled with its digits inside the 100 km square', () => {
    assert.equal(usngDigits(430000, 1000), '30');
    assert.equal(usngDigits(430800, 100), '308');
    assert.equal(usngDigits(3866000, 1000), '66');
    assert.equal(usngDigits(430000, 10000), '3');
    // A 100 km grid has no digits to print: the square ID is the whole reading.
    assert.equal(usngDigits(400000, 100000), '');
});

test('USNG edge labels carry no UTM prefix or suffix', () => {
    const { svg } = gridSvg({ view: letter([-111.757376, 34.942983]), zone: 12, interval: 1000, system: 'usng', ...SHEET });

    const labels = [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map(m => m[1]);
    assert.ok(labels.length > 4);

    for (const l of labels) {
        const spans = [...l.matchAll(/<tspan[^>]*>(.*?)<\/tspan>/g)].map(m => m[1]);
        assert.equal(spans.length, 1, `one tspan per USNG label, got: ${l}`);
        assert.match(spans[0], /^\d{2}$/);
    }
});

test('a sheet inside one square gets no square labels -- the title strip names it', () => {
    assert.deepEqual(squareLabels(letter([-111.757376, 34.942983]), 12), []);
});

test('a sheet across a 100 km line labels both squares, on the right sides', () => {
    // Centred exactly on the 400 000 m easting line near Flagstaff: UD to the
    // west, VD to the east.
    const at = fromUTM(400000, 3895000, 12);
    const view = letter([at.longitude, at.latitude]);
    const labels = squareLabels(view, 12);

    assert.deepEqual(labels.map(l => l.label).sort(), ['UD', 'VD']);

    const ud = labels.find(l => l.label === 'UD')!;
    const vd = labels.find(l => l.label === 'VD')!;
    assert.ok(ud.x < view.width / 2 && vd.x > view.width / 2, 'UD must sit west of the line, VD east');

    // And the boundary itself prints heavier than the 1 km lines.
    const { svg } = gridSvg({ view, zone: 12, interval: 1000, system: 'usng', ...SHEET });
    const widths = [...svg.matchAll(/<g clip-path="url\(#frame\)" fill="none" stroke="[^"]+" stroke-width="([\d.]+)"/g)]
        .map(m => Number(m[1]));
    assert.equal(widths.length, 2, 'expected a normal and a heavy line group');
    assert.ok(widths[1] > widths[0] * 2);
});

test('a sheet across a latitude band names the zone designator too', () => {
    // 32 N runs through Tucson. The square letters do not change across a band
    // boundary, so the square ID alone would hide that the designator did.
    const labels = squareLabels(letter([-110.9747, 32.0]), 12);

    assert.deepEqual(labels.map(l => l.label).sort(), ['12R WA', '12S WA']);

    const r = labels.find(l => l.label === '12R WA')!;
    const s = labels.find(l => l.label === '12S WA')!;
    assert.ok(r.y > s.y, '12R lies south of 12S, so lower on the sheet');
});

test('UTM sheets are unchanged: no square labels, no heavy lines', () => {
    const at = fromUTM(400000, 3895000, 12);
    const { svg } = gridSvg({ view: letter([at.longitude, at.latitude]), zone: 12, interval: 1000, ...SHEET });

    assert.doesNotMatch(svg, />UD</);
    const groups = [...svg.matchAll(/<g clip-path="url\(#frame\)" fill="none"/g)];
    assert.equal(groups.length, 1);
});
