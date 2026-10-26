import { gridLines, labelParts, toUTM, squareId, bandFor, type BBox, type GridLine } from './utm.js';

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

/**
 * Path data in SHEET coordinates.
 *
 * The offset is baked into the coordinates rather than applied with a transform
 * on the group. A `clip-path` is resolved in the user space established by the
 * element's own transform, so a clipped-and-translated group has its clip
 * rectangle shifted by the same offset — which let grid lines escape past the
 * right and bottom neatlines and run through the margin labels.
 */
const path = (piece: Point[], ox: number, oy: number): string => {
    return piece.map((p, i) => {
        return `${i ? 'L' : 'M'}${(p[0] + ox).toFixed(1)} ${(p[1] + oy).toFixed(1)}`;
    }).join(' ');
};

export type GridOptions = {
    view: Viewport;
    zone: number;
    interval: number;
    /** CSS pixels per inch, so line weights and type can be set in real units. */
    layoutDpi: number;
    /** Full sheet size in inches — the SVG spans the sheet so labels can sit in the margin. */
    sheet: { width: number; height: number };
    /** Top-left of the map frame within the sheet, in inches. */
    frameOrigin: { x: number; y: number };
    /** Grid line weight in millimetres. */
    lineMm?: number;
    colour?: string;
    /**
     * How the lines are labelled. The lines themselves are identical: a USNG
     * grid IS the UTM grid. USNG labels each line with only its digits inside
     * the 100 km square, draws the 100 km boundaries heavier, and marks the
     * square IDs in the map when the sheet spans more than one.
     */
    system?: 'utm' | 'usng';
};

/** The digits a USNG reader writes for a line: its position inside the 100 km square. */
export function usngDigits(value: number, interval: number): string {
    const digits = 5 - Math.round(Math.log10(interval));
    if (digits <= 0) return '';

    return String(Math.floor((value % 100000) / interval)).padStart(digits, '0');
}

export type SquareLabel = { label: string; x: number; y: number };

/**
 * Where to print 100 km square IDs inside the map, if anywhere.
 *
 * Nothing when the sheet sits inside one square -- the title strip names it.
 * When a 100 km line crosses the sheet the square ID CHANGES across it, and a
 * reader on the wrong side would write the wrong reference, so every region
 * gets labelled, at the middle of the part of it the sheet shows.
 *
 * A sheet that also straddles a latitude band boundary (32 N runs through
 * Tucson) gets the grid zone designator on each label too: the square letters
 * do not change across a band boundary, so the square ID alone would hide that
 * the designator did.
 *
 * Regions are found by sampling, which is safe because each is the
 * intersection of two near-rectangles and so convex: its sample centroid lies
 * inside it.
 */
export function squareLabels(view: Viewport, zone: number, steps = 24): SquareLabel[] {
    const [west, south, east, north] = viewportBBox(view, 0);
    const project = projector(view);

    const groups = new Map<string, { gzd: string; square: string; xs: number[]; ys: number[] }>();

    for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps; j++) {
            const lon = west + ((east - west) * i) / steps;
            const lat = south + ((north - south) * j) / steps;
            const u = toUTM(lon, lat, zone);
            const gzd = `${zone}${bandFor(lat)}`;
            const square = squareId(zone, u.easting, u.northing);
            const key = `${gzd} ${square}`;
            const [x, y] = project(lon, lat);

            if (!groups.has(key)) groups.set(key, { gzd, square, xs: [], ys: [] });
            groups.get(key)!.xs.push(x);
            groups.get(key)!.ys.push(y);
        }
    }

    if (groups.size < 2) return [];

    const bands = new Set([...groups.values()].map((g) => {
        return g.gzd;
    }));

    return [...groups.values()].map((g) => {
        return {
            label: bands.size > 1 ? `${g.gzd} ${g.square}` : g.square,
            x: g.xs.reduce((a, b) => a + b, 0) / g.xs.length,
            y: g.ys.reduce((a, b) => a + b, 0) / g.ys.length,
        };
    });
}

/**
 * Render the grid as an SVG overlay spanning the whole sheet.
 *
 * The SVG covers the sheet rather than just the map frame so that labels can sit
 * OUTSIDE the neatline, in the margin, which is the printed convention and far
 * easier to read than labels competing with the map behind them. Lines are
 * clipped to the frame; only the labels and their ticks reach into the margin.
 *
 * Side labels are rotated to read bottom-to-top, as on a USGS quad: a full grid
 * reference is wider than a half-inch margin, and rotating is what a printed map
 * does rather than shrinking the type.
 */
