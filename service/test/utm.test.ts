import test from 'node:test';
import assert from 'node:assert/strict';
import {
    toUTM, fromUTM, zoneFor, bandFor, centralMeridian, utmBounds, gridLines, labelParts,
} from '../lib/utm.js';

test('on a central meridian the easting is exactly the false easting', () => {
    // The definition of the projection, so it must hold at any latitude.
    for (const lat of [0, 12.5, 35.2, 60, -33]) {
        const zone = zoneFor(3, lat);
        const p = toUTM(centralMeridian(zone), lat, zone);
        assert.ok(Math.abs(p.easting - 500000) < 1e-6, `lat ${lat} gave ${p.easting}`);
    }
});

test('at the equator on a central meridian the northing is zero', () => {
    const p = toUTM(3, 0, 31);
    assert.ok(Math.abs(p.northing) < 1e-6, String(p.northing));
});

test('southern hemisphere carries the false northing', () => {
    const p = toUTM(3, -0.0001, 31);
    assert.equal(p.northern, false);
    assert.ok(Math.abs(p.northing - 10000000) < 20, String(p.northing));
});

test('forward and inverse round-trip to sub-millimetre', () => {
    const points: Array<[number, number]> = [
        [-111.6513, 35.1983], // Flagstaff
        [-114.0, 34.0], // the Arizona zone 11/12 boundary
        [3.0, 0.0],
        [151.2093, -33.8688], // Sydney
        [-149.9, 61.2], // Anchorage
    ];

    for (const [lon, lat] of points) {
        const u = toUTM(lon, lat);
        const back = fromUTM(u.easting, u.northing, u.zone, u.northern);
        // 1e-8 degrees is about 1mm.
        assert.ok(Math.abs(back.longitude - lon) < 1e-8, `lon ${lon} -> ${back.longitude}`);
        assert.ok(Math.abs(back.latitude - lat) < 1e-8, `lat ${lat} -> ${back.latitude}`);
    }
});

test('Arizona straddles zones 11 and 12 at 114 degrees west', () => {
    // The case that makes zone handling load-bearing for this project.
    assert.equal(zoneFor(-114.5, 35), 11);
    assert.equal(zoneFor(-113.5, 35), 12);
    assert.equal(zoneFor(-111.6513, 35.1983), 12);
    assert.equal(bandFor(35.1983), 'S');
});

test('the two irregularities in the zone layout are honoured', () => {
    // South-west Norway widens zone 32.
    assert.equal(zoneFor(5, 60), 32);
    assert.equal(zoneFor(5, 55), 31, 'only between 56 and 64 degrees north');

    // Svalbard rearranges 31 through 37.
    assert.equal(zoneFor(5, 75), 31);
    assert.equal(zoneFor(15, 75), 33);
    assert.equal(zoneFor(25, 75), 35);
    assert.equal(zoneFor(38, 75), 37);
});

test('latitude bands skip I and O', () => {
    assert.equal(bandFor(0), 'N');
    assert.equal(bandFor(-0.001), 'M');
    assert.doesNotMatch([...Array(160)].map((_, i) => bandFor(-80 + i)).join(''), /[IO]/);
});

test('bounds sample the edges, not just the corners', () => {
    // Because the projection curves, an extreme can fall between corners.
    const bbox: [number, number, number, number] = [-111.72, 35.15, -111.58, 35.28];
    const b = utmBounds(bbox, 12);

    const corners = [
        toUTM(bbox[0], bbox[1], 12), toUTM(bbox[2], bbox[1], 12),
        toUTM(bbox[0], bbox[3], 12), toUTM(bbox[2], bbox[3], 12),
    ];
    const cornerMaxN = Math.max(...corners.map(c => c.northing));

    assert.ok(b.maxNorthing >= cornerMaxN - 1e-6, 'edge sampling must not lose extent');
    assert.ok(b.minEasting < b.maxEasting && b.minNorthing < b.maxNorthing);
});

test('grid lines land on exact multiples of the interval', () => {
    const lines = gridLines({ bbox: [-111.72, 35.15, -111.58, 35.28], zone: 12, interval: 1000 });

    assert.ok(lines.length > 0);
    for (const line of lines) {
        assert.equal(line.value % 1000, 0, `${line.kind} ${line.value}`);
    }
});

test('a line of constant easting is a curve, not a vertical rule', () => {
    // This is the whole reason grid lines are polylines: drawing them straight
    // would be visibly wrong away from the central meridian.
    const lines = gridLines({ bbox: [-113.9, 35.0, -113.7, 35.4], zone: 12, interval: 1000 });
    const easting = lines.find(l => l.kind === 'easting');

    assert.ok(easting);
    const lons = easting!.points.map(p => p[0]);
    const spread = Math.max(...lons) - Math.min(...lons);
    assert.ok(spread > 1e-4, `expected the line to bow, longitude spread was ${spread}`);
});

test('every generated point returns to its own grid value', () => {
    const lines = gridLines({ bbox: [-111.72, 35.15, -111.58, 35.28], zone: 12, interval: 1000 });

    for (const line of lines.slice(0, 6)) {
        for (const [lon, lat] of line.points) {
            const u = toUTM(lon, lat, 12);
            const got = line.kind === 'easting' ? u.easting : u.northing;
            assert.ok(Math.abs(got - line.value) < 0.01, `${line.kind} ${line.value} -> ${got}`);
        }
    }
});

test('grid labels split into the parts a printed map sets differently', () => {
    // 439000 at a 1000m interval reads as a small 4, a large 39, a small 000.
    assert.deepEqual(labelParts(439000, 1000), {
        full: '439000', prefix: '4', principal: '39', suffix: '000',
    });

    assert.deepEqual(labelParts(3896000, 1000), {
        full: '3896000', prefix: '38', principal: '96', suffix: '000',
    });

    // A 100m interval moves the principal digits down one place.
    assert.equal(labelParts(439100, 100).principal, '91');
});
