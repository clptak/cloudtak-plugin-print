import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { squareId, usng, toUTM } from '../lib/utm.js';

/**
 * Checked against an independent implementation: the fixture was generated with
 * the Python `mgrs` package, which wraps NGA's GeoTrans and shares no code with
 * lib/utm.ts. 411 points -- named cases at the awkward places (band and zone
 * boundaries, the Norway and Svalbard exceptions, the southern hemisphere) plus
 * random points over Arizona and the whole UTM domain.
 */
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/usng-reference.json', import.meta.url), 'utf8')) as {
    points: Array<{ name: string; lat: number; lon: number; usng: string }>;
};

test('every reference point agrees with GeoTrans to 10 m', () => {
    // GeoTrans zero-pads single-digit zones ('02S'); this does not ('2S'), to
    // match how the sheet already prints 'UTM 12S'. Both forms are valid and
    // parse identically, and no zone in the lower 48 is a single digit, so the
    // comparison strips the pad and checks everything that carries meaning.
    const wrong = fixture.points
        .map((p) => {
            return { ...p, ours: usng(p.lon, p.lat, 4), theirs: p.usng.replace(/^0/, '') };
        })
        .filter((p) => {
            return p.ours !== p.theirs;
        });

    assert.equal(
        wrong.length, 0,
        wrong.slice(0, 5).map(p => `${p.name} ${p.lat},${p.lon}: ours ${p.ours}, GeoTrans ${p.theirs}`).join('\n'),
    );
    assert.ok(fixture.points.length > 400);
});

test('the sheets already printed read as expected', () => {
    assert.equal(usng(-111.757376, 34.942983), '12S VD 3083 6698');
    assert.equal(usng(-108.998468, 39.148791), '12S XJ 7295 3519');
});

test('digits are truncated, never rounded', () => {
    // A reference names the square the point is IN. 6698.9 must read 6698.
    const u = toUTM(-111.757376, 34.942983);
    const metres = Math.floor(u.northing % 100000);
    assert.equal(usng(-111.757376, 34.942983, 5).split(' ')[3], String(metres).padStart(5, '0'));
});

test('adjacent zones never share a square ID at their common boundary', () => {
    // The even-zone row offset exists for exactly this.
    const east = usng(-113.9999, 35.0).split(' ');
    const west = usng(-114.0001, 35.0).split(' ');
    assert.notEqual(east[0], west[0]);
    assert.notEqual(east[1], west[1]);
});

test('squareId rejects an easting outside the zone', () => {
    assert.throws(() => squareId(12, 50000, 3800000), /no 100 km square/);
});

test('UPS latitudes are refused rather than mislabelled', () => {
    assert.throws(() => usng(0, 85), /outside the USNG\/MGRS UTM domain/);
    assert.throws(() => usng(0, -81), /outside the USNG\/MGRS UTM domain/);
});

test('the dense ladder is live, and every line it draws is a USNG digit', async () => {
    const { usngInterval, USNG_LADDER, USNG_DENSE } = await import('../lib/geo.js');

    // DECISION POINT: if this fails because USNG_LADDER was switched to the
    // sparse ladder on purpose, update the expectation -- do not revert it.
    assert.equal(USNG_LADDER, USNG_DENSE);

    assert.equal(usngInterval(6000), 100);
    assert.equal(usngInterval(12000), 100);
    assert.equal(usngInterval(15840), 1000);
    assert.equal(usngInterval(24000), 1000);
    assert.equal(usngInterval(100000), 1000);
    assert.equal(usngInterval(250000), 10000);
    assert.equal(usngInterval(5000000), 100000);

    for (const scale of [1000, 6000, 12000, 24000, 100000, 500000, 5000000]) {
        assert.ok(Math.log10(usngInterval(scale)) % 1 === 0, `1:${scale} is not a power of ten`);
    }
});

test('the sparse ladder is ready to swap in and differs only where it was meant to', async () => {
    const { usngInterval, USNG_DENSE, USNG_SPARSE } = await import('../lib/geo.js');

    const differ = [6000, 12000, 15840, 24000, 25000, 50000, 62500, 100000].filter((s) => {
        return usngInterval(s, USNG_DENSE) !== usngInterval(s, USNG_SPARSE);
    });

    // The two awkward scales from the decision, and nothing else on the standard list.
    assert.deepEqual(differ, [12000, 100000]);
});
