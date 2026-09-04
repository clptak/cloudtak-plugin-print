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
    /**
     * Caller's CloudTAK token, stamped onto rewritten CloudTAK URLs as a query
     * parameter — the way CloudTAK does it for glyphs.
     *
     * Deliberately NOT sent as an Authorization header: the render page has its
     * own origin, so every request to cloudtak-api is cross-origin, and adding an
     * Authorization header turns a simple GET into a preflighted one. That is a
     * self-inflicted CORS failure, and it surfaces as an opaque status 0.
     */
    token?: string;
    /**
     * True when the job ships harvested sprite images. The style's `sprite`
     * declaration is then removed: every image it would have provided has already
     * been supplied via addImage, so fetching the sheet is a redundant request
     * that can only fail.
     */
    hasImages?: boolean;
};

export type RewriteResult = {
    style: StyleDocument;
    /** Sources dropped, and why. Surfaced on the job so a blank map is never silent. */
    warnings: string[];
};

const SPRITE_PROTOCOL = /^cloudtak-sprite:\/\/([^/.@]+)\/?$/;

/**
 * CloudTAK registers several browser-only MapLibre protocols backed by Dexie.
 * `cloudtak-sprite://` is translated below; the others cannot be, because the
 * data behind them exists only in the client's IndexedDB. `cloudtak-tilejson://`
 * in particular fronts every overlay, so if one reaches the service the plugin
 * failed to resolve it and the sheet would lose its overlays. That must be loud.
 */
const CLIENT_PROTOCOL = /^(cloudtak-[a-z]+):\/\//;

/**
 * Warnings travel to the job status, the container log and whatever the operator
 * pastes into a chat window, so a URL carrying a session token must never appear
 * in one verbatim.
 */
export function redact(url: string): string {
    return url.replace(/([?&](?:token|access_token|api_key|key)=)[^&\s]+/gi, '$1<redacted>');
}

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

/**
 * Put the caller's token on a CloudTAK URL, REPLACING any token already there.
 *
 * The style is a snapshot of the client's map, and CloudTAK stamps tokens into
 * tile URLs when it builds TileJSON. By the time a harvested job is submitted
 * that token may be hours old and expired, and an expired token on every tile
 * URL fails the whole sheet. The caller's token is the authoritative one.
 *
 * Only ever applied to CloudTAK's own hosts — a third-party basemap must never
 * receive it.
 */
function setToken(url: string, token?: string): string {
    if (!token) return url;

    const stripped = url
        .replace(/([?&])token=[^&]*&/g, '$1')
        .replace(/[?&]token=[^&]*$/, '');

    return stripped + (stripped.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;
}

function rewriteSprite(sprite: unknown, opts: RewriteOptions): unknown {
    const one = (entry: string): string => {
        const match = SPRITE_PROTOCOL.exec(entry);
        if (match) {
            // The client's own cache-miss path fetches /api/iconset/<id>/sprite.json,
            // so this is the documented fallback rather than an invented endpoint.
            // MapLibre appends .json/.png and an @2x suffix itself.
            return setToken(
                `${opts.apiInternalUrl.replace(/\/$/, '')}/api/iconset/${match[1]}/sprite`,
                opts.token,
            );
        }
        return setToken(rewriteUrl(entry, opts).url, opts.token);
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

/**
 * When the public hostnames are unset, every CloudTAK URL looks like a stranger's
 * and the whole style is dropped. That is a configuration error, not a security
 * event, and it should say so rather than reading as a blocked attack.
 */
function hint(opts: RewriteOptions): string {
    if (opts.apiPublicHost || opts.tilesPublicHost) return '';

    return '. NOTE: neither API_PUBLIC_HOST nor TILES_PUBLIC_HOST resolved — the service '
        + 'derives them from CloudTAK\'s API_URL and PMTILES_URL, so check those reach the container';
}

export function rewriteStyle(input: StyleDocument, opts: RewriteOptions): RewriteResult {
    const warnings: string[] = [];
    const style: StyleDocument = structuredClone(input);

    if (style.sprite) {
        if (opts.hasImages) {
            // Every image the sheet would have provided is already being supplied
            // directly, so this fetch can only cost time or fail.
            delete style.sprite;
        } else {
            style.sprite = rewriteSprite(style.sprite, opts);
        }
    }

    if (typeof style.glyphs === 'string') {
        const { url, kind } = rewriteUrl(style.glyphs, opts);
        if (kind === 'denied') {
            warnings.push(
                `glyphs host not allowed, labels will not render: ${redact(style.glyphs)}`
                + hint(opts),
            );
            delete style.glyphs;
        } else {
            style.glyphs = setToken(url, opts.token);
        }
    }

    const sources = (style.sources ?? {}) as Record<string, Record<string, unknown>>;
    const dropped = new Set<string>();

    /**
     * MapLibre rejects an entire style over one unknown property on one source,
     * and reports it without naming the source. Since the style is assembled by a
     * client we do not control, strip the combinations known to be invalid rather
     * than losing a whole sheet to them.
     *
     * `scheme` is valid on vector and raster sources but not on raster-dem.
     */
    for (const source of Object.values(sources)) {
        if (source.type === 'raster-dem' && 'scheme' in source) {
            delete source.scheme;
            warnings.push('removed invalid \'scheme\' property from a raster-dem source');
        }
    }

    for (const [id, source] of Object.entries(sources)) {
        // Inline GeoJSON has no host and is always safe.
        if (source.type === 'geojson' && typeof source.data !== 'string') continue;

        const urls: string[] = [];
        if (typeof source.url === 'string') urls.push(source.url);
        if (typeof source.data === 'string') urls.push(source.data);
        if (Array.isArray(source.tiles)) urls.push(...(source.tiles as string[]));

        const clientOnly = urls.find((u) => {
            return CLIENT_PROTOCOL.test(u) && !SPRITE_PROTOCOL.test(u);
        });

        if (clientOnly) {
            dropped.add(id);
            warnings.push(
                `source '${id}' omitted: '${CLIENT_PROTOCOL.exec(clientOnly)![1]}://' is a browser-only `
                + 'protocol backed by the client\'s local database. The plugin must resolve it to '
                + 'concrete tile URLs before submitting the job.',
            );
            continue;
        }

        const denied = urls.filter((u) => {
            return classify(u, opts).kind === 'denied';
        });

        if (denied.length) {
            dropped.add(id);
            warnings.push(
                `source '${id}' omitted: host not on the allowlist (${classify(denied[0], opts).host})`
                + hint(opts),
            );
            continue;
        }

        if (typeof source.url === 'string') {
            const r = rewriteUrl(source.url, opts);
            source.url = r.kind === 'allowed' ? r.url : setToken(r.url, opts.token);
        }
        if (typeof source.data === 'string') {
            const r = rewriteUrl(source.data, opts);
            source.data = r.kind === 'allowed' ? r.url : setToken(r.url, opts.token);
        }
        if (Array.isArray(source.tiles)) {
            source.tiles = (source.tiles as string[]).map((u) => {
                const r = rewriteUrl(u, opts);
                return r.kind === 'allowed' ? r.url : setToken(r.url, opts.token);
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