export function gridSvg(opts: GridOptions): { svg: string; lines: number; zone: number } {
    const { view, zone, interval, layoutDpi } = opts;
    const colour = opts.colour ?? '#1b5e9c';
    const mm = (v: number) => {
        return (v / 25.4) * layoutDpi;
    };

    const sheetW = opts.sheet.width * layoutDpi;
    const sheetH = opts.sheet.height * layoutDpi;
    const ox = opts.frameOrigin.x * layoutDpi;
    const oy = opts.frameOrigin.y * layoutDpi;

    const project = projector(view);
    const lines = gridLines({ bbox: viewportBBox(view), zone, interval });

    const strokes: string[] = [];
    const heavy: string[] = [];
    const ticks: string[] = [];
    const labels: string[] = [];

    const principalPx = mm(3.0);
    const smallPx = mm(1.9);
    const gap = mm(1.6);
    const tick = mm(2.0);

    const system = opts.system ?? 'utm';

    const label = (x: number, y: number, value: number, anchor: string, rotate = 0) => {
        const at = `${x.toFixed(1)} ${y.toFixed(1)}`;
        const transform = rotate ? ` transform="rotate(${rotate} ${at})"` : '';
        const open = `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}"${transform}`
            + ` font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" fill="${colour}">`;

        // USNG: only the digits inside the 100 km square, all of them principal.
        // That is what the reader writes; the rest of the reference is in the
        // title strip, or marked on the map where it changes.
        if (system === 'usng') {
            const digits = usngDigits(value, interval);
            if (!digits) return '';

            return open
                + `<tspan font-size="${principalPx.toFixed(1)}" font-weight="700">${digits}</tspan>`
                + `</text>`;
        }

        const parts = labelParts(value, interval);

        return open
            + `<tspan font-size="${smallPx.toFixed(1)}">${parts.prefix}</tspan>`
            + `<tspan font-size="${principalPx.toFixed(1)}" font-weight="700">${parts.principal}</tspan>`
            + `<tspan font-size="${smallPx.toFixed(1)}">${parts.suffix}</tspan>`
            + `</text>`;
    };

    const tickMark = (x1: number, y1: number, x2: number, y2: number) => {
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    };

    for (const line of lines as GridLine[]) {
        const projected = line.points.map(([lon, lat]) => {
            return project(lon, lat);
        }) as Point[];

        // USNG 100 km boundaries print heavier: the square ID changes across
        // them, and they are what the in-map square labels sit either side of.
        const boundary = system === 'usng' && Math.round(line.value) % 100000 === 0;

        for (const piece of clipToFrame(projected, view.width, view.height)) {
            (boundary ? heavy : strokes).push(`<path d="${path(piece, ox, oy)}"/>`);
        }

        const cross = edgeCrossings(projected, view.width, view.height);

        if (line.kind === 'easting') {
            if (cross.top !== undefined) {
                const x = ox + cross.top;
                ticks.push(tickMark(x, oy, x, oy - tick));
                labels.push(label(x, oy - tick - gap, line.value, 'middle'));
            }
            if (cross.bottom !== undefined) {
                const x = ox + cross.bottom;
                const y = oy + view.height;
                ticks.push(tickMark(x, y, x, y + tick));
                // Mirrors the top: the same tick, the same gap, then the cap
                // height so the type sits off the neatline by the same amount.
                labels.push(label(x, y + tick + gap + principalPx * 0.72, line.value, 'middle'));
            }
        } else {
            if (cross.left !== undefined) {
                const y = oy + cross.left;
                ticks.push(tickMark(ox, y, ox - tick, y));
                labels.push(label(ox - tick - gap, y, line.value, 'middle', -90));
            }
            if (cross.right !== undefined) {
                const y = oy + cross.right;
                const x = ox + view.width;
                ticks.push(tickMark(x, y, x + tick, y));
                labels.push(label(x + tick + gap + principalPx * 0.8, y, line.value, 'middle', -90));
            }
        }
    }

    const weight = mm(opts.lineMm ?? 0.25).toFixed(2);
    const heavyWeight = mm((opts.lineMm ?? 0.25) * 2.4).toFixed(2);

    // Square IDs inside the map, with the same halo the edge labels would need
    // if they sat over terrain -- these always do.
    const squares = system === 'usng'
        ? squareLabels(view, zone).map((q) => {
                return `<text x="${(ox + q.x).toFixed(1)}" y="${(oy + q.y).toFixed(1)}" text-anchor="middle"`
                    + ` dominant-baseline="central" font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif"`
                    + ` font-size="${mm(6).toFixed(1)}" font-weight="700" fill="${colour}" fill-opacity="0.85"`
                    + ` stroke="#ffffff" stroke-width="${mm(0.8).toFixed(2)}" stroke-opacity="0.9"`
                    + ` paint-order="stroke" stroke-linejoin="round">${q.label}</text>`;
            })
        : [];

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="grid" width="${sheetW}" height="${sheetH}"`
        + ` viewBox="0 0 ${sheetW} ${sheetH}">`
        + `<defs><clipPath id="frame">`
        + `<rect x="${ox}" y="${oy}" width="${view.width}" height="${view.height}"/>`
        + `</clipPath></defs>`
        + `<g clip-path="url(#frame)"`
        + ` fill="none" stroke="${colour}" stroke-width="${weight}"`
        + ` stroke-opacity="0.75" stroke-linecap="butt">${strokes.join('')}</g>`
        + (heavy.length
            ? `<g clip-path="url(#frame)" fill="none" stroke="${colour}" stroke-width="${heavyWeight}"`
            + ` stroke-opacity="0.85" stroke-linecap="butt">${heavy.join('')}</g>`
            : '')
        + `<g clip-path="url(#frame)">${squares.join('')}</g>`
        + `<g fill="none" stroke="${colour}" stroke-width="${weight}">${ticks.join('')}</g>`
        + labels.join('')
        + `</svg>`;

    return { svg, lines: lines.length, zone };
}
