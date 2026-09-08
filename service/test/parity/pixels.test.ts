import test from 'node:test';
import assert from 'node:assert/strict';
import { readPixels, drawableFrom } from '../../../plugin/lib/pixels.js';

/**
 * The regression this exists for.
 *
 * map.getImage(id) returns a StyleImage whose pixels and dimensions live on
 * `.data`; the entry itself has no width or height. Porting the console harvester
 * into the plugin inverted that pick -- `image.data ? image : ...` instead of
 * `image.data || ...` -- so width came back undefined, every entry failed the
 * validity check, and ZERO images were shipped. Sheets printed CoT labels with no
 * symbol under them, and the skipped count that would have said so was never
 * surfaced.
 *
 * Lives under test/parity because it reaches into plugin/, which is not in the
 * service's Docker build context.
 */

function rgba(width: number, height: number): Uint8Array {
    return new Uint8Array(width * height * 4);
}

test('pixels are read from a real MapLibre StyleImage', () => {
    const entry = {
        data: { width: 24, height: 24, data: rgba(24, 24) },
        pixelRatio: 1,
        sdf: false,
    };

    const pixels = readPixels(entry);

    assert.ok(pixels, 'a StyleImage must yield pixels');
    assert.equal(pixels.width, 24);
    assert.equal(pixels.height, 24);
    assert.equal(pixels.data.length, 24 * 24 * 4);
});

test('the entry itself is never mistaken for the pixel buffer', () => {
    // This is the exact shape that broke: dimensions on .data, nothing on the
    // entry. Reading the entry gives width undefined and the image is dropped.
    const entry = { data: { width: 16, height: 16, data: rgba(16, 16) } };

    const pixels = readPixels(entry);

    assert.equal(pixels?.width, 16, 'must read through .data, not off the entry');
});

test('a user-supplied image is used when there is no RGBAImage', () => {
    const entry = { userImage: { width: 8, height: 8, data: rgba(8, 8) } };

    assert.equal(readPixels(entry)?.width, 8);
});

test('an entry that is already a pixel object still works', () => {
    assert.equal(readPixels({ width: 4, height: 4, data: rgba(4, 4) } as never)?.width, 4);
});

test('anything undrawable reads as null rather than as zero-sized pixels', () => {
    assert.equal(readPixels(undefined), null);
    assert.equal(readPixels(null), null);
    assert.equal(readPixels({}), null);
    assert.equal(readPixels({ data: {} }), null);
    assert.equal(readPixels({ data: { width: 0, height: 0, data: rgba(1, 1) } }), null);
    // A bitmap carries no readable buffer, so it must fall through to the canvas.
    assert.equal(readPixels({ data: { width: 10, height: 10 } }), null);
});

test('the canvas fallback is handed the object that actually holds the image', () => {
    const bitmap = { width: 10, height: 10 };
    assert.equal(drawableFrom({ data: bitmap }), bitmap);
    assert.equal(drawableFrom({ userImage: bitmap }), bitmap);
    assert.equal(drawableFrom(undefined), null);
});
