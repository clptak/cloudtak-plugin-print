import Err from '@openaddresses/batch-error';
import Schema from '@openaddresses/batch-schema';
import { Type } from '@sinclair/typebox';
import auth, { tokenFrom } from '../lib/auth.js';
import config from '../lib/config.js';
import { PrintRequest, JobStatus } from '../lib/types.js';
import { sheet, footprint } from '../lib/paper.js';
import { resolve } from '../lib/resolution.js';
import { zoomForScale, bboxCenter, scaleForBBox, snapScale, type BBox } from '../lib/geo.js';
import { renderMap } from '../lib/render.js';
import { smokeRender } from '../lib/browser.js';
import type { Queue, JobRecord } from '../lib/queue.js';

function present(job: JobRecord) {
    return {
        job: job.job,
        status: job.status,
        progress: job.progress,
        step: job.step,
        created: job.created,
        error: job.error,
        sheet: job.sheet,
        warnings: job.warnings,
    };
}

export default async function router(schema: Schema, cfg: { queue: Queue }) {
    schema.post('/print-api/jobs', {
        name: 'Submit Print Job',
        group: 'Jobs',
        description: 'Queue a map sheet for rendering',
        query: Type.Object({
            token: Type.Optional(Type.String()),
        }),
        body: PrintRequest,
        res: JobStatus,
    }, async (req, res) => {
        try {
            const raw = tokenFrom(req.headers as Record<string, unknown>, req.query as Record<string, unknown>);
            const token = auth(raw);

            const body = req.body;

            if (!body.center && !body.bbox) {
                throw new Err(400, null, 'Either center (scale-first) or bbox (fit-to-area) must be provided');
            }
            if (body.center && body.bbox) {
                throw new Err(400, null, 'center and bbox are mutually exclusive');
            }

            const c = config();

            const geometry = sheet(body.paper.size, body.paper.orientation);

            // Fit-to-area derives the scale from the drawn rectangle and snaps it UP
            // to a standard value, so the whole drawn area stays on the sheet.
            // Scale-first uses the scale as given; the box is only a placement.
            const scale = body.bbox
                ? snapScale(scaleForBBox(body.bbox as BBox, geometry.frame))
                : body.scale;

            const center = body.bbox
                ? bboxCenter(body.bbox as BBox)
                : body.center as [number, number];

            const ground = footprint(body.paper.size, body.paper.orientation, scale);

            // DPI is clamped, not rejected. The binding constraint is the GL texture
            // limit — 8192 under SwiftShader — applied to the backing store.
            const resolution = resolve({
                frameInches: geometry.frame,
                requestedDpi: body.dpi,
                maxDpi: c.maxDpi,
                layoutDpi: c.layoutDpi,
                maxTexture: c.maxTexture,
            });

            // Scale is exact at the sheet's centre latitude; see lib/geo.ts.
            const zoom = zoomForScale(scale, c.layoutDpi, center[1]);

            const derived = {
                frameInches: { width: geometry.frame.width, height: geometry.frame.height },
                groundMetres: { width: Math.round(ground.width), height: Math.round(ground.height) },
                dpi: resolution.dpi,
                pixels: resolution.pixels,
                clampedBy: resolution.clampedBy,
                scale,
                zoom: Number(zoom.toFixed(4)),
            };

            const style = body.style;

            const job = cfg.queue.submit(token.email, async (ctx) => {
                // PHASE 3 replaces this with the page layout and a PDF; for now the
                // artifact is the map raster alone.
                if (!style) {
                    ctx.progress(0.1, 'no style supplied, rendering test pattern');

                    return {
                        body: await smokeRender({
                            width: resolution.css.width,
                            height: resolution.css.height,
                            scale: resolution.deviceScale,
                        }),
                        contentType: 'image/png',
                    };
                }

                ctx.progress(0.1, 'rendering map');

                const result = await renderMap({
                    width: resolution.css.width,
                    height: resolution.css.height,
                    scale: resolution.deviceScale,
                    style,
                    center,
                    zoom,
                    images: body.images,
                    overlays: body.overlays,
                    token: raw,
                    rewrite: {
                        apiInternalUrl: c.apiUrl,
                        tilesInternalUrl: c.tilesInternalUrl,
                        apiPublicHost: c.apiPublicHost,
                        tilesPublicHost: c.tilesPublicHost,
                        allowHosts: c.allowHosts,
                    },
                });

                ctx.progress(1, 'complete');

                return { body: result.png, contentType: 'image/png', warnings: result.warnings };
            }, derived);

            res.status(202).json(present(job));
        } catch (err) {
            Err.respond(err, res);
        }
    });

    schema.get('/print-api/jobs/:id', {
        name: 'Job Status',
        group: 'Jobs',
        description: 'Poll a print job',
        params: Type.Object({ id: Type.String() }),
        query: Type.Object({ token: Type.Optional(Type.String()) }),
        res: JobStatus,
    }, async (req, res) => {
        try {
            const token = auth(tokenFrom(req.headers as Record<string, unknown>, req.query as Record<string, unknown>));

            const job = cfg.queue.get(req.params.id, token.email);
            if (!job) throw new Err(404, null, 'Job Not Found');

            res.json(present(job));
        } catch (err) {
            Err.respond(err, res);
        }
    });

    schema.get('/print-api/jobs/:id/result', {
        name: 'Job Result',
        group: 'Jobs',
        description: 'Download the rendered artifact',
        params: Type.Object({ id: Type.String() }),
        query: Type.Object({ token: Type.Optional(Type.String()) }),
    }, async (req, res) => {
        try {
            const token = auth(tokenFrom(req.headers as Record<string, unknown>, req.query as Record<string, unknown>));

            const job = cfg.queue.get(req.params.id, token.email);
            if (!job) throw new Err(404, null, 'Job Not Found');
            if (job.status === 'failed') throw new Err(500, null, job.error || 'Job Failed');
            if (!job.artifact) throw new Err(409, null, `Job is ${job.status}`);

            res.set('Content-Type', job.artifact.contentType);
            res.set('Cache-Control', 'private, max-age=3600');
            res.send(job.artifact.body);
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
