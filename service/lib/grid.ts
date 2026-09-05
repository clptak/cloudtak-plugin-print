import { gridLines, labelParts, type BBox, type GridLine } from './utm.js';

/**
 * Draw the UTM grid onto the sheet as SVG.
 *
 * SVG rather than pixels: the grid then survives into the PDF as vector line work
 * and vector text, so it stays sharp at any print resolution and is unaffected by
 * the map raster being capped at 150 or 200 dpi.
 *
 * The lines arrive from lib/utm.ts as polylines in geographic coordinates,
 * because constant easting is a curve on a Web Mercator page. Here they are
 * projected vertex by vertex with the same transform MapLibre used, so the grid
 * registers exactly with the map beneath it.
 */

export type Viewport = {
    center: [number, number];
    zoom: number;
    /** Map frame size in CSS pixels — the same figures the map was rendered at. */
    width: number;
    height: number;
};

/** Web Mercator world coordinates in CSS pixels, MapLibre's 512px-at-zoom-0 convention. */
export function mercator(longitude: number, latitude: number, zoom: number): { x: number; y: number } {
    const world = 512 * 2 ** zoom;
    const lat = Math.max(-85.051129, Math.min(85.051129, latitude));
    const phi = (lat * Math.PI) / 180;

    return {
        x: ((longitude + 180) / 360) * world,
        y: (0.5 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / (2 * Math.PI)) * world,
    };
}

/** A projector from geographic coordinates to pixel positions inside the map frame. */
export function projector(view: Viewport): (lon: number, lat: number) => [number, number] {
    const origin = mercator(view.center[0], view.center[1], view.zoom);

    return (lon, lat) => {
        const p = mercator(lon, lat, view.zoom);
        return [p.x - origin.x + view.width / 2, p.y - origin.y + view.height / 2];
    };
}

/** Geographic bounds of the frame, with a margin so lines are generated past the edges. */
export function viewportBBox(view: Viewport, pad = 0.08): BBox {
    const world = 512 * 2 ** view.zoom;
    const origin = mercator(view.center[0], view.center[1], view.zoom);

    const unproject = (px: number, py: number): [number, number] => {
        const x = origin.x + px - view.width / 2;
        const y = origin.y + py - view.height / 2;
        const lon = (x / world) * 360 - 180;
        const n = Math.PI - (2 * Math.PI * y) / world;
        const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
        return [lon, lat];
    };

    const dx = view.width * pad;
    const dy = view.height * pad;

    const [west, north] = unproject(-dx, -dy);
    const [east, south] = unproject(view.width + dx, view.height + dy);

    return [west, south, east, north];
}

type Point = [number, number];

/**
 * Clip a polyline to the frame, returning the pieces inside it.
 *
 * Lines are generated beyond the frame so they reach its edges cleanly; without
 * clipping they would overhang into the margins and collide with the labels.
 */
export function clipToFrame(points: Point[], width: number, height: number): Point[][] {
    const inside = (p: Point) => {
        return p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height;
    };

    const pieces: Point[][] = [];
    let current: Point[] = [];

    for (let i = 0; i < points.length; i++) {
        const p = points[i];

        if (inside(p)) {
            // Carry one point from outside so the run reaches the border rather
            // than stopping at the last sampled vertex within it.
            if (!current.length && i > 0) current.push(points[i - 1]);
            current.push(p);
        } else if (current.length) {
            current.push(p);
            pieces.push(current);
            current = [];
        }
    }

    if (current.length > 1) pieces.push(current);

    return pieces;
}

