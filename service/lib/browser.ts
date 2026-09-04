import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const require = createRequire(import.meta.url);

/**
 * Chromium flags for software-rendered WebGL.
 *
 * The box has no GPU, so MapLibre's GL context comes from SwiftShader via ANGLE.
 * `--enable-unsafe-swiftshader` is required on recent Chromium: without it the
 * context silently fails to create and MapLibre renders nothing, which looks like
 * a style bug rather than a GL one. `--no-sandbox` is necessary in a container;
 * the mitigation is that this service must never be reachable except through
 * Caddy, authenticated, with a tile-host allowlist.
 */
const ARGS = [
    /*
     * Required, and safe here for a specific reason.
     *
     * The render page is served from a synthetic origin fulfilled off disk, and
     * every tile then comes from a private network address (cloudtak-api on the
     * docker network). Chromium blocks that combination outright: measured, the
     * fetch fails as an opaque net::ERR_FAILED even when the server returns
     * `Access-Control-Allow-Origin: *`, and disabling the Private Network Access
     * feature flags alone does not lift it. Only this flag does.
     *
     * What the same-origin policy would protect is already protected by other
     * means, which is why this is acceptable rather than merely expedient:
     *
     *   - the page content is ours, fulfilled from disk, with no third-party
     *     script and no user-controlled markup;
     *   - every outbound request is gated by the allowlist in lib/render.ts, so
     *     what the page may reach is decided by us, not by the browser;
     *   - each render gets a fresh browser context that is discarded afterwards;
     *   - the service itself is never publicly reachable.
     *
     * Removing it will silently break all tile loading, so do not drop it while
     * tidying flags.
     */
    '--disable-web-security',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--font-render-hinting=none',
];

/**
 * Synthetic origin the render page is served from.
 *
 * MapLibre v6 ships ESM only and locates its worker with `import.meta.url`, then
 * spawns it as a module Worker. Neither relative module resolution nor a worker
 * will function on about:blank or a data: URL, so the page has to come from a
 * real origin. Everything under it is fulfilled from disk by page.route() — no
 * listening socket, and no possibility of reaching the network by accident.
 *
 * This is also the hook the tile-host rewrite will use later.
 */
export const ORIGIN = 'http://cloudtak-print.local';

const MIME: Record<string, string> = {
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
};

const MAPLIBRE_DIST = dirname(require.resolve('maplibre-gl/dist/maplibre-gl.mjs'));

let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;

export async function getBrowser(): Promise<Browser> {
    if (browser && browser.isConnected()) return browser;

    if (!launching) {
        launching = chromium.launch({
            args: ARGS,
            /**
             * The full Chromium build in new-headless mode, not the headless shell.
             * Playwright defaults to chrome-headless-shell for `headless: true`, and
             * its GL support is the weaker of the two — which matters when the only
             * renderer available is SwiftShader.
             */
            channel: process.env.PRINT_CHROMIUM_PATH ? undefined : 'chromium',
            /** Escape hatch for images that ship their own Chromium build. */
            executablePath: process.env.PRINT_CHROMIUM_PATH || undefined,
        })
            .then((launched) => {
                browser = launched;
                launched.on('disconnected', () => {
                    browser = undefined;
                });
                return launched;
            })
            .finally(() => {
                launching = undefined;
            });
    }

    return launching;
}

export async function closeBrowser(): Promise<void> {
    if (browser) {
        const closing = browser;
        browser = undefined;
        await closing.close();
    }
}

export type PageSize = { width: number; height: number; scale?: number };

/**
 * A bare page with no origin. Used for diagnostics that do not need MapLibre.
 * `deviceScaleFactor` is how print resolution is achieved: layout happens in CSS
 * pixels so label density stays correct, while the backing store renders at N x.
 */
export async function withPage<T>(opts: PageSize, fn: (page: Page) => Promise<T>): Promise<T> {
    const instance = await getBrowser();

    const context = await instance.newContext({
        viewport: { width: Math.round(opts.width), height: Math.round(opts.height) },
        deviceScaleFactor: opts.scale ?? 1,
    });

    /**
     * esbuild's `keepNames` — which tsx enables — wraps named function
     * expressions in a `__name()` helper. page.evaluate serialises the function
     * to a string and runs it in the page, where that helper does not exist, so
     * anything evaluated fails with "__name is not defined" under `npm run dev`
     * but works after `tsc`. Shimming it keeps dev and production identical
     * rather than leaving a trap that only appears in one of them.
     */
    await context.addInitScript(() => {
        const w = window as unknown as { __name?: (fn: unknown) => unknown };
        if (!w.__name) w.__name = (fn: unknown) => fn;
    });

    try {
        return await fn(await context.newPage());
    } finally {
        await context.close();
    }
}

