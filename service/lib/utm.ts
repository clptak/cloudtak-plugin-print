/**
 * UTM for map sheets.
 *
 * The page is Web Mercator; the grid is UTM. They are different projections, so
 * a line of constant easting is NOT a straight vertical line on the sheet — it
 * bows, slightly near the zone's central meridian and more toward the zone edges.
 * Grid lines therefore have to be generated as a series of points in geographic
 * coordinates and projected individually, never drawn as straight rules.
 *
 * Formulas are the standard Transverse Mercator series (Snyder, USGS PP1395) on
 * WGS 84, accurate to a few millimetres within a zone — far beyond what anyone
 * can measure off paper.
 */

const A = 6378137.0; // WGS84 semi-major axis, metres
const F = 1 / 298.257223563; // flattening
const K0 = 0.9996; // UTM scale factor on the central meridian
const E2 = F * (2 - F); // first eccentricity squared
const EP2 = E2 / (1 - E2); // second eccentricity squared
const FALSE_EASTING = 500000;
const FALSE_NORTHING = 10000000; // southern hemisphere only

const rad = (d: number): number => {
    return (d * Math.PI) / 180;
};
const deg = (r: number): number => {
    return (r * 180) / Math.PI;
};

export type UTM = {
    zone: number;
    /** MGRS latitude band letter, C through X. */
    band: string;
    easting: number;
    northing: number;
    northern: boolean;
};

/**
 * UTM zone for a position, including the two irregularities in the system.
 *
 * South-west Norway widens zone 32, and Svalbard rearranges zones 31-37. Neither
 * applies in Arizona, but a grid engine that silently gets them wrong is a trap
 * for whoever uses this somewhere else.
 */
export function zoneFor(longitude: number, latitude: number): number {
    const lon = ((longitude + 180) % 360 + 360) % 360 - 180;
    let zone = Math.floor((lon + 180) / 6) + 1;

    if (latitude >= 56 && latitude < 64 && lon >= 3 && lon < 12) zone = 32;

    if (latitude >= 72 && latitude < 84) {
        if (lon >= 0 && lon < 9) zone = 31;
        else if (lon >= 9 && lon < 21) zone = 33;
        else if (lon >= 21 && lon < 33) zone = 35;
        else if (lon >= 33 && lon < 42) zone = 37;
    }

    return zone;
}

const BANDS = 'CDEFGHJKLMNPQRSTUVWX';

/** MGRS latitude band letter. 'I' and 'O' are skipped; X is 12 degrees tall. */
export function bandFor(latitude: number): string {
    if (latitude < -80 || latitude > 84) return 'Z';
    if (latitude >= 72) return 'X';

    return BANDS[Math.floor((latitude + 80) / 8)];
}

/** Central meridian of a zone, in degrees. */
export function centralMeridian(zone: number): number {
    return (zone - 1) * 6 - 180 + 3;
}

/** Meridional arc length from the equator. */
function meridianArc(phi: number): number {
    return A * (
        (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256) * phi
        - ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi)
        + ((15 * E2 * E2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi)
        - ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi)
    );
}

/** Geographic to UTM. `zone` forces a zone, for sheets that must not split. */
export function toUTM(longitude: number, latitude: number, zone?: number): UTM {
    const z = zone ?? zoneFor(longitude, latitude);
    const phi = rad(latitude);
    const lambda = rad(longitude);
    const lambda0 = rad(centralMeridian(z));

    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const tanPhi = Math.tan(phi);

    const N = A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
    const T = tanPhi * tanPhi;
    const C = EP2 * cosPhi * cosPhi;

    // Normalised so a sheet may straddle the antimeridian without exploding.
    let dl = lambda - lambda0;
    while (dl > Math.PI) dl -= 2 * Math.PI;
    while (dl < -Math.PI) dl += 2 * Math.PI;

    const a1 = dl * cosPhi;
    const M = meridianArc(phi);

    const easting = K0 * N * (
        a1
        + ((1 - T + C) * a1 ** 3) / 6
        + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * a1 ** 5) / 120
    ) + FALSE_EASTING;

    let northing = K0 * (M + N * tanPhi * (
        (a1 * a1) / 2
        + ((5 - T + 9 * C + 4 * C * C) * a1 ** 4) / 24
        + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * a1 ** 6) / 720
    ));

    const northern = latitude >= 0;
    if (!northern) northing += FALSE_NORTHING;

    return { zone: z, band: bandFor(latitude), easting, northing, northern };
}

