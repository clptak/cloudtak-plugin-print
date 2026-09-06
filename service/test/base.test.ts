import test from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_SCALES, gridInterval } from '../lib/geo.js';

/**
 * The /print-api info route hands the plugin a scale -> grid-interval table so the
 * print panel can show the interval before a job is submitted, without carrying a
 * second copy of gridInterval().
 *
 * That only works because every threshold inside gridInterval() coincides with an
 * entry in STANDARD_SCALES, which makes "first rung at or above" reproduce the
 * function exactly rather than approximately. If someone later moves a band or
 * drops a scale, the panel would start displaying an interval the service does not
 * draw -- a wrong number on a sheet a field team measures against. This pins it.
 */
function fromTable(scale: number): number {
    const table = STANDARD_SCALES.map((s) => {
        return { scale: s, grid: gridInterval(s) };
    });

    const rung = table.find((entry) => {
        return entry.scale >= scale;
    });

    return (rung ?? table[table.length - 1]).grid;
}

test('the published table reproduces gridInterval across the offered range', () => {
    for (const scale of STANDARD_SCALES) {
        assert.equal(fromTable(scale), gridInterval(scale), `at 1:${scale}`);
    }
});

test('the published table reproduces gridInterval for custom scales', () => {
    for (let scale = 500; scale <= 500000; scale += 500) {
        assert.equal(fromTable(scale), gridInterval(scale), `at 1:${scale}`);
    }
});

test('every gridInterval threshold has a scale sitting on it', () => {
    // The property the lookup depends on, asserted directly so a future edit to
    // either list fails here with an explanation rather than in the panel.
    for (const threshold of [6000, 12000, 25000, 62500]) {
        assert.ok(
            STANDARD_SCALES.includes(threshold),
            `gridInterval() steps at 1:${threshold} but no standard scale sits on it`,
        );
    }
});
