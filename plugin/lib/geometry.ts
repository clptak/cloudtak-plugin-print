/**
 * Sheet box geometry. Pure maths, no MapLibre, so it can be tested directly and
 * checked against the service's own footprint function -- see
 * service/test/sheetbox-geometry.test.ts.
 *
 * The important subtlety: the printed frame is a Web Mercator viewport, and Mercator
 * inflates ground distance by 1/cos(latitude). A box drawn by offsetting true ground
 * metres would be too small on the map by that factor -- roughly 22% at Coconino
 * County's latitude, and wrong in a way that still looks plausible.
 */

const R = 6378137;
const DEG = Math.PI / 180;
const M_PER_INCH = 0.0254;

export function mercatorX(lng: number): number {
    return R * lng * DEG;
}

export function mercatorY(lat: number): number {
    return R * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
}

export function lngFrom(x: number): number {
    return x / R / DEG;
}

export function latFrom(y: number): number {
    return (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / DEG;
}

export type Inches = { width: number; height: number };
export type Metres = { width: number; height: number };

/**
 * Ground footprint of a map frame at a given scale.
 *
 * Deliberately the same expression as footprint() in service/lib/paper.ts. The
 * plugin cannot import that module -- it ships inside CloudTAK's build, not the
 * service's -- so the two are held together by a test rather than by an import.
 */
export function groundFootprint(frameInches: Inches, scale: number): Metres {
    return {
        width: frameInches.width * scale * M_PER_INCH,
        height: frameInches.height * scale * M_PER_INCH,
    };
}

export type SheetBoxState = {
    center: [number, number];
    /** True ground footprint of the map frame, in metres. */
    groundMetres: Metres;
};

/**
 * The rectangle covering `groundMetres` on the ground, centred on `center`,
 * returned as a closed ring in [lng, lat] order starting north-west.
 *
 * Latitude for the Mercator inflation is taken at the centre, matching
 * zoomForScale() on the service, which makes the scale exact at the sheet centre.
 * The two have to agree on that choice or the box and the sheet disagree.
 */
export function corners(state: SheetBoxState): [number, number][] {
    const [lng, lat] = state.center;

    const inflation = 1 / Math.cos(lat * DEG);
    const halfWidth = (state.groundMetres.width * inflation) / 2;
    const halfHeight = (state.groundMetres.height * inflation) / 2;

    const x = mercatorX(lng);
    const y = mercatorY(lat);

    const west = lngFrom(x - halfWidth);
    const east = lngFrom(x + halfWidth);
    const south = latFrom(y - halfHeight);
    const north = latFrom(y + halfHeight);

    return [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
        [west, north],
    ];
}

/** [west, south, east, north], the order MapLibre's fitBounds takes. */
export function boundsOf(state: SheetBoxState): [number, number, number, number] {
    const ring = corners(state);
    return [ring[3][0], ring[3][1], ring[1][0], ring[1][1]];
}
