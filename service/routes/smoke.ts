import Err from '@openaddresses/batch-error';
import Schema from '@openaddresses/batch-schema';
import { Type } from '@sinclair/typebox';
import auth, { tokenFrom } from '../lib/auth.js';
import { glInfo, smokeRender } from '../lib/browser.js';

/**
 * Diagnostics. These exist because the one genuine unknown in this service is
 * whether Chromium under SwiftShader will hand MapLibre a working GL context in
 * this container. Both endpoints avoid tiles, styles and auth to CloudTAK
 * entirely, so a failure here is unambiguously a Chromium problem.
 */
export default async function router(schema: Schema) {
    schema.get('/print-api/smoke/webgl', {
        name: 'WebGL Info',
        group: 'Smoke',
        description: 'Report the WebGL context Chromium provides in this container',
        query: Type.Object({
            token: Type.Optional(Type.String()),
        }),
        res: Type.Object({
            ok: Type.Boolean(),
            contextType: Type.Optional(Type.String()),
            vendor: Type.Optional(Type.String()),
            renderer: Type.Optional(Type.String()),
            version: Type.Optional(Type.String()),
            shadingLanguageVersion: Type.Optional(Type.String()),
            maxTextureSize: Type.Optional(Type.Integer()),
            maxRenderbufferSize: Type.Optional(Type.Integer()),
            error: Type.Optional(Type.String()),
        }),
    }, async (req, res) => {
        try {
            auth(tokenFrom(req.headers as Record<string, unknown>, req.query as Record<string, unknown>));

            res.json(await glInfo());
        } catch (err) {
            Err.respond(err, res);
        }
    });

    schema.get('/print-api/smoke/render', {
        name: 'Smoke Render',
        group: 'Smoke',
        description: 'Render a trivial MapLibre map with no network dependency and return a PNG',
        query: Type.Object({
            token: Type.Optional(Type.String()),
            width: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
            height: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
            scale: Type.Optional(Type.Number({ minimum: 1, maximum: 6 })),
        }),
    }, async (req, res) => {
        try {
            auth(tokenFrom(req.headers as Record<string, unknown>, req.query as Record<string, unknown>));

            const png = await smokeRender({
                width: req.query.width ?? 800,
                height: req.query.height ?? 600,
                scale: req.query.scale ?? 1,
            });

            res.set('Content-Type', 'image/png');
            res.set('Cache-Control', 'no-store');
            res.send(png);
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
