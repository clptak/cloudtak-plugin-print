import test from 'node:test';
import assert from 'node:assert/strict';
import {
    metresPerPixel,
    zoomForScale,
    scaleForZoom,
    bboxCenter,
    bboxMetres,
    scaleForBBox,
    snapScale,
    gridInterval,
} from '../lib/geo.js';
import { sheet } from '../lib/paper.js';

test('one CSS pixel at 1:24,000 and 96 DPI layout is 6.35 m', () => {
    assert.ok(Math.abs(metresPerPixel(24000, 96) - 6.35) < 1e-9);
});

test('metres per pixel scales linearly with the scale denominator', () => {
    assert.equal(metresPerPixel(48000, 96) / metresPerPixel(24000, 96), 2);
});

test('zoom and scale round-trip at a given latitude', () => {
    for (const latitude of [0, 35.2, 49, -33]) {
        for (const scale of [6000, 24000, 100000]) {
            const zoom = zoomForScale(scale, 96, latitude);
            assert.ok(Math.abs(scaleForZoom(zoom, 96, latitude) - scale) < 1e-6);
        }
    }
});

test('1:24,000 near northern Arizona lands at a plausible zoom', () => {
    const zoom = zoomForScale(24000, 96, 35.2);

    assert.ok(zoom > 13 && zoom < 13.5, `zoom was ${zoom}`);
});

test('higher latitude needs a lower zoom for the same scale', () => {
    // Web Mercator stretches toward the poles, so the same ground scale sits at a
    // lower zoom the further north you go.
    assert.ok(zoomForScale(24000, 96, 65) < zoomForScale(24000, 96, 35));
});

test('bbox centre and ground size are computed through the middle', () => {
    const bbox: [number, number, number, number] = [-112, 35, -111, 36];

    assert.deepEqual(bboxCenter(bbox), [-111.5, 35.5]);

    const ground = bboxMetres(bbox);
    // One degree of latitude is about 111.3 km everywhere.
    assert.ok(Math.abs(ground.height - 111319) < 100, `height ${ground.height}`);
    // One degree of longitude at 35.5 deg is about 90.6 km.
    assert.ok(Math.abs(ground.width - 90600) < 500, `width ${ground.width}`);
});

test('fit-to-area picks the axis that needs the coarser scale', () => {
    const frame = sheet('letter', 'portrait').frame;

    // A wide, short bbox must be driven by its width.
    const wide = scaleForBBox([-112, 35, -111, 35.05], frame);
    const ground = bboxMetres([-112, 35, -111, 35.05]);

    assert.ok(Math.abs(wide - ground.width / (frame.width * 0.0254)) < 1e-6);
});

test('a computed scale always snaps up, never down', () => {
    assert.equal(snapScale(18437), 24000);
    assert.equal(snapScale(24000), 24000);
    assert.equal(snapScale(24001), 25000);
    assert.equal(snapScale(5), 6000);

    // Beyond the ladder it still rounds up rather than returning undefined.
    assert.ok(snapScale(250000) >= 250000);
});

test('a snapped scale always fits the area that produced it', () => {
    const frame = sheet('tabloid', 'portrait').frame;
    const bbox: [number, number, number, number] = [-111.9, 35.05, -111.4, 35.4];

    const snapped = snapScale(scaleForBBox(bbox, frame));
    const ground = bboxMetres(bbox);

    assert.ok(frame.width * 0.0254 * snapped >= ground.width);
    assert.ok(frame.height * 0.0254 * snapped >= ground.height);
});

test('grid interval follows the scale bands in DESIGN.md', () => {
    assert.equal(gridInterval(6000), 200);
    assert.equal(gridInterval(12000), 500);
    assert.equal(gridInterval(24000), 1000);
    assert.equal(gridInterval(25000), 1000);
    assert.equal(gridInterval(50000), 1000);
    assert.equal(gridInterval(62500), 1000);
    assert.equal(gridInterval(100000), 5000);
});
