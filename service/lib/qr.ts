/**
 * The mission invite QR.
 *
 * CloudTAK's API renders it at GET /api/marti/missions/{guid}/qr as SVG, which is
 * the best possible input for print: it stays vector in the PDF, so the modules
 * have hard edges at any size and there is no resolution to get wrong.
 *
 * The plugin fetches it in the browser, where the session already has credentials,
 * and ships the markup in the job. That markup then gets embedded in a page this
 * service renders with a real browser -- so it is never echoed back out. Only the
 * viewBox and the path geometry are extracted, validated against a strict
 * character set, and re-emitted into markup this file builds. An <svg> carrying a
 * script, an event handler or an external reference cannot survive that, because
 * nothing but digits and path commands crosses the boundary.
 */

export type QrArt = {
    /** Module count across, INCLUDING the quiet zone. */
    modules: number;
    /** Path geometry, already validated. */
    paths: string[];
};

/** Path data: move/line/horizontal/vertical/close, numbers, separators. Nothing else. */
const SAFE_PATH = /^[MmLlHhVvZz0-9.,\s-]+$/;

const VIEWBOX = /viewBox\s*=\s*"\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*"/;
const PATH_D = /<path\b[^>]*?\bd\s*=\s*"([^"]*)"/g;

export function parseQr(svg: string): QrArt {
    const box = VIEWBOX.exec(svg);
    if (!box) throw new Error('QR SVG has no viewBox');

    const width = Number(box[1]);
    const height = Number(box[2]);

    if (!Number.isFinite(width) || width <= 0) throw new Error('QR SVG viewBox is not usable');

    // A QR is square by definition; anything else is not the thing we were handed.
    if (Math.abs(width - height) > 0.001) throw new Error('QR SVG viewBox is not square');

    const paths: string[] = [];

    PATH_D.lastIndex = 0;
    for (let match = PATH_D.exec(svg); match; match = PATH_D.exec(svg)) {
        const d = match[1].trim();
        if (!d) continue;

        if (!SAFE_PATH.test(d)) throw new Error('QR SVG path contains unexpected characters');

        paths.push(d);
    }

    if (!paths.length) throw new Error('QR SVG has no path data');

    return { modules: width, paths };
}

/**
 * Printed size, driven by how many modules have to fit.
 *
 * A phone camera needs roughly 0.5 mm per module off paper, and 0.6 mm to be
 * comfortable about it in the field. Sizing from the module count rather than
 * fixing an inch value means a short invite string takes a smaller bite out of the
 * map, and a long one still comes out scannable.
 */
export function qrInches(modules: number, opts: {
    mmPerModule?: number;
    min?: number;
    max?: number;
} = {}): number {
    const mmPerModule = opts.mmPerModule ?? 0.6;
    const min = opts.min ?? 0.9;
    const max = opts.max ?? 1.4;

    const wanted = (modules * mmPerModule) / 25.4;

    return Math.min(max, Math.max(min, Number(wanted.toFixed(3))));
}

/** Clean markup built here, from validated numbers and path data only. */
export function qrSvg(art: QrArt): string {
    const paths = art.paths.map((d) => {
        return `<path d="${d}" fill="#111"/>`;
    }).join('');

    return `<svg viewBox="0 0 ${art.modules} ${art.modules}" shape-rendering="crispEdges"`
        + ` xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
}
