/**
 * Translate the client's live MapLibre style into something a headless renderer
 * can actually load.
 *
 * Three things in CloudTAK's style only work inside a browser tab:
 *
 *  1. `sprite` is `cloudtak-sprite://<id>`, a custom MapLibre protocol backed by
 *     the client's Dexie database (api/web/src/stores/modules/icons.ts). There is
 *     no Dexie here, so it is rewritten to the API endpoints that the client's own
 *     cache-miss path already falls back to.
 *  2. `glyphs` and tile URLs point at public hostnames, which would send a
 *     thousand requests per sheet back out through Caddy. They are rewritten to
 *     the internal service addresses.
 *  3. Anything else is a host this service has been asked to fetch from, and a
 *     headless renderer that fetches arbitrary URLs from inside the docker network
 *     is an SSRF engine. Unlisted hosts are dropped, never fetched.
 */

export type StyleDocument = Record<string, unknown>;

export type RewriteOptions = {
    /** Internal address of cloudtak-api. */
    apiInternalUrl: string;
    /** Internal address of cloudtak-tiles. */
    tilesInternalUrl: string;
    /** Public hostname of CloudTAK itself, e.g. cloudtak.ccsosar.net. */
    apiPublicHost?: string;
    /** Public hostname of the tile service, e.g. tiles.cloudtak.ccsosar.net. */
    tilesPublicHost?: string;
    /** Additional hosts the renderer may fetch from, for third-party basemaps. */
    allowHosts?: string[];
};

export type RewriteResult = {
    style: StyleDocument;
    /** Sources dropped, and why. Surfaced on the job so a blank map is never silent. */
    warnings: string[];
};

const SPRITE_PROTOCOL = /^cloudtak-sprite:\/\/([^/.@]+)\/?$/;

type Classified = { kind: 'api' | 'tiles' | 'allowed' | 'denied'; host: string };

function classify(raw: string, opts: RewriteOptions): Classified {
    // Style URLs may contain MapLibre placeholders ({z}, {fontstack}) that are not
    // valid URL syntax, so parse against a base and tolerate failure.
    let host: string;
    try {
        host = new URL(raw, `https://${opts.apiPublicHost ?? 'localhost'}`).host;
    } catch {
        return { kind: 'denied', host: raw };
    }

    const bare = host.replace(/:\d+$/, '');

    if (opts.tilesPublicHost && bare === opts.tilesPublicHost.replace(/:\d+$/, '')) {
        return { kind: 'tiles', host: bare };
    }
    if (opts.apiPublicHost && bare === opts.apiPublicHost.replace(/:\d+$/, '')) {
        return { kind: 'api', host: bare };
    }
    if ((opts.allowHosts ?? []).some((allowed) => {
        return bare === allowed || bare.endsWith(`.${allowed}`);
    })) {
        return { kind: 'allowed', host: bare };
    }

    return { kind: 'denied', host: bare };
}

/** Rewrite one URL to its internal equivalent, or return it unchanged if external. */
function rewriteUrl(raw: string, opts: RewriteOptions): { url: string; kind: Classified['kind'] } {
    const { kind } = classify(raw, opts);

    if (kind === 'denied' || kind === 'allowed') return { url: raw, kind };

    const target = kind === 'tiles' ? opts.tilesInternalUrl : opts.apiInternalUrl;

    // Preserve path, query and MapLibre placeholders; swap only origin.
    const base = new URL(target);
    const parsed = new URL(raw, `https://${opts.apiPublicHost ?? 'localhost'}`);

    parsed.protocol = base.protocol;
    parsed.host = base.host;

    // new URL() percent-encodes the braces MapLibre needs verbatim.
    return { url: parsed.toString().replace(/%7B/g, '{').replace(/%7D/g, '}'), kind };
}

function rewriteSprite(sprite: unknown, opts: RewriteOptions): unknown {
    const one = (entry: string): string => {
        const match = SPRITE_PROTOCOL.exec(entry);
        if (match) {
            // The client's own cache-miss path fetches /api/iconset/<id>/sprite.json,
            // so this is the documented fallback rather than an invented endpoint.
            return `${opts.apiInternalUrl.replace(/\/$/, '')}/api/iconset/${match[1]}/sprite`;
        }
        return rewriteUrl(entry, opts).url;
    };

    if (typeof sprite === 'string') return one(sprite);

    if (Array.isArray(sprite)) {
        return sprite.map((entry) => {
            const e = entry as { id: string; url: string };
            return { ...e, url: one(e.url) };
        });
    }

    return sprite;
}

export function rewriteStyle(input: StyleDocument, opts: RewriteOptions): RewriteResult {
    const warnings: string[] = [];
    const style: StyleDocument = structuredClone(input);

    if (style.sprite) style.sprite = rewriteSprite(style.sprite, opts);

    if (typeof style.glyphs === 'string') {
        const { url, kind } = rewriteUrl(style.glyphs, opts);
        if (kind === 'denied') {
            warnings.push(`glyphs host not allowed, labels will not render: ${style.glyphs}`);
            delete style.glyphs;
        } else {
            style.glyphs = url;
        }
    }

    const sources = (style.sources ?? {}) as Record<string, Record<string, unknown>>;
    const dropped = new Set<string>();

    for (const [id, source] of Object.entries(sources)) {
        // Inline GeoJSON has no host and is always safe.
        if (source.type === 'geojson' && typeof source.data !== 'string') continue;

        const urls: string[] = [];
        if (typeof source.url === 'string') urls.push(source.url);
        if (typeof source.data === 'string') urls.push(source.data);
        if (Array.isArray(source.tiles)) urls.push(...(source.tiles as string[]));

        const denied = urls.filter((u) => {
            return classify(u, opts).kind === 'denied';
        });

        if (denied.length) {
            dropped.add(id);
            warnings.push(`source '${id}' omitted: host not on the allowlist (${classify(denied[0], opts).host})`);
            continue;
        }

        if (typeof source.url === 'string') source.url = rewriteUrl(source.url, opts).url;
        if (typeof source.data === 'string') source.data = rewriteUrl(source.data, opts).url;
        if (Array.isArray(source.tiles)) {
            source.tiles = (source.tiles as string[]).map((u) => {
                return rewriteUrl(u, opts).url;
            });
        }
    }

    for (const id of dropped) delete sources[id];

    // A layer whose source is gone makes MapLibre reject the whole style, so the
    // layers have to go with it.
    if (Array.isArray(style.layers)) {
        style.layers = (style.layers as Array<Record<string, unknown>>).filter((layer) => {
            return typeof layer.source !== 'string' || !dropped.has(layer.source);
        });
    }

    return { style, warnings };
}
