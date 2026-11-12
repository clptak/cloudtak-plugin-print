import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { viewExtent, geotransform, pngSize, toGeoTiff } from '../lib/geotiff.js';
import { frameCorners, toMercator } from '../lib/georef.js';
import { zoomForScale } from '../lib/geo.js';
import { sheet, MARGINS } from '../lib/paper.js';

const LETTER = sheet('letter', 'portrait');
const CENTER: [number, number] = [-111.7574, 34.943];
const SCALE = 24000;
const LAYOUT_DPI = 200;

const VIEW = {
    center: CENTER,
    zoom: zoomForScale(SCALE, LAYOUT_DPI, CENTER[1]),
    width: LETTER.frame.width * LAYOUT_DPI,
    height: LETTER.frame.height * LAYOUT_DPI,
};

/** A minimal valid RGB PNG, so tests need no image library. */
function png(width: number, height: number): Buffer {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf: Buffer) => {
        let c = 0xffffffff;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc(body));
        return Buffer.concat([len, body, sum]);
    };

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB

    const rows = Buffer.alloc((width * 3 + 1) * height, 0x80);
    for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;

    return Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

test('the rendered extent matches the declared GeoPDF frame', () => {
    // Two derivations of the same rectangle: one from the paper scale (what the
    // GeoPDF declares), one from the zoom the renderer was given (what the
    // GeoTIFF declares). They must agree, or the two exports disagree on where
    // the map is.
    const [minX, minY, maxX, maxY] = viewExtent(VIEW);
    const corners = frameCorners({
        sheet: LETTER.sheet,
        frame: LETTER.frame,
        origin: { left: MARGINS.left, top: MARGINS.top },
        center: CENTER,
        scale: SCALE,
    });

    const [nwX, nwY] = toMercator(...corners.nw);
    const [seX, seY] = toMercator(...corners.se);

    for (const [a, b] of [[minX, nwX], [maxY, nwY], [maxX, seX], [minY, seY]]) {
        assert.ok(Math.abs(a - b) < 0.01, `${a} != ${b}`);
    }
});

test('the extent is centred on the requested point', () => {
    const [minX, minY, maxX, maxY] = viewExtent(VIEW);
    const [cx, cy] = toMercator(...CENTER);

    assert.ok(Math.abs((minX + maxX) / 2 - cx) < 1e-6);
    assert.ok(Math.abs((minY + maxY) / 2 - cy) < 1e-6);
});

test('the geotransform is north-up with square pixels', () => {
    const extent = viewExtent(VIEW);
    const gt = geotransform(extent, { width: VIEW.width, height: VIEW.height });

    assert.equal(gt[0], extent[0]);
    assert.equal(gt[3], extent[3]);
    assert.equal(gt[2], 0);
    assert.equal(gt[4], 0);
    assert.ok(gt[1] > 0 && gt[5] < 0);
    assert.ok(Math.abs(gt[1] + gt[5]) < 1e-9, 'pixels are not square');
});

test('out-of-domain centres are refused rather than written', () => {
    assert.throws(() => viewExtent({ ...VIEW, center: [0, 89] }), /Web Mercator/);
    assert.throws(() => viewExtent({ ...VIEW, center: [Number.NaN, 0] }), /finite/);
});

test('pngSize reads the IHDR and rejects anything else', () => {
    assert.deepEqual(pngSize(png(17, 9)), { width: 17, height: 9 });
    assert.throws(() => pngSize(Buffer.from('%PDF-1.7 not a png at all')), /not a PNG/);
});

function hasGdal(): boolean {
    try {
        execFileSync('gdalinfo', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

test('gdal writes a GeoTIFF that reads back with the declared extent', { skip: !hasGdal() && 'gdal not installed' }, async () => {
    const width = 300;
    const height = 374;
    const extent = viewExtent({ ...VIEW, width, height });

    const tif = await toGeoTiff(png(width, height), extent, { title: 'Test sheet' });

    const dir = mkdtempSync(path.join(tmpdir(), 'geotiff-test-'));
    try {
        const file = path.join(dir, 'out.tif');
        writeFileSync(file, tif);

        const info = JSON.parse(execFileSync('gdalinfo', ['-json', file], { encoding: 'utf8' }));

        assert.deepEqual(info.size, [width, height]);
        assert.match(info.coordinateSystem.wkt, /ID\["EPSG",3857\]/);
        assert.equal(info.metadata?.IMAGE_STRUCTURE?.LAYOUT, 'COG');

        const expected = geotransform(extent, { width, height });
        info.geoTransform.forEach((v: number, i: number) => {
            assert.ok(Math.abs(v - expected[i]) < 1e-6, `geoTransform[${i}] ${v} != ${expected[i]}`);
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
