import type { Map } from 'maplibre-gl';
import { db } from '../../../src/database.ts';
import { std } from '../../../src/std.ts';

/**
 * Capture everything the render service needs that only exists in the browser.
 *
 * This is harvest-console.js promoted to a module. The console script stays in the
 * repo because it is still the fastest way to reproduce a render bug against a live
 * map without a CloudTAK build, but the plugin is the supported path and this is
 * where the logic now lives.
 *
 * Three things can only be done client-side:
 *
 *   1. `cloudtak-tilejson://<id>` overlay sources resolve through the client's Dexie
 *      database. The service has no equivalent and drops what it cannot resolve, so
 *      the tile URLs have to be resolved here.
 *   2. Most CoT icons are never in a sprite sheet -- CloudTAK resolves them lazily
 *      per id through a `styleimagemissing` handler -- so without harvesting the
 *      image pool the sheet prints with holes where the icons should be.
 *   3. The style has to be captured exactly as it currently is, including layer
 *      visibility, filters and any tweak the user has made. That is what makes the
 *      print match the screen, which is the whole promise of the feature.
 */

export type HarvestedImage = {
    id: string;
    width: number;
    height: number;
    /** Base64 RGBA, width * height * 4 bytes. */
    data: string;
    pixelRatio: number;
    sdf: boolean;
};

export type Harvest = {
    style: Record<string, unknown>;
    images: HarvestedImage[];
    /** Overlay sources whose tile URLs were resolved off the live map. */
    resolved: string[];
    /**
     * Overlay sources still on a browser-only protocol. These will be dropped by the
     * service, so the panel surfaces them rather than printing a sheet with a
     * silently missing overlay.
     */
    unresolved: string[];
    /** Images in the pool that could not be read back. */
    skipped: number;
    /** Images in the pool that no layer references, and so were not sent. */
    omitted: number;
    /** Serialised payload size in bytes, for the panel to warn on. */
    bytes: number;
};

/** A MapLibre image entry, whose concrete shape varies by how it was added. */
type ImageLike = {
    width?: number;
    height?: number;
    data?: Uint8Array | Uint8ClampedArray;
    userImage?: unknown;
    pixelRatio?: number;
    sdf?: boolean;
};

function toBase64(bytes: Uint8Array): string {
    let binary = '';

    // String.fromCharCode is applied in chunks because spreading a few hundred
    // thousand bytes into one call overflows the argument limit.
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }

    return btoa(binary);
}

const TILEJSON_SOURCE = /^cloudtak-tilejson:\/\/(-?\d+)\/?$/;

type TileJson = {
    tiles?: string[];
    minzoom?: number;
    maxzoom?: number;
    bounds?: number[];
    attribution?: string;
};

/**
 * Resolve one overlay the way CloudTAK's own protocol handler does: from the
 * overlay record, falling back to the network when no TileJSON is cached yet.
 * See api/web/src/stores/modules/tilejson.ts.
 *
 * Deliberately NOT read off the live MapLibre source. A source only carries
 * resolved tiles once MapLibre has actually fetched its TileJSON, and MapLibre
 * only does that when the layer is in range -- so an overlay whose layers start at
 * minzoom 14 is unresolved at screen zoom 10, gets dropped, and silently vanishes
 * from the printed sheet. Zoom in and it prints. The overlay record does not care
 * where the map is looking.
 *
 * The tile URLs come back unauthorized; the service stamps its own token onto them
 * (setToken in service/lib/style.ts), so there is no need to reproduce CloudTAK's
 * authorizeTileJSON here.
 */
async function tileJsonFor(id: number): Promise<TileJson | null> {
    const record = await db.overlay.get(id) as { url?: string; tilejson?: TileJson } | undefined;
    if (!record) return null;

    if (record.tilejson) return record.tilejson;
    if (!record.url) return null;

    return await std(record.url) as TileJson;
}

/**
 * Resolve browser-only source protocols to concrete tile URLs, in place.
 */
