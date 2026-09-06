import test from 'node:test';
import assert from 'node:assert/strict';
import { PAPER_SIZES, sheet, footprint } from '../../lib/paper.js';
import { STANDARD_SCALES } from '../../lib/geo.js';
import { groundFootprint, corners, boundsOf } from '../../../plugin/lib/geometry.js';
import type { Orientation } from '../../lib/paper.js';

/**
 * The plugin draws the sheet box; the service renders the sheet. They are separate
 * builds -- the plugin ships inside CloudTAK's bundle, the service inside its own
 * container -- so they cannot share an import. This is what holds them together.
 *
 * If these drift, the box on the map stops describing the paper that comes out of
 * the plotter, and nothing anywhere would say so.
 *
 * This lives under test/parity/ because it reaches across both source trees, and the
 * service's Docker build context is service/ alone -- the plugin is simply not in
 * that image. .dockerignore excludes this directory rather than letting `npm run
 * check` fail on an import that cannot resolve there. It runs on a developer
 * machine, which is where drift gets introduced in the first place.
 */

const ORIENTATIONS: Orientation[] = ['portrait', 'landscape'];
const R = 6378137;
const DEG = Math.PI / 180;

test('the plugin footprint matches the service footprint exactly', () => {
    for (const size of PAPER_SIZES) {
        for (const orientation of ORIENTATIONS) {
            const { frame } = sheet(size, orientation);

            for (const scale of STANDARD_SCALES) {
                const theirs = footprint(size, orientation, scale);
                const ours = groundFootprint(frame, scale);

                assert.ok(
                    Math.abs(ours.width - theirs.width) < 1e-6,
                    `${size} ${orientation} 1:${scale} width ${ours.width} vs ${theirs.width}`,
                );
                assert.ok(
                    Math.abs(ours.height - theirs.height) < 1e-6,
                    `${size} ${orientation} 1:${scale} height ${ours.height} vs ${theirs.height}`,
                );
            }
        }
    }
});

/**
 * True ground width spanned by the drawn ring at the centre latitude. The Mercator
 * inflation in corners() should cancel exactly here -- that cancellation is the
 * whole point of doing the box in Mercator, so it is asserted rather than assumed.
 */
function groundWidthOf(ring: [number, number][], lat: number): number {
    const west = ring[3][0];
    const east = ring[1][0];
    return (east - west) * DEG * R * Math.cos(lat * DEG);
}

function groundHeightOf(ring: [number, number][]): number {
    const south = ring[3][1];
    const north = ring[1][1];
    return (north - south) * DEG * R;
}

test('the drawn box spans the ground footprint it was given', () => {
    // Flagstaff, Grand Canyon, and a high-latitude case to keep the cos term honest.
    for (const centre of [[-111.65, 35.20], [-112.14, 36.06], [-149.9, 61.2]] as [number, number][]) {
        for (const scale of [6000, 24000, 50000, 100000]) {
            const { frame } = sheet('tabloid', 'portrait');
            const groundMetres = groundFootprint(frame, scale);

            const ring = corners({ center: centre, groundMetres });

            const width = groundWidthOf(ring, centre[1]);
            assert.ok(
                Math.abs(width - groundMetres.width) / groundMetres.width < 0.0005,
                `width at ${centre} 1:${scale}: ${width.toFixed(0)} m vs ${groundMetres.width.toFixed(0)} m`,
            );

            // Height carries a second-order Mercator term that a single sheet cannot
            // cancel, so it is held to 1% rather than to the width's tolerance.
            const height = groundHeightOf(ring);
            assert.ok(
                Math.abs(height - groundMetres.height) / groundMetres.height < 0.01,
                `height at ${centre} 1:${scale}: ${height.toFixed(0)} m vs ${groundMetres.height.toFixed(0)} m`,
            );
        }
    }
});

test('the box is centred on the point it was given', () => {
    const { frame } = sheet('letter', 'landscape');
    const centre: [number, number] = [-111.65, 35.20];
    const ring = corners({ center: centre, groundMetres: groundFootprint(frame, 24000) });

    assert.ok(Math.abs((ring[3][0] + ring[1][0]) / 2 - centre[0]) < 1e-9, 'longitude centre');
    // Mercator is not linear in latitude, so the ring's midpoint sits slightly off
    // the centre; at sheet sizes that offset is metres, not kilometres.
    assert.ok(Math.abs((ring[3][1] + ring[1][1]) / 2 - centre[1]) < 0.001, 'latitude centre');
});

test('the ring is closed and wound north-west first', () => {
    const { frame } = sheet('arch-d', 'portrait');
    const ring = corners({ center: [-111.65, 35.20], groundMetres: groundFootprint(frame, 24000) });

    assert.equal(ring.length, 5);
    assert.deepEqual(ring[0], ring[4], 'ring must close');
    assert.ok(ring[0][0] < ring[1][0], 'first corner is west of the second');
    assert.ok(ring[0][1] > ring[3][1], 'first corner is north of the fourth');
});

test('bounds come out in fitBounds order', () => {
    const { frame } = sheet('tabloid', 'portrait');
    const state = { center: [-111.65, 35.20] as [number, number], groundMetres: groundFootprint(frame, 24000) };

    const [west, south, east, north] = boundsOf(state);

    assert.ok(west < east, 'west before east');
    assert.ok(south < north, 'south before north');
    assert.ok(west < state.center[0] && state.center[0] < east, 'centre inside bounds');
    assert.ok(south < state.center[1] && state.center[1] < north, 'centre inside bounds');
});
