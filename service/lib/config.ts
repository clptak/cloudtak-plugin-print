/**
 * Environment configuration.
 *
 * Everything the print service depends on is a contract that travels: the shared
 * SigningSecret, an S3/MinIO bucket, and an internal tiles URL. Nothing here is
 * specific to a host, a domain, or a TAK Server, so moving this service to
 * another box or to GovCloud is an .env change and nothing else.
 */

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} env var must be provided`);
    return value;
}

/** Accept either a bare hostname or a full URL, and yield the hostname. */
function hostOf(value?: string): string | undefined {
    if (!value) return undefined;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value.replace(/:\d+$/, '');

    try {
        return new URL(value).hostname;
    } catch {
        return undefined;
    }
}

function int(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer, got: ${raw}`);
    return parsed;
}

export type Config = {
    port: number;
    /** Shared HS256 secret, same value CloudTAK's api/tiles/events use. */
    signingSecret: string;
    /** CloudTAK API, reached on the internal docker network. */
    apiUrl: string;
    /** Tile server, reached on the internal docker network. */
    tilesInternalUrl: string;
    /**
     * Public hosts as they appear in style documents, derived from CloudTAK's own
     * API_URL and PMTILES_URL. Deriving them rather than asking for them again
     * removes a whole class of misconfiguration: these are already correct in the
     * stack's .env, and a hand-written guess at the hostname silently turns every
     * internal rewrite into an allowlist rejection.
     */
    tilesPublicHost: string | undefined;
    apiPublicHost: string | undefined;
    /**
     * Third-party hosts the renderer may fetch basemap tiles from. Default empty:
     * a headless renderer that fetches arbitrary URLs from inside the docker
     * network is an SSRF engine, so external basemaps must be named explicitly.
     */
    allowHosts: string[];
    assetBucket: string;
    /** Concurrent render jobs. Deliberately 1 by default; see docs/DESIGN.md section 9. */
    concurrency: number;
    /** Render resolution ceiling. An env var because this box's resource budget will change. */
    maxDpi: number;
    /**
     * CSS pixels per inch used for LAYOUT. Label collision and symbol placement
     * happen in CSS-pixel space, so this controls printed label density,
     * independently of output resolution. Lower means sparser, more map-like
     * labelling. Tune empirically against real sheets.
     */
    layoutDpi: number;
    /**
     * GL MAX_TEXTURE_SIZE assumed when sizing a sheet. Measured at 8192 under
     * SwiftShader — half what real hardware reports. GET /print-api/smoke/webgl
     * reports the true value for a given box.
     */
    maxTexture: number;
    /** How long a finished job record is retained in memory. */
    jobTtlMs: number;
    /** How long a single render may take before it is abandoned. */
    renderTimeoutMs: number;
};

let cached: Config | undefined;

export default function config(): Config {
    if (cached) return cached;

    cached = {
        port: int('PRINT_PORT', 5010),
        signingSecret: required('SigningSecret'),
        apiUrl: process.env.API_INTERNAL_URL || 'http://cloudtak-api:5000',
        tilesInternalUrl: process.env.TILES_INTERNAL_URL || 'http://cloudtak-tiles:5002',
        tilesPublicHost: hostOf(process.env.TILES_PUBLIC_HOST || process.env.PMTILES_URL),
        apiPublicHost: hostOf(process.env.API_PUBLIC_HOST || process.env.API_URL),
        allowHosts: (process.env.PRINT_ALLOW_HOSTS || '')
            .split(',')
            .map((h) => {
                return h.trim();
            })
            .filter(Boolean),
        assetBucket: process.env.ASSET_BUCKET || '',
        concurrency: int('PRINT_CONCURRENCY', 1),
        maxDpi: int('PRINT_MAX_DPI', 200),
        layoutDpi: int('PRINT_LAYOUT_DPI', 96),
        maxTexture: int('PRINT_MAX_TEXTURE', 8192),
        jobTtlMs: int('PRINT_JOB_TTL_SECONDS', 3600) * 1000,
        renderTimeoutMs: int('PRINT_RENDER_TIMEOUT_SECONDS', 180) * 1000,
    };

    return cached;
}

/** Test hook — clears the memoised config so env changes take effect. */
export function resetConfig(): void {
    cached = undefined;
}