/** UTM to geographic. */
export function fromUTM(
    easting: number,
    northing: number,
    zone: number,
    northern = true,
): { longitude: number; latitude: number } {
    const x = easting - FALSE_EASTING;
    const y = northern ? northing : northing - FALSE_NORTHING;

    const M = y / K0;
    const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));

    const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));

    const phi1 = mu
        + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
        + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
        + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
        + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

    const sinPhi1 = Math.sin(phi1);
    const cosPhi1 = Math.cos(phi1);
    const tanPhi1 = Math.tan(phi1);

    const C1 = EP2 * cosPhi1 * cosPhi1;
    const T1 = tanPhi1 * tanPhi1;
    const N1 = A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1);
    const R1 = (A * (1 - E2)) / (1 - E2 * sinPhi1 * sinPhi1) ** 1.5;
    const D = x / (N1 * K0);

    const latitude = deg(phi1 - ((N1 * tanPhi1) / R1) * (
        (D * D) / 2
        - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24
        + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720
    ));

    const longitude = centralMeridian(zone) + deg((
        D
        - ((1 + 2 * T1 + C1) * D ** 3) / 6
        + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120
    ) / cosPhi1);

    return { longitude, latitude };
}

export type BBox = [number, number, number, number];

/**
 * UTM extent of a geographic bounding box, in one zone.
 *
 * The corners alone are not enough: because the projection curves, the extreme
 * easting or northing can fall on an edge between corners. Edges are sampled.
 */
export function utmBounds(bbox: BBox, zone: number, samples = 16): {
    minEasting: number; maxEasting: number; minNorthing: number; maxNorthing: number; northern: boolean;
} {
    const [west, south, east, north] = bbox;
    const northern = (south + north) / 2 >= 0;

    let minEasting = Infinity, maxEasting = -Infinity;
    let minNorthing = Infinity, maxNorthing = -Infinity;

    const consider = (lon: number, lat: number) => {
        const p = toUTM(lon, lat, zone);
        minEasting = Math.min(minEasting, p.easting);
        maxEasting = Math.max(maxEasting, p.easting);
        minNorthing = Math.min(minNorthing, p.northing);
        maxNorthing = Math.max(maxNorthing, p.northing);
    };

    for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        consider(west + (east - west) * t, south);
        consider(west + (east - west) * t, north);
        consider(west, south + (north - south) * t);
        consider(east, south + (north - south) * t);
    }

    return { minEasting, maxEasting, minNorthing, maxNorthing, northern };
}

export type GridLine = {
    kind: 'easting' | 'northing';
    /** The UTM coordinate this line holds constant, in metres. */
    value: number;
    /** Geographic vertices, to be projected individually onto the page. */
    points: Array<[number, number]>;
};

/**
 * Generate the grid lines crossing a bounding box.
 *
 * Each line is emitted as a polyline in geographic coordinates. Straight lines
 * would be wrong: constant easting is a curve on a Web Mercator page, and
 * visibly so away from the central meridian.
 */
export function gridLines(opts: {
    bbox: BBox;
    zone: number;
    interval: number;
    samples?: number;
}): GridLine[] {
    const { bbox, zone, interval } = opts;
    const samples = opts.samples ?? 24;

    const b = utmBounds(bbox, zone);
    const lines: GridLine[] = [];

    const first = (min: number) => {
        return Math.ceil(min / interval) * interval;
    };

    for (let e = first(b.minEasting); e <= b.maxEasting; e += interval) {
        const points: Array<[number, number]> = [];
        for (let i = 0; i <= samples; i++) {
            const n = b.minNorthing + ((b.maxNorthing - b.minNorthing) * i) / samples;
            const { longitude, latitude } = fromUTM(e, n, zone, b.northern);
            points.push([longitude, latitude]);
        }
        lines.push({ kind: 'easting', value: e, points });
    }

    for (let n = first(b.minNorthing); n <= b.maxNorthing; n += interval) {
        const points: Array<[number, number]> = [];
        for (let i = 0; i <= samples; i++) {
            const e = b.minEasting + ((b.maxEasting - b.minEasting) * i) / samples;
            const { longitude, latitude } = fromUTM(e, n, zone, b.northern);
            points.push([longitude, latitude]);
        }
        lines.push({ kind: 'northing', value: n, points });
    }

    return lines;
}

/**
 * Split a grid value into the parts a printed map labels differently.
 *
 * Convention is a full reference at the sheet corners and principal digits along
 * the edges, so `439000` at a 1000 m interval reads as a small `4`, a large
 * `39`, and a small `000`. The large digits are what a field team calls out.
 */
export function labelParts(value: number, interval: number): {
    full: string; prefix: string; principal: string; suffix: string;
} {
    const metres = Math.round(value);
    const full = String(metres);

    // Two principal digits sit immediately above the interval's magnitude:
    // a 1000 m interval makes the thousands and ten-thousands digits principal.
    const digitsBelow = String(interval).length - 1;
    const suffix = full.slice(full.length - digitsBelow) || '';
    const head = full.slice(0, full.length - digitsBelow);
    const principal = head.slice(-2);
    const prefix = head.slice(0, -2);

    return { full, prefix, principal, suffix };
}