async function resolveSources(map: Map, style: Record<string, unknown>) {
    const resolved: string[] = [];
    const unresolved: string[] = [];

    const sources = (style.sources ?? {}) as Record<string, Record<string, unknown>>;

    for (const [id, source] of Object.entries(sources)) {
        const url = source.url;
        if (typeof url !== 'string' || !url.startsWith('cloudtak-')) continue;

        const overlay = TILEJSON_SOURCE.exec(url);

        // The overlay record first, because it is independent of where the map is
        // looking; the live source only as a fallback for other cloudtak-*
        // protocols, or an overlay missing from the local database.
        let resolvedTiles: string[] | null = null;
        let meta: TileJson | null = null;

        if (overlay) {
            try {
                meta = await tileJsonFor(Number(overlay[1]));
                if (meta && Array.isArray(meta.tiles) && meta.tiles.length) {
                    resolvedTiles = meta.tiles;
                }
            } catch {
                // Fall through to the live source.
            }
        }

        const live = map.getSource(id) as unknown as Record<string, unknown> | undefined;

        if (!resolvedTiles && live && Array.isArray(live.tiles) && live.tiles.length) {
            resolvedTiles = live.tiles as string[];
        }

        if (!resolvedTiles) {
            unresolved.push(`${id} (${url})`);
            continue;
        }

        const tiles = resolvedTiles;

        delete source.url;
        source.tiles = tiles;

        /*
         * Copy only what the style spec allows for THIS source type. Blindly copying
         * every property off the live source produces a style MapLibre rejects
         * outright -- `scheme` is valid on vector and raster sources but not on
         * raster-dem, and one bad property fails the whole render. That cost a
         * round trip to the VPS to find.
         */
        const minzoom = meta?.minzoom ?? live?.minzoom;
        const maxzoom = meta?.maxzoom ?? live?.maxzoom;
        const bounds = meta?.bounds ?? live?.bounds;
        const attribution = meta?.attribution ?? live?.attribution;

        if (minzoom != null) source.minzoom = minzoom;
        if (maxzoom != null) source.maxzoom = maxzoom;
        if (bounds) source.bounds = bounds;
        if (attribution) source.attribution = attribution;

        if (source.type === 'vector' || source.type === 'raster') {
            // 'xyz' is the default, so only a non-default value is worth carrying.
            if (live?.scheme === 'tms') source.scheme = 'tms';
        }
        if (source.type === 'raster' || source.type === 'raster-dem') {
            if (live?.tileSize) source.tileSize = live.tileSize;
        }
        if (source.type === 'raster-dem' && live?.encoding) {
            source.encoding = live.encoding;
        }

        resolved.push(`${id} (${String(source.type)})`);
    }

    return { resolved, unresolved };
}

/**
 * Harvest the image pool, restricted to what the style actually references.
 *
 * A live CloudTAK map holds every icon it has ever resolved, and taking all of them
 * produced an 18 MB payload for a sheet that used a few dozen. Matching against the
 * serialised layers catches ids used as literals anywhere in an expression; an id
 * assembled at runtime cannot be found this way, which is what `omitted` reports.
 */
function harvestImages(map: Map, style: Record<string, unknown>) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const layerText = JSON.stringify(style.layers ?? []);
    const all = map.listImages();
    const referenced = all.filter((id) => {
        return layerText.includes(JSON.stringify(id));
    });

    // If nothing matched, the match heuristic is the suspect rather than the style,
    // so send the whole pool instead of printing a sheet with no icons at all.
    const wanted = referenced.length ? referenced : all;

    const images: HarvestedImage[] = [];
    let skipped = 0;

    for (const id of wanted) {
        const image = map.getImage(id) as unknown as ImageLike | undefined;
        if (!image) { skipped++; continue; }

        // MapLibre hands back either an RGBAImage-like object or a bitmap.
        const src = (image.data ? image : (image.userImage ?? image)) as ImageLike;

        let width = src.width;
        let height = src.height;
        let data: Uint8Array | Uint8ClampedArray | undefined = src.data;

        if (!data && ctx && (src instanceof ImageBitmap || src instanceof HTMLImageElement)) {
            canvas.width = width = src.width;
            canvas.height = height = src.height;
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(src, 0, 0);
            data = ctx.getImageData(0, 0, width, height).data;
        }

        if (!data || !width || !height) { skipped++; continue; }

        images.push({
            id,
            width,
            height,
            data: toBase64(new Uint8Array(data.buffer ?? data)),
            pixelRatio: image.pixelRatio ?? 1,
            sdf: !!image.sdf,
        });
    }

    return {
        images,
        skipped,
        omitted: referenced.length ? all.length - referenced.length : 0,
    };
}

export async function harvest(map: Map): Promise<Harvest> {
    // A deep clone, because resolveSources rewrites sources in place and the live
    // style object is the one the user is looking at.
    const style = JSON.parse(JSON.stringify(map.getStyle())) as Record<string, unknown>;

    const { resolved, unresolved } = await resolveSources(map, style);
    const { images, skipped, omitted } = harvestImages(map, style);

    return {
        style,
        images,
        resolved,
        unresolved,
        skipped,
        omitted,
        // Measured rather than estimated: the panel warns above a threshold, and a
        // guess would either nag on every print or miss the one that matters.
        bytes: JSON.stringify({ style, images }).length,
    };
}