/** Where a polyline crosses each frame edge, for placing edge labels. */
function edgeCrossings(points: Point[], width: number, height: number): {
    left?: number; right?: number; top?: number; bottom?: number;
} {
    const out: { left?: number; right?: number; top?: number; bottom?: number } = {};

    for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1];
        const [x1, y1] = points[i];

        const at = (t: number): Point => {
            return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
        };

        if ((x0 < 0) !== (x1 < 0) && x1 !== x0) {
            const p = at((0 - x0) / (x1 - x0));
            if (p[1] >= 0 && p[1] <= height) out.left = p[1];
        }
        if ((x0 > width) !== (x1 > width) && x1 !== x0) {
            const p = at((width - x0) / (x1 - x0));
            if (p[1] >= 0 && p[1] <= height) out.right = p[1];
        }
        if ((y0 < 0) !== (y1 < 0) && y1 !== y0) {
            const p = at((0 - y0) / (y1 - y0));
            if (p[0] >= 0 && p[0] <= width) out.top = p[0];
        }
        if ((y0 > height) !== (y1 > height) && y1 !== y0) {
            const p = at((height - y0) / (y1 - y0));
            if (p[0] >= 0 && p[0] <= width) out.bottom = p[0];
        }
    }

    return out;
}

const path = (piece: Point[]): string => {
    return piece.map((p, i) => {
        return `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    }).join(' ');
};

export type GridOptions = {
    view: Viewport;
    zone: number;
    interval: number;
    /** CSS pixels per inch, so line weights and type can be set in real units. */
    layoutDpi: number;
    /** Grid line weight in millimetres. */
    lineMm?: number;
    colour?: string;
};

/**
 * Render the grid as an SVG overlay sized to the map frame.
 *
 * Labels go INSIDE the neatline with a white halo rather than out in the margin:
 * they always fit, they stay next to the line they belong to, and the margin
 * stays free for the title block and, later, the scale bar and north arrow.
 */
export function gridSvg(opts: GridOptions): { svg: string; lines: number; zone: number } {
    const { view, zone, interval, layoutDpi } = opts;
    const colour = opts.colour ?? '#1b5e9c';
    const mm = (v: number) => {
        return (v / 25.4) * layoutDpi;
    };

    const project = projector(view);
    const lines = gridLines({ bbox: viewportBBox(view), zone, interval });

    const strokes: string[] = [];
    const labels: string[] = [];

    const fontPx = mm(2.6);
    const smallPx = mm(1.7);

    const label = (x: number, y: number, value: number, anchor: string, rotate?: number) => {
        const parts = labelParts(value, interval);
        const transform = rotate ? ` transform="rotate(${rotate} ${x.toFixed(1)} ${y.toFixed(1)})"` : '';

        // Principal digits large, the rest small — what a field team reads aloud.
        return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}"${transform}`
            + ` font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif"`
            + ` paint-order="stroke" stroke="#fff" stroke-width="${mm(0.7).toFixed(2)}" stroke-linejoin="round">`
            + `<tspan font-size="${smallPx.toFixed(1)}" fill="${colour}">${parts.prefix}</tspan>`
            + `<tspan font-size="${fontPx.toFixed(1)}" font-weight="700" fill="${colour}">${parts.principal}</tspan>`
            + `<tspan font-size="${smallPx.toFixed(1)}" fill="${colour}">${parts.suffix}</tspan>`
            + `</text>`;
    };

    for (const line of lines as GridLine[]) {
        const projected = line.points.map(([lon, lat]) => {
            return project(lon, lat);
        }) as Point[];

        for (const piece of clipToFrame(projected, view.width, view.height)) {
            strokes.push(`<path d="${path(piece)}"/>`);
        }

        const cross = edgeCrossings(projected, view.width, view.height);
        const inset = mm(2.2);

        if (line.kind === 'easting') {
            if (cross.top !== undefined) labels.push(label(cross.top, inset + fontPx, line.value, 'middle'));
            if (cross.bottom !== undefined) labels.push(label(cross.bottom, view.height - inset, line.value, 'middle'));
        } else {
            if (cross.left !== undefined) labels.push(label(inset, cross.left - inset, line.value, 'start'));
            if (cross.right !== undefined) labels.push(label(view.width - inset, cross.right - inset, line.value, 'end'));
        }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}"`
        + ` viewBox="0 0 ${view.width} ${view.height}">`
        + `<g fill="none" stroke="${colour}" stroke-width="${mm(opts.lineMm ?? 0.25).toFixed(2)}"`
        + ` stroke-opacity="0.75" stroke-linecap="butt">${strokes.join('')}</g>`
        + labels.join('')
        + `</svg>`;

    return { svg, lines: lines.length, zone };
}
