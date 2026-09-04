import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from '../lib/resolution.js';
import { sheet } from '../lib/paper.js';

// Measured on a GPU-less Linux container: Chromium reports MAX_TEXTURE_SIZE 8192
// under SwiftShader, not the 16384 typical of real hardware.
const SWIFTSHADER = 8192;

const forPaper = (size: Parameters<typeof sheet>[0], orientation: Parameters<typeof sheet>[1], requestedDpi?: number) => {
    return resolve({
        frameInches: sheet(size, orientation).frame,
        requestedDpi,
        maxDpi: 300,
        layoutDpi: 96,
        maxTexture: SWIFTSHADER,
    });
};

test('small sheets are not constrained by the texture limit', () => {
    const letter = forPaper('letter', 'portrait', 300);
    assert.equal(letter.dpi, 300);
    assert.equal(letter.clampedBy, 'none');

    const tabloid = forPaper('tabloid', 'portrait', 300);
    assert.equal(tabloid.dpi, 300);
});

test('ANSI D and Arch D top out at 200 DPI under SwiftShader', () => {
    assert.equal(forPaper('ansi-d', 'portrait', 300).dpi, 200);
    assert.equal(forPaper('ansi-d', 'portrait', 300).clampedBy, 'texture');

    assert.equal(forPaper('arch-d', 'portrait', 300).dpi, 200);
});

test('Arch E drops to 150 DPI in both orientations', () => {
    assert.equal(forPaper('arch-e', 'portrait', 300).dpi, 150);
    assert.equal(forPaper('arch-e', 'landscape', 300).dpi, 150);
});

test('every paper size stays inside the texture limit at its chosen DPI', () => {
    for (const size of ['letter', 'legal', 'tabloid', 'ansi-c', 'ansi-d', 'arch-d', 'arch-e'] as const) {
        for (const orientation of ['portrait', 'landscape'] as const) {
            const r = forPaper(size, orientation, 300);
            assert.ok(
                Math.max(r.pixels.width, r.pixels.height) <= SWIFTSHADER,
                `${size} ${orientation} at ${r.dpi} DPI is ${r.pixels.width}x${r.pixels.height}`,
            );
        }
    }
});

test('the configured ceiling applies below the texture limit', () => {
    const r = resolve({
        frameInches: sheet('letter', 'portrait').frame,
        requestedDpi: 300,
        maxDpi: 150,
        layoutDpi: 96,
        maxTexture: SWIFTSHADER,
    });

    assert.equal(r.dpi, 150);
    assert.equal(r.clampedBy, 'ceiling');
});

test('layout size is independent of output resolution', () => {
    const low = forPaper('ansi-d', 'portrait', 100);
    const high = forPaper('ansi-d', 'portrait', 200);

    // Same CSS layout, so identical label density; only the backing store differs.
    assert.deepEqual(low.css, high.css);
    assert.ok(high.pixels.width > low.pixels.width);
});

test('a frame too large for even the lowest rung is rejected with a clear error', () => {
    assert.throws(
        () => resolve({
            frameInches: { width: 200, height: 200 },
            maxDpi: 300,
            layoutDpi: 96,
            maxTexture: SWIFTSHADER,
        }),
        /too large to render in one pass/,
    );
});
