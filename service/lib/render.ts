import Err from '@openaddresses/batch-error';
import type { Route, Request as PWRequest } from 'playwright';
import { withMapPage, type PageSize } from './browser.js';
import { rewriteStyle, type StyleDocument, type RewriteOptions } from './style.js';

/**
 * A sprite image harvested from the client's live map.
 *
 * CloudTAK resolves most CoT icons lazily from Dexie through a
 * `styleimagemissing` handler, so replaying the style alone produces a map with
 * missing icons. Rather than reimplementing that resolver against the API — and
 * hoping it picks the same bitmap — the plugin harvests the images the user is
 * actually looking at and ships them. What prints is then literally what was on
 * screen.
 */
export type HarvestedImage = {
    id: string;
    width: number;
    height: number;
    /** Base64 RGBA bytes, width * height * 4. */
    data: string;
    pixelRatio?: number;
    sdf?: boolean;
};

export type OverlayData = {
    /** Style source id to apply this data to. */
    source: string;
    data: Record<string, unknown>;
};

export type RenderRequest = PageSize & {
    scale: number;
    style: StyleDocument;
    center: [number, number];
    zoom: number;
    images?: HarvestedImage[];
    overlays?: OverlayData[];
    /** Forwarded CloudTAK token; the renderer never mints its own. */
    token?: string;
    rewrite: RewriteOptions;
    timeoutMs?: number;
};

export type RenderResult = {
    png: Buffer;
    warnings: string[];
    /** Hosts the browser refused to contact. Should normally be empty. */
    blocked: string[];
};

/** Every host the renderer may contact, derived from the rewrite options. */
export function allowedHosts(opts: RewriteOptions): string[] {
    const hosts = [
        new URL(opts.apiInternalUrl).host,
        new URL(opts.tilesInternalUrl).host,
        ...(opts.allowHosts ?? []),
    ];

    return hosts.map((h) => {
        return h.replace(/:\d+$/, '');
    });
}

/**
 * Whether the browser may issue this request.
 *
 * Exported and pure because this is the last line of defence, not a convenience:
 * style rewriting strips unlisted hosts, but a TileJSON document fetched from an
 * allowed host can name tile URLs pointing anywhere, and nothing in the style
 * would show it. Everything the page fetches passes through here.
 */
export function isPermittedUrl(url: string, allow: string[]): boolean {
    let host: string;
    try {
        const parsed = new URL(url);
        // Only ever http(s). Denies file:, data:-driven fetches, blob:, ws:.
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        host = parsed.hostname;
    } catch {
        return false;
    }

    return allow.some((a) => {
        return host === a || host.endsWith(`.${a}`);
    });
}

function permitted(request: PWRequest, allow: string[]): boolean {
    return isPermittedUrl(request.url(), allow);
}

/**
 * Render the client's style at a given centre and zoom.
 *
 * Everything the page is allowed to fetch is decided here, not by the style.
 * Style rewriting removes unlisted hosts, but a TileJSON document fetched from an
 * allowed host can name tile URLs pointing anywhere, so the browser enforces the
 * same allowlist on every request. Anything else is aborted and reported.
 */
