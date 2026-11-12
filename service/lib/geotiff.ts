/**
 * The map frame as a GeoTIFF.
 *
 * A GeoPDF carries the whole sheet -- collar, title strip, margins -- and GDAL
 * rasterizes all of it on import (docs/GEOREFERENCING.md section 4). A GeoTIFF
 * is the map frame and nothing else, so it imports as a clean overlay with no
 * collar, and needs neither GDAL's PDF driver nor GDAL_PDF_BANDS=4 on the
 * CloudTAK events container.
 *
 * No reprojection is involved. MapLibre draws in Web Mercator, so the rendered
 * raster already IS an EPSG:3857 grid: the only thing to add is where its corner
 * sits and how big a pixel is. That is computed from the same view the renderer
 * and the grid were given -- centre, zoom and CSS size -- rather than from the
 * paper scale, so it describes the pixels that were actually drawn.
 *
 * The file is written by gdal_translate as a Cloud-Optimized GeoTIFF: tiled,
 * DEFLATE-compressed, with overviews. Writing TIFF by hand is easy; writing one
 * that every GIS reads correctly and that is not four times the size is GDAL's
 * job.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getBrowser, ORIGIN } from './browser.js';

const run = promisify(execFile);

/** Web Mercator sphere radius, the EPSG:3857 definition. */
const R = 6378137;
/** MapLibre's world is 512 CSS pixels wide at zoom 0. */
const WORLD_PX_AT_Z0 = 512;

export type View = {
    /** [longitude, latitude] at the centre of the frame. */
    center: [number, number];
    zoom: number;
    /** Frame size in CSS pixels, as given to the renderer. */
    width: number;
    height: number;
};

/** [minX, minY, maxX, maxY] in EPSG:3857 metres. */
export type Extent = [number, number, number, number];

/**
 * The EPSG:3857 extent the renderer drew, from the view it was given.
 *
 * Same arithmetic as `projector` and `viewportBBox` in lib/grid.ts, which is
 * what keeps a grid burned into the raster in register with the declared
 * georeferencing.
 */
