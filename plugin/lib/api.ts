import { serverUrl, getRuntimeToken } from '../../src/std.ts';

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

function url(path: string): string {
    return `${String(serverUrl).replace(/\/$/, '')}${path}`;
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
async function fail(res: Response): Promise<never> {
    let detail = '';

    try {
        const body = await res.json() as { message?: string };
        detail = body.message ?? '';
    } catch {
        detail = await res.text().catch(() => '');
    }

    throw new Error(detail || `Print service returned ${res.status}`);
}

export async function info(): Promise<PrintInfo> {
    const res = await fetch(url('/print-api'), { headers: await headers(false) });
    if (!res.ok) await fail(res);

    return await res.json() as PrintInfo;
}

export async function submit(body: PrintRequest): Promise<JobStatus> {
    const res = await fetch(url('/print-api/jobs'), {
        method: 'POST',
        headers: await headers(true),
        body: JSON.stringify(body),
    });

    if (!res.ok) await fail(res);

    return await res.json() as JobStatus;
}

export async function status(job: string): Promise<JobStatus> {
    const res = await fetch(url(`/print-api/jobs/${encodeURIComponent(job)}`), {
        headers: await headers(false),
    });

    if (!res.ok) await fail(res);

    return await res.json() as JobStatus;
}

export async function result(job: string): Promise<Blob> {
    const res = await fetch(url(`/print-api/jobs/${encodeURIComponent(job)}/result`), {
        headers: await headers(false),
    });

    if (!res.ok) await fail(res);

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
