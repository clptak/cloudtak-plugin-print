import express from 'express';
import Schema from '@openaddresses/batch-schema';
import cors from 'cors';
import fs from 'node:fs';
import config from './lib/config.js';
import { Queue } from './lib/queue.js';
import { closeBrowser, getBrowser } from './lib/browser.js';

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const dotfile = new URL('.env', import.meta.url);
        fs.accessSync(dotfile);
        process.env = Object.assign(JSON.parse(String(fs.readFileSync(dotfile))), process.env);
    } catch {
        console.log('ok - no .env file loaded - none found');
    }
}

const c = config();

export const app = express();

const queue = new Queue(c.concurrency, c.jobTtlMs);

const schema = new Schema(express.Router(), {
    logging: true,
    // A job request carries a whole MapLibre style document plus overlay GeoJSON.
    limit: 50,
});

app.disable('x-powered-by');

/**
 * The plugin calls this from the same origin as CloudTAK (Caddy routes
 * /print-api/* to this service inside the cloudtak.<domain> site block), so CORS
 * is belt-and-braces for non-browser callers rather than the load-bearing part.
 */
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || origin === 'null') {
            callback(null, true);
        } else {
            callback(null, origin);
        }
    },
    allowedHeaders: ['Content-Type', 'Content-Length', 'Cache-Control', 'Authorization', 'User-Agent'],
    credentials: true,
}));

app.use(schema.router);

await schema.api();

await schema.load(
    new URL('./routes/', import.meta.url),
    { queue },
    { silent: false },
);

app.listen(c.port, () => {
    console.log(`ok - print service on http://localhost:${c.port}`);
    console.log(`ok - concurrency=${c.concurrency} maxDpi=${c.maxDpi} layoutDpi=${c.layoutDpi}`);
    console.log(`ok - api      public=${c.apiPublicHost ?? 'UNSET'} internal=${c.apiUrl}`);
    console.log(`ok - tiles    public=${c.tilesPublicHost ?? 'UNSET'} internal=${c.tilesInternalUrl}`);
    console.log(`ok - allow    ${c.allowHosts.length ? c.allowHosts.join(', ') : '(none — CloudTAK proxies upstream basemaps)'}`);

    if (!c.apiPublicHost || !c.tilesPublicHost) {
        console.warn('not ok - a public host is UNSET; every CloudTAK source in a style will be dropped.');
        console.warn('         these derive from CloudTAK\'s API_URL and PMTILES_URL — check they reach this container.');
    }
});

// Warm Chromium at boot rather than on the first request: a cold launch under
// SwiftShader is slow enough to look like a hang, and a launch failure should
// surface in the container log at startup, not in a user's first print.
getBrowser()
    .then(() => {
        console.log('ok - chromium ready');
    })
    .catch((err) => {
        console.error('not ok - chromium failed to launch', err);
    });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        closeBrowser().finally(() => process.exit(0));
    });
}