export function viewExtent(view: View): Extent {
    if (!Number.isFinite(view.center[0]) || !Number.isFinite(view.center[1])) {
        throw new Error('geotiff: centre is not a finite coordinate');
    }

    if (Math.abs(view.center[1]) > 85) {
        throw new Error(`geotiff: latitude ${view.center[1]} is outside the Web Mercator domain`);
    }

    const cx = R * (view.center[0] * Math.PI / 180);
    const cy = R * Math.log(Math.tan(Math.PI / 4 + (view.center[1] * Math.PI / 180) / 2));

    // Projected metres per CSS pixel at this zoom.
    const mpp = (2 * Math.PI * R) / (WORLD_PX_AT_Z0 * 2 ** view.zoom);

    const halfW = (view.width * mpp) / 2;
    const halfH = (view.height * mpp) / 2;

    return [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
}

/** Width and height of a PNG, from its IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
    const signature = '89504e470d0a1a0a';

    if (png.length < 24 || png.subarray(0, 8).toString('hex') !== signature || png.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error('geotiff: map raster is not a PNG');
    }

    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * The GDAL geotransform for a raster of `size` pixels covering `extent`:
 * [originX, pixelWidth, 0, originY, 0, -pixelHeight], origin at the north-west
 * corner of the north-west pixel.
 *
 * Pixel size comes from the PNG's actual dimensions, not from CSS size times
 * device scale: Chromium rounds the screenshot to whole pixels, and the extent
 * is what has to stay fixed.
 */
export function geotransform(extent: Extent, size: { width: number; height: number }): number[] {
    const [minX, minY, maxX, maxY] = extent;

    return [minX, (maxX - minX) / size.width, 0, maxY, 0, -(maxY - minY) / size.height];
}

/**
 * Draw the grid's line work into the map raster.
 *
 * In the PDF the grid stays vector, laid over the image. A GeoTIFF has no layer
 * to lay it on, so it is composited here at the raster's own resolution. The
 * grid SVG spans the whole sheet so its labels can sit in the margin; it is
 * offset by the frame origin and clipped to the frame, which keeps the lines and
 * any in-frame labels and drops the margin labels -- the overlay's position on
 * the map now does their job.
 */
export async function burnGrid(opts: {
    png: Buffer;
    grid: string;
    /** Frame size in CSS pixels. */
    width: number;
    height: number;
    /** Chromium deviceScaleFactor the map was rendered at. */
    scale: number;
    /** Frame origin on the sheet, in CSS pixels. */
    offset: { x: number; y: number };
}): Promise<Buffer> {
    const browser = await getBrowser();
    const context = await browser.newContext({
        viewport: { width: Math.ceil(opts.width), height: Math.ceil(opts.height) },
        deviceScaleFactor: opts.scale,
    });

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: transparent; }
  #print-frame { position: relative; overflow: hidden; width: ${opts.width}px; height: ${opts.height}px; }
  #print-frame img { display: block; width: ${opts.width}px; height: ${opts.height}px; }
  #print-frame svg.grid { position: absolute; left: ${-opts.offset.x}px; top: ${-opts.offset.y}px; }
</style></head><body><div id="print-frame"><img src="${ORIGIN}/map.png" alt="">${opts.grid}</div></body></html>`;

    try {
        const page = await context.newPage();

        await page.route(`${ORIGIN}/**`, async (route) => {
            const pathname = new URL(route.request().url()).pathname;

            if (pathname === '/map.png') {
                return route.fulfill({ status: 200, contentType: 'image/png', body: opts.png });
            }
            if (pathname === '/frame.html') {
                return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
            }

            return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
        });

        await page.goto(`${ORIGIN}/frame.html`, { waitUntil: 'domcontentloaded' });

        await page.waitForFunction(() => {
            return Array.from(document.images).every((img) => {
                return img.complete && img.naturalWidth > 0;
            });
        }, undefined, { timeout: 120000 });

        return await page.locator('#print-frame').screenshot({ type: 'png', omitBackground: true });
    } finally {
        await context.close();
    }
}

/**
 * Wrap a map raster as a Cloud-Optimized GeoTIFF in EPSG:3857.
 *
 * `gdal` is the gdal_translate binary; PRINT_GDAL_TRANSLATE overrides it for a
 * host where it is not on PATH.
 */
export async function toGeoTiff(png: Buffer, extent: Extent, opts: {
    title?: string;
    gdal?: string;
    timeoutMs?: number;
} = {}): Promise<Buffer> {
    pngSize(png);
    const [minX, minY, maxX, maxY] = extent;

    if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) {
        throw new Error('geotiff: extent is empty or not finite');
    }

    const dir = await mkdtemp(path.join(tmpdir(), 'print-tif-'));
    const src = path.join(dir, 'map.png');
    const dst = path.join(dir, 'map.tif');

    try {
        await writeFile(src, png);

        const args = [
            '-q',
            '-of', 'COG',
            '-a_srs', 'EPSG:3857',
            // -a_ullr is ulx uly lrx lry: west north east south.
            '-a_ullr', String(minX), String(maxY), String(maxX), String(minY),
            '-co', 'COMPRESS=DEFLATE',
            '-co', 'PREDICTOR=YES',
            '-co', 'OVERVIEWS=AUTO',
            '-co', 'BIGTIFF=IF_SAFER',
            '-mo', `TIFFTAG_SOFTWARE=cloudtak-plugin-print`,
            '-mo', `TIFFTAG_DATETIME=${tiffDate(new Date())}`,
        ];

        if (opts.title) args.push('-mo', `TIFFTAG_DOCUMENTNAME=${opts.title.replace(/[\r\n]+/g, ' ')}`);

        args.push(src, dst);

        try {
            await run(opts.gdal ?? process.env.PRINT_GDAL_TRANSLATE ?? 'gdal_translate', args, {
                timeout: opts.timeoutMs ?? 120000,
                maxBuffer: 1024 * 1024,
            });
        } catch (err) {
            const e = err as NodeJS.ErrnoException & { stderr?: string };
            if (e.code === 'ENOENT') {
                throw new Error('gdal_translate is not installed in the print service image', { cause: err });
            }
            throw new Error(`gdal_translate failed: ${(e.stderr || e.message).trim().slice(0, 500)}`, { cause: err });
        }

        const tif = await readFile(dst);

        // A sanity check worth its cost: a file that is not a TIFF would be
        // uploaded and only fail inside CloudTAK's importer, minutes later.
        if (tif.length < 8 || !['49492a00', '4d4d002a', '49492b00', '4d4d002b'].includes(tif.subarray(0, 4).toString('hex'))) {
            throw new Error('gdal_translate did not produce a TIFF');
        }

        return tif;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/** TIFF's own date format, "YYYY:MM:DD HH:MM:SS". */
function tiffDate(d: Date): string {
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '').replace(/-/g, ':');
}
