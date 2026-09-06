import { serverUrl, getRuntimeToken } from '../../../src/std.ts';

/**
 * Client for the print service.
 *
 * The service lives behind Caddy at /print-api/* on the CloudTAK origin, so these
 * are same-origin requests and the Authorization header costs no preflight. That
 * matters: an earlier attempt put the token on cross-origin tile requests and the
 * resulting preflight broke every sprite fetch.
 *
 * The service verifies CloudTAK's own JWT against the shared SigningSecret, so the
 * user's session token is the credential -- there is nothing extra to mint.
 */

export type PaperOption = {
    id: string;
    label: string;
    width: number;
    height: number;
};

export type ScaleOption = {
    scale: number;
    /** UTM grid interval in metres that this scale prints. */
    grid: number;
};

export type PrintInfo = {
    name: string;
    version: string;
    concurrency: number;
    maxDpi: number;
    layoutDpi: number;
    maxTexture: number;
    hosts: {
        apiPublic: string | null;
        tilesPublic: string | null;
        apiInternal: string;
        tilesInternal: string;
        allow: string[];
    };
    paper: PaperOption[];
    margins: { top: number; right: number; bottom: number; left: number };
    gridGutter: number;
    scales: ScaleOption[];
};

export type SheetGeometry = {
    frameInches: { width: number; height: number };
    groundMetres: { width: number; height: number };
    dpi: number;
    layoutDpi: number;
    pixels: { width: number; height: number };
    clampedBy: 'none' | 'ceiling' | 'texture';
    scale: number;
    zoom: number;
};

export type JobStatus = {
    job: string;
    status: 'queued' | 'running' | 'complete' | 'failed';
    progress: number;
    step?: string;
    created: string;
    error?: string;
    sheet?: SheetGeometry;
    warnings?: string[];
};

export type PrintRequest = {
    title: string;
    incident?: string;
    author?: string;
    scale: number;
    paper: { size: string; orientation: 'portrait' | 'landscape' };
    center?: [number, number];
    dpi?: number;
    format?: 'pdf' | 'png';
    style?: Record<string, unknown>;
    images?: unknown[];
    furniture?: {
        grid?: 'utm' | 'none';
        legend?: boolean;
        declination?: boolean;
        branding?: string;
    };
};

/**
 * Where the print service lives.
 *
 * Defaults to the CloudTAK origin, because Caddy routes /print-api inside the
 * CloudTAK site block, so in a normal deployment there is nothing to configure.
 *
 * The override exists for two cases that produce the same symptom -- a 200 of
 * index.html rather than JSON. The vite dev server proxies /api and lets everything
 * else fall through to the SPA, and a deployment that has not installed the Caddy
 * snippet does the same thing. Setting this beats patching CloudTAK's vite config,
 * which is a tracked file and one more thing to carry across a core update:
 *
 *   localStorage.setItem('cloudtak-print-host', 'https://cloudtak.example.org')
 *
 * The token travels with the request, so the target has to verify against the same
 * SigningSecret as the CloudTAK this session is logged in to.
 */
function base(): string {
    try {
        const override = localStorage.getItem('cloudtak-print-host');
        if (override) return override.replace(/\/$/, '');
    } catch {
        // Storage can be unavailable; fall through to the origin.
    }

    return String(serverUrl).replace(/\/$/, '');
}

function url(path: string): string {
    return `${base()}${path}`;
}

async function headers(json: boolean): Promise<Record<string, string>> {
    const token = await getRuntimeToken();

    const head: Record<string, string> = {};
    if (json) head['Content-Type'] = 'application/json';
    if (token) head['Authorization'] = `Bearer ${token}`;

    return head;
}

/**
 * Errors from the service carry a useful message; a bare status code sends the
 * user to the container log for something the response already told us.
 */
async function describe(res: Response): Promise<string> {
    try {
        const body = await res.json() as { message?: string };
        return body.message ?? '';
    } catch {
        return await res.text().catch(() => '');
    }
}

async function fail(res: Response, target: string): Promise<never> {
    const detail = await describe(res);

    throw new Error(detail || `Print service returned ${res.status} for ${target}`);
}

/**
 * Parse a response that must be JSON.
 *
 * A dev server answering an unknown path with the SPA's index.html returns 200 with
 * HTML, which sails past res.ok and then dies inside JSON.parse with a message about
 * column 1 -- true, and completely useless. The likely cause is that nothing is
 * routing /print-api at this origin, so say that instead.
 */
async function readJson<T>(res: Response, target: string): Promise<T> {
    const type = res.headers.get('content-type') ?? '';

    if (!type.includes('json')) {
        const body = (await res.text().catch(() => '')).trim().slice(0, 120);
        const looksLikeHtml = body.startsWith('<');

        throw new Error(
            `${target} returned ${res.status} ${type || 'with no content type'} instead of JSON. `
            + (looksLikeHtml
                ? 'That is a web page, which means nothing is routing /print-api at this origin '
                    + '-- check the Caddy snippet, or that CloudTAK is pointed at a server where the '
                    + 'print service is deployed.'
                : `Body began: ${body}`),
        );
    }

    return await res.json() as T;
}

export async function info(): Promise<PrintInfo> {
    const target = url('/print-api');
    const res = await fetch(target, { headers: await headers(false) });
    if (!res.ok) await fail(res, target);

    return await readJson<PrintInfo>(res, target);
}

export async function submit(body: PrintRequest): Promise<JobStatus> {
    const target = url('/print-api/jobs');
    const res = await fetch(target, {
        method: 'POST',
        headers: await headers(true),
        body: JSON.stringify(body),
    });

    if (!res.ok) await fail(res, target);

    return await readJson<JobStatus>(res, target);
}

export async function status(job: string): Promise<JobStatus> {
    const target = url(`/print-api/jobs/${encodeURIComponent(job)}`);
    const res = await fetch(target, { headers: await headers(false) });

    if (!res.ok) await fail(res, target);

    return await readJson<JobStatus>(res, target);
}

export async function result(job: string): Promise<Blob> {
    const target = url(`/print-api/jobs/${encodeURIComponent(job)}/result`);
    const res = await fetch(target, { headers: await headers(false) });

    if (!res.ok) await fail(res, target);

    return await res.blob();
}

/**
 * Poll to completion.
 *
 * A 24x36 sheet at 200 DPI takes tens of seconds, so the interval is deliberately
 * unhurried; `onUpdate` is what keeps the panel honest in the meantime.
 */
export async function wait(job: string, opts: {
    onUpdate?: (status: JobStatus) => void;
    intervalMs?: number;
    timeoutMs?: number;
} = {}): Promise<JobStatus> {
    const interval = opts.intervalMs ?? 1500;
    const timeout = opts.timeoutMs ?? 15 * 60 * 1000;
    const deadline = Date.now() + timeout;

    for (;;) {
        const current = await status(job);
        if (opts.onUpdate) opts.onUpdate(current);

        if (current.status === 'complete' || current.status === 'failed') return current;

        if (Date.now() > deadline) {
            throw new Error(`Print job did not finish within ${Math.round(timeout / 60000)} minutes`);
        }

        await new Promise((resolve) => setTimeout(resolve, interval));
    }
}