function vendorFile(pathname: string): { body: Buffer; contentType: string } | undefined {
    const name = pathname.replace(/^\/vendor\//, '');

    // Defeat traversal before it reaches readFileSync.
    const resolved = normalize(join(MAPLIBRE_DIST, name));
    if (!resolved.startsWith(MAPLIBRE_DIST)) return undefined;

    try {
        const ext = resolved.slice(resolved.lastIndexOf('.'));
        return {
            body: readFileSync(resolved),
            contentType: MIME[ext] ?? 'application/octet-stream',
        };
    } catch {
        return undefined;
    }
}

/**
 * The render page. MapLibre is imported as a module and parked on `window` so
 * `page.evaluate` can reach it; `__maplibreReady` is the signal that it has.
 */
function shell(body: string): string {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/vendor/maplibre-gl.css">
<style>html,body{margin:0;padding:0;background:#fff}#map{width:100vw;height:100vh}</style>
</head>
<body>
${body}
<script type="module">
// maplibre-gl v6 dropped the default export; it is named exports only.
import * as maplibregl from '/vendor/maplibre-gl.mjs';
window.maplibregl = maplibregl;
window.__maplibreReady = true;
</script>
</body>
</html>`;
}

/** A page served from ORIGIN with MapLibre loaded and ready on `window`. */
export async function withMapPage<T>(
    opts: PageSize & { body?: string },
    fn: (page: Page) => Promise<T>,
): Promise<T> {
    return withPage(opts, async (page) => {
        const html = shell(opts.body ?? '<div id="map"></div>');

        await page.route(`${ORIGIN}/**`, async (route) => {
            const pathname = new URL(route.request().url()).pathname;

            if (pathname === '/' || pathname === '/index.html') {
                return route.fulfill({ status: 200, contentType: MIME['.html'], body: html });
            }

            if (pathname.startsWith('/vendor/')) {
                const asset = vendorFile(pathname);
                if (asset) {
                    return route.fulfill({ status: 200, contentType: asset.contentType, body: asset.body });
                }
            }

            return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
        });

        await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'domcontentloaded' });

        await page.waitForFunction(
            () => (window as unknown as { __maplibreReady?: boolean }).__maplibreReady === true,
            undefined,
            { timeout: 30000 },
        );

        return fn(page);
    });
}

export type GLInfo = {
    ok: boolean;
    contextType?: string;
    vendor?: string;
    renderer?: string;
    version?: string;
    shadingLanguageVersion?: string;
    maxTextureSize?: number;
    maxRenderbufferSize?: number;
    error?: string;
};

/**
 * Report what WebGL Chromium actually gives us. This is the single most useful
 * diagnostic in the service: if `ok` is false nothing downstream can work, and
 * `maxTextureSize` is the hard ceiling on how large a sheet can be rendered in
 * one pass — under SwiftShader it is materially smaller than on real hardware.
 */
export async function glInfo(): Promise<GLInfo> {
    return withPage({ width: 320, height: 240 }, async (page) => {
        await page.setContent('<canvas id="c" width="64" height="64"></canvas>');

        return page.evaluate((): GLInfo => {
            const canvas = document.getElementById('c') as HTMLCanvasElement;

            const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
            if (!gl) return { ok: false, error: 'no WebGL context could be created' };

            const debug = gl.getExtension('WEBGL_debug_renderer_info');

            return {
                ok: true,
                contextType: 'webgl2',
                vendor: debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR)),
                renderer: debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
                version: String(gl.getParameter(gl.VERSION)),
                shadingLanguageVersion: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
                maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
                maxRenderbufferSize: Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)),
            };
        });
    });
}

/**
 * Render a trivial MapLibre map with no network dependency at all — background,
 * line and circle layers over inline GeoJSON. It proves the GL path end to end
 * without involving tiles, styles or CloudTAK auth, so a failure here is
 * unambiguously a Chromium/SwiftShader problem rather than a data one.
 */
export async function smokeRender(opts: PageSize & { scale: number }): Promise<Buffer> {
    return withMapPage(opts, async (page) => {
        await page.evaluate(() => {
            const w = window as unknown as {
                maplibregl: { Map: new (opts: unknown) => { on: (ev: string, cb: () => void) => void } };
                __ready?: boolean;
                __error?: string;
            };

            const map = new w.maplibregl.Map({
                container: 'map',
                center: [-111.65, 35.2],
                zoom: 9,
                attributionControl: false,
                fadeDuration: 0,
                style: {
                    version: 8,
                    sources: {
                        probe: {
                            type: 'geojson',
                            data: {
                                type: 'FeatureCollection',
                                features: [
                                    {
                                        type: 'Feature',
                                        properties: {},
                                        geometry: { type: 'Point', coordinates: [-111.65, 35.2] },
                                    },
                                    {
                                        type: 'Feature',
                                        properties: {},
                                        geometry: {
                                            type: 'LineString',
                                            coordinates: [[-111.9, 35.05], [-111.65, 35.2], [-111.4, 35.35]],
                                        },
                                    },
                                ],
                            },
                        },
                    },
                    layers: [
                        { id: 'bg', type: 'background', paint: { 'background-color': '#12321f' } },
                        {
                            id: 'probe-line',
                            type: 'line',
                            source: 'probe',
                            paint: { 'line-color': '#ffcc00', 'line-width': 4 },
                        },
                        {
                            id: 'probe-point',
                            type: 'circle',
                            source: 'probe',
                            paint: { 'circle-color': '#ff3b30', 'circle-radius': 12 },
                        },
                    ],
                },
            });

            map.on('idle', () => {
                w.__ready = true;
            });

            map.on('error', (() => {
                w.__error = 'maplibre reported an error';
            }) as () => void);
        });

        await page.waitForFunction(
            () => (window as unknown as { __ready?: boolean }).__ready === true,
            undefined,
            { timeout: 60000 },
        );

        return page.locator('#map').screenshot({ type: 'png' });
    });
}
