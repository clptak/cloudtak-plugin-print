import Schema from '@openaddresses/batch-schema';
import { Type } from '@sinclair/typebox';
import config from '../lib/config.js';
import { PAPER, MARGINS, GRID_GUTTER } from '../lib/paper.js';
import { STANDARD_SCALES, gridInterval } from '../lib/geo.js';

export default async function router(schema: Schema) {
    schema.get('/print-api', {
        name: 'API Info',
        group: 'Root',
        description: 'Return API info for the CloudTAK Print service',
        res: Type.Object({
            name: Type.String(),
            version: Type.String(),
            concurrency: Type.Integer(),
            maxDpi: Type.Integer(),
            layoutDpi: Type.Integer(),
            maxTexture: Type.Integer(),
            hosts: Type.Object({
                apiPublic: Type.Union([Type.String(), Type.Null()]),
                tilesPublic: Type.Union([Type.String(), Type.Null()]),
                apiInternal: Type.String(),
                tilesInternal: Type.String(),
                allow: Type.Array(Type.String()),
            }),
            paper: Type.Array(Type.Object({
                id: Type.String(),
                label: Type.String(),
                width: Type.Number(),
                height: Type.Number(),
            })),
            /**
             * The plugin draws the sheet box from these rather than carrying its
             * own copy. A duplicated margin is how a box on screen silently stops
             * matching the sheet that comes off the plotter.
             */
            margins: Type.Object({
                top: Type.Number(),
                right: Type.Number(),
                bottom: Type.Number(),
                left: Type.Number(),
            }),
            gridGutter: Type.Number(),
            /**
             * Scale paired with the UTM grid interval it prints. Every threshold in
             * gridInterval() coincides with an entry here, so a client can derive the
             * interval for a custom scale by taking the first rung at or above it --
             * the same lookup snapScale() uses. service/test/base.test.ts pins that.
             */
            scales: Type.Array(Type.Object({
                scale: Type.Integer(),
                grid: Type.Integer(),
            })),
        }),
    }, (req, res) => {
        const c = config();

        res.json({
            name: 'CloudTAK Print',
            version: '0.1.0',
            concurrency: c.concurrency,
            maxDpi: c.maxDpi,
            layoutDpi: c.layoutDpi,
            maxTexture: c.maxTexture,
            // Exposed because a wrong or missing public host silently drops every
            // CloudTAK source in a style, and that should be one curl to find.
            hosts: {
                apiPublic: c.apiPublicHost ?? null,
                tilesPublic: c.tilesPublicHost ?? null,
                apiInternal: c.apiUrl,
                tilesInternal: c.tilesInternalUrl,
                allow: c.allowHosts,
            },
            paper: Object.entries(PAPER).map(([id, p]) => ({
                id,
                label: p.label,
                width: p.width,
                height: p.height,
            })),
            margins: MARGINS,
            gridGutter: GRID_GUTTER,
            scales: STANDARD_SCALES.map((scale) => {
                return { scale, grid: gridInterval(scale) };
            }),
        });
    });

    /**
     * Unauthenticated on purpose: this is what the Docker healthcheck and Gatus
     * poll. It reports liveness only — no configuration, no job data.
     */
    schema.get('/print-api/health', {
        name: 'Health',
        group: 'Root',
        description: 'Liveness probe',
        res: Type.Object({
            status: Type.String(),
        }),
    }, (req, res) => {
        res.json({ status: 'ok' });
    });
}