export async function renderMap(req: RenderRequest): Promise<RenderResult> {
    const { style, warnings } = rewriteStyle(req.style, {
        ...req.rewrite,
        token: req.token,
        hasImages: !!(req.images && req.images.length),
    });

    const allow = allowedHosts(req.rewrite);
    const blocked = new Set<string>();
    const timeout = req.timeoutMs ?? 180000;

    const png = await withMapPage({ width: req.width, height: req.height, scale: req.scale }, async (page) => {
        await page.route('**/*', async (route: Route) => {
            const request = route.request();
            const url = request.url();

            // The render page itself is served from disk by withMapPage's handler.
            if (url.startsWith('http://cloudtak-print.local/')) return route.fallback();

            if (!permitted(request, allow)) {
                blocked.add(new URL(url).host);
                return route.abort('blockedbyclient');
            }

            // Continue unmodified. The caller's token travels in the URL query,
            // stamped on during style rewriting — the same way CloudTAK does it.
            // Adding an Authorization header here would make every cross-origin GET
            // preflighted, which fails opaquely as status 0.
            return route.continue();
        });

        const errors: string[] = [];
        page.on('pageerror', (err) => {
            errors.push(err.message);
        });

        // MapLibre reports a failed fetch as status 0 with no reason, which is
        // indistinguishable between CORS, abort and connection refused. Chromium
        // knows which it was, so capture it.
        const failures: string[] = [];
        page.on('requestfailed', (request) => {
            const reason = request.failure()?.errorText ?? 'unknown';
            if (reason === 'net::ERR_ABORTED') return; // our own allowlist, already reported
            failures.push(`${reason} <- ${request.url()}`);
        });

        await page.evaluate(async (input: {
            style: StyleDocument;
            center: [number, number];
            zoom: number;
            images: HarvestedImage[];
            overlays: OverlayData[];
        }) => {
            const w = window as unknown as {
                maplibregl: Record<string, unknown>;
                __map?: unknown;
                __ready?: boolean;
                __failed?: string;
            };

            const decode = (image: { data: string; width: number; height: number }): ImageData => {
                const binary = atob(image.data);
                const bytes = new Uint8ClampedArray(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                return new ImageData(bytes, image.width, image.height);
            };

            const pool = new Map<string, HarvestedImage>();
            for (const image of input.images) pool.set(image.id, image);

            const MapCtor = w.maplibregl.Map as new (opts: unknown) => {
                on: (ev: string, cb: (e?: unknown) => void) => void;
                once: (ev: string, cb: () => void) => void;
                addImage: (id: string, image: ImageData, opts?: unknown) => void;
                hasImage: (id: string) => boolean;
                getSource: (id: string) => { setData?: (d: unknown) => void } | undefined;
            };

            const map = new MapCtor({
                container: 'map',
                style: input.style,
                center: input.center,
                zoom: input.zoom,
                bearing: 0,
                pitch: 0,
                // North-up only, so none of the interactive machinery is needed.
                interactive: false,
                attributionControl: false,
                // Any non-zero fade leaves symbols mid-transition when 'idle' fires.
                fadeDuration: 0,
                preserveDrawingBuffer: true,
            });

            w.__map = map;

            const install = (id: string): boolean => {
                const image = pool.get(id);
                if (!image) return false;
                if (map.hasImage(id)) return true;
                map.addImage(id, decode(image), {
                    pixelRatio: image.pixelRatio ?? 1,
                    sdf: image.sdf ?? false,
                });
                return true;
            };

            // Covers icons requested before and after the style settles.
            map.on('styleimagemissing', (e) => {
                install((e as { id: string }).id);
            });

            map.on('error', (e) => {
                const err = (e as { error?: Error }).error;
                // Per-tile failures are normal at the edges of a sheet; a style-level
                // failure is not, and must not be reported as a successful render.
                if (err && !(e as { tile?: unknown }).tile) w.__failed = err.message;
            });

            map.once('load', () => {
                for (const id of pool.keys()) install(id);

                for (const overlay of input.overlays) {
                    const source = map.getSource(overlay.source);
                    if (source && source.setData) source.setData(overlay.data);
                }
            });

            map.on('idle', () => {
                w.__ready = true;
            });
        }, {
            style,
            center: req.center,
            zoom: req.zoom,
            images: req.images ?? [],
            overlays: req.overlays ?? [],
        });

        await page.waitForFunction(
            () => {
                const w = window as unknown as { __ready?: boolean; __failed?: string };
                return w.__ready === true || typeof w.__failed === 'string';
            },
            undefined,
            { timeout },
        ).catch(() => {
            throw new Err(504, null, `Render did not settle within ${timeout / 1000}s`);
        });

        const failure = await page.evaluate(() => {
            return (window as unknown as { __failed?: string }).__failed;
        });

        if (failure) {
            const detail = failures.length ? ` (${failures.slice(0, 3).join('; ')})` : '';
            throw new Err(502, null, `MapLibre failed to load the style: ${failure}${detail}`);
        }

        if (failures.length) {
            warnings.push(...failures.slice(0, 10).map((f) => {
                return `request failed: ${f}`;
            }));
        }
        if (errors.length) throw new Err(502, null, `Render page error: ${errors[0]}`);

        return page.locator('#map').screenshot({ type: 'png' });
    });

    if (blocked.size) {
        warnings.push(`blocked requests to: ${[...blocked].join(', ')}`);
    }

    return { png, warnings, blocked: [...blocked] };
}
