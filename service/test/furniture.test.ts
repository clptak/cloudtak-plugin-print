import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleBar, niceLength, declinationAt, northArrow, groundPerInch } from '../lib/furniture.js';

test('one inch of paper is the scale denominator in inches on the ground', () => {
    assert.ok(Math.abs(groundPerInch(24000) - 609.6) < 1e-9);
});

test('a scale bar picks the longest round distance that fits', () => {
    assert.equal(niceLength([100, 500, 1000, 2000], 1500), 1000);
    assert.equal(niceLength([100, 500, 1000, 2000], 2000), 2000);
    // Nothing fits: fall back to the shortest rather than emitting nothing.
    assert.equal(niceLength([100, 500, 1000], 10), 100);
});

test('the bar is exactly as long as it claims, in paper inches', () => {
    // Someone will measure against it, so an approximate bar is worse than none.
    const bar = scaleBar({ scale: 24000, layoutDpi: 200, maxInches: 3 });
    const expectedInches = bar.metric / groundPerInch(24000);

    assert.ok(Math.abs(bar.widthPx / 200 - expectedInches) < 1e-6
        || Math.abs(bar.widthPx / 200 - (bar.miles * 1609.344) / groundPerInch(24000)) < 1e-6);
});

test('a scale bar adapts to the map scale', () => {
    const near = scaleBar({ scale: 6000, layoutDpi: 200, maxInches: 3 });
    const far = scaleBar({ scale: 100000, layoutDpi: 200, maxInches: 3 });

    assert.ok(far.metric > near.metric, `${far.metric} should exceed ${near.metric}`);
    assert.ok(near.widthPx / 200 <= 3.001 && far.widthPx / 200 <= 3.001, 'neither may overflow the space');
});

test('both units are drawn, sharing a zero', () => {
    const { svg } = scaleBar({ scale: 24000, layoutDpi: 200, maxInches: 3 });

    assert.match(svg, /km|m<\/text>/);
    assert.match(svg, /mile/);
    assert.match(svg, /<rect /, 'alternating segments make it readable by eye');
});

test('declination comes from the offline model, not the network', () => {
    // A sheet is printed when the network is least reliable.
    const d = declinationAt(-111.6513, 35.1983, 12, new Date('2026-09-05T00:00:00Z'));

    assert.ok(d.declination > 8 && d.declination < 12, `Flagstaff declination ${d.declination}`);
    assert.match(d.model, /WMM/);
    assert.equal(d.expired, false);
});

test('grid convergence is west of true north when west of the central meridian', () => {
    // Flagstaff at -111.65 sits west of zone 12's central meridian at -111.
    const d = declinationAt(-111.6513, 35.1983, 12);
    assert.ok(d.convergence < 0, `convergence ${d.convergence}`);
    assert.ok(Math.abs(d.convergence) < 1, 'and small this close to the meridian');

    // East of it, the sign flips.
    const east = declinationAt(-110.35, 35.1983, 12);
    assert.ok(east.convergence > 0, `convergence ${east.convergence}`);
});

test('on the central meridian grid north is true north', () => {
    const d = declinationAt(-111, 35.1983, 12);
    assert.ok(Math.abs(d.convergence) < 1e-9);
});

test('an out-of-date magnetic model is marked on the sheet', () => {
    // Printing a stale bearing onto a navigation aid without saying so is the
    // failure that matters here.
    const stale = declinationAt(-111.6513, 35.1983, 12, new Date('2040-01-01T00:00:00Z'));
    assert.equal(stale.expired, true);

    const { svg } = northArrow({ declination: stale, layoutDpi: 200, heightInches: 0.9 });
    assert.match(svg, /EXPIRED/);
});

test('the north diagram carries all three norths', () => {
    const d = declinationAt(-111.6513, 35.1983, 12);
    const { svg } = northArrow({ declination: d, layoutDpi: 200, heightInches: 0.9 });

    assert.match(svg, />TN</, 'true north — the sheet is drawn north up');
    assert.match(svg, />GN</, 'grid north — what the UTM grid measures against');
    assert.match(svg, />MN</, 'magnetic north — what a compass in the field reads');
    assert.match(svg, /9\.\d°E/, 'declination stated with its sense');
    assert.match(svg, /0\.\d°W/, 'and convergence with its own');
});

test('a lapsed model degrades instead of throwing', () => {
    // geomagnetism throws once the date leaves the model window; without a
    // fallback every sheet with a north arrow would start failing on the day
    // WMM-2025 lapses. It must still print, marked.
    assert.doesNotThrow(() => {
        return declinationAt(-111.6513, 35.1983, 12, new Date('2040-01-01T00:00:00Z'));
    });

    const stale = declinationAt(-111.6513, 35.1983, 12, new Date('2040-01-01T00:00:00Z'));
    assert.equal(stale.expired, true);
    assert.ok(Number.isFinite(stale.declination), 'still yields a usable bearing');
});

test('the angles are read from a legend, not from labels at the arm tips', () => {
    // Grid north is often a fraction of a degree off true north, so tip labels
    // collide exactly where precision matters.
    const d = declinationAt(-111.6513, 35.1983, 12);
    const { svg, widthPx, heightPx } = northArrow({ declination: d, layoutDpi: 200, heightInches: 0.9 });

    const legendLines = [...svg.matchAll(/<tspan font-weight="700">(TN|GN|MN)<\/tspan>/g)];
    assert.equal(legendLines.length, 3, 'one legend line per north');

    // Text baselines need room for their ascenders, not merely y >= 0: a label
    // whose baseline sits at the very top of the box is still clipped.
    const ascender = (2.0 / 25.4) * 200;
    const ys = [...svg.matchAll(/y="(-?[\d.]+)"/g)].map(m => Number(m[1]));
    assert.ok(Math.min(...ys) >= ascender,
        `baseline within an ascender of the top at y=${Math.min(...ys)}, need >= ${ascender.toFixed(1)}`);
    assert.ok(Math.max(...ys) <= heightPx, `content below the box at y=${Math.max(...ys)}`);
    assert.ok(widthPx > heightPx, 'the legend needs room beside the arrows');
});

test('scale bar end labels are anchored inward so they cannot be clipped', () => {
    const { svg } = scaleBar({ scale: 24000, layoutDpi: 200, maxInches: 3 });

    const ends = [...svg.matchAll(/text-anchor="end"/g)];
    assert.equal(ends.length, 2, 'one per bar');
});
