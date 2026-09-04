import Err from '@openaddresses/batch-error';
import type { Route, Request as PWRequest } from 'playwright';
import { withMapPage, type PageSize } from './browser.js';
import { rewriteStyle, redact, type StyleDocument, type RewriteOptions } from './style.js';

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
    /** Called with a human-readable step so a long render is not a silent one. */
    onProgress?: (step: string) => void;
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

        /*
         * A render that never settles is the hardest failure to diagnose from the
         * outside: MapLibre simply never fires 'idle'. Tracking every request means
         * a timeout can say WHICH fetches are still outstanding rather than just
         * that time ran out.
         */
        const inflight = new Map<string, number>();
        let started = 0;
        let finished = 0;

        page.on('request', (request) => {
            started++;
            inflight.set(request.url(), Date.now());
        });
        page.on('requestfinished', (request) => {
            finished++;
            inflight.delete(request.url());
        });

        // MapLibre reports a failed fetch as status 0 with no reason, which is
        // indistinguishable between CORS, abort and connection refused. Chromium
        // knows which it was, so capture it.
        const failures: string[] = [];
        page.on('requestfailed', (request) => {
            inflight.delete(request.url());
            const reason = request.failure()?.errorText ?? 'unknown';
            if (reason === 'net::ERR_ABORTED') return; // our own allowlist, already reported
            failures.push(`${reason} <- ${redact(request.url())}`);
        });

        const heartbeat = req.onProgress
            ? setInterval(() => {
                    req.onProgress!(`loading: ${finished}/${started} requests, ${inflight.size} outstanding`);
                }, 5000)
            : undefined;

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
                __prepared?: boolean;
                __failed?: string;
                __diag?: Record<string, number>;
                __t0?: number;
            };

            const decode = (image: { data: string; width: number; height: number }): ImageData => {
                const binary = atob(image.data);
                const bytes = new Uint8ClampedArray(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                return new ImageData(bytes, image.width, image.height);
            };

            const pool = new Map<string, HarvestedImage>();
            for (const image of input.images) pool.set(image.id, image);

            const diag = { images: input.images.length, imageMs: 0, styleMs: 0, settleMs: 0, errors: 0 };
            const t0 = Date.now();
            w.__diag = diag;
            w.__t0 = t0;

            const MapCtor = w.maplibregl.Map as new (opts: unknown) => {
                on: (ev: string, cb: (e?: unknown) => void) => void;
                once: (ev: string, cb: () => void) => void;
                addImage: (id: string, image: ImageData, opts?: unknown) => void;
                hasImage: (id: string) => boolean;
                getSource: (id: string) => { setData?: (d: unknown) => void } | undefined;
                isStyleLoaded: () => boolean;
                loaded: () => boolean;
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

            const prepare = async (): Promise<void> => {
                // Wait for the style, then install images and overlays.
                //
                // This used to hang off map.once('load'). When every source fails
                // to fetch — an expired token, a blocked host, an unreachable API —
                // MapLibre never fires 'load' or 'idle' at all, even though
                // map.loaded() goes true. The icons and overlays were then silently
                // never applied, and the render waited for an event that was never
                // coming.
                while (!map.isStyleLoaded()) {
                    await new Promise((resolve) => {
                        return setTimeout(resolve, 50);
                    });
                }

                diag.styleMs = Date.now() - t0;

                const ti = Date.now();
                for (const id of pool.keys()) install(id);
                diag.imageMs = Date.now() - ti;

                for (const overlay of input.overlays) {
                    const source = map.getSource(overlay.source);
                    if (source && source.setData) source.setData(overlay.data);
                }

                w.__prepared = true;
            };

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
                const event = e as { error?: Error; tile?: unknown; sourceId?: string };
                diag.errors++;
                // A failure attached to a tile or a source is a data problem, and is
                // reported through the request log instead. Only a style-level error
                // is fatal — anything else would fail a sheet over one bad tile.
                if (event.error && !event.tile && !event.sourceId) {
                    w.__failed = event.error.message;
                }
            });

            void prepare();
        }, {
            style,
            center: req.center,
            zoom: req.zoom,
            images: req.images ?? [],
            overlays: req.overlays ?? [],
        });

        try {
            /*
             * Settle on map.loaded(), not on the 'idle' event.
             *
             * MapLibre does not fire 'load' or 'idle' when every source fails to
             * fetch, but map.loaded() still becomes true. Waiting on the event
             * therefore hangs until the timeout on exactly the sheets that most
             * need a diagnosis. loaded() is also the more direct question: is
             * there any outstanding work.
             *
             * Two consecutive true readings are required because applying overlay
             * data makes the map dirty again, so a single reading can catch the
             * quiet moment in between.
             */
            await page.waitForFunction(
                () => {
                    const w = window as unknown as {
                        __prepared?: boolean;
                        __failed?: string;
                        __map?: { loaded: () => boolean };
                        __settledOnce?: boolean;
                    };

                    if (typeof w.__failed === 'string') return true;
                    if (!w.__prepared || !w.__map) return false;

                    if (!w.__map.loaded()) {
                        w.__settledOnce = false;
                        return false;
                    }

                    if (!w.__settledOnce) {
                        w.__settledOnce = true;
                        return false;
                    }

                    return true;
                },
                undefined,
                { timeout, polling: 250 },
            );

            await page.evaluate(() => {
                const w = window as unknown as { __diag?: { settleMs: number }; __t0?: number };
                if (w.__diag && w.__t0) w.__diag.settleMs = Date.now() - w.__t0;
            });
        } catch {
            // Ask the map what it is still waiting for, and name the oldest
            // outstanding fetches. "Timed out" on its own is not actionable.
            const state = await page.evaluate(() => {
                const w = window as unknown as {
                    __map?: {
                        isStyleLoaded: () => boolean;
                        areTilesLoaded: () => boolean;
                        loaded: () => boolean;
                    };
                    __diag?: Record<string, unknown>;
                    __prepared?: boolean;
                };

                if (!w.__map) return { styleLoaded: null, tilesLoaded: null, loaded: null, prepared: w.__prepared, diag: w.__diag };

                return {
                    styleLoaded: w.__map.isStyleLoaded(),
                    tilesLoaded: w.__map.areTilesLoaded(),
                    loaded: w.__map.loaded(),
                    prepared: w.__prepared === true,
                    diag: w.__diag,
                };
            }).catch(() => null);

            const now = Date.now();
            const oldest = [...inflight.entries()]
                .sort((a, b) => {
                    return a[1] - b[1];
                })
                .slice(0, 6)
                .map(([url, at]) => {
                    return `${Math.round((now - at) / 1000)}s ${redact(url)}`;
                });

            throw new Err(504, null, [
                `Render did not settle within ${timeout / 1000}s.`,
                `requests: ${finished}/${started} finished, ${inflight.size} outstanding, ${failures.length} failed.`,
                state ? `map: styleLoaded=${state.styleLoaded} tilesLoaded=${state.tilesLoaded} loaded=${state.loaded} prepared=${state.prepared}.` : '',
                state && state.diag ? `page: ${JSON.stringify(state.diag)}.` : '',
                oldest.length ? `oldest outstanding: ${oldest.join(' | ')}` : '',
                failures.length ? `failures: ${failures.slice(0, 3).join('; ')}` : '',
            ].filter(Boolean).join(' '));
        } finally {
            if (heartbeat) clearInterval(heartbeat);
        }

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
