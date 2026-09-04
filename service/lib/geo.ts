/** Equatorial circumference of the WGS84 ellipsoid, metres. */
const EQUATORIAL_CIRCUMFERENCE = 40075016.686;

/** MapLibre lays the world out as 512 CSS pixels wide at zoom 0. */
const WORLD_PX_AT_Z0 = 512;

/** Ground metres per CSS pixel at zoom 0 on the equator. */
const BASE_RESOLUTION = EQUATORIAL_CIRCUMFERENCE / WORLD_PX_AT_Z0;

const M_PER_INCH = 0.0254;

const radians = (degrees: number): number => {
    return (degrees * Math.PI) / 180;
};

/**
 * Ground metres represented by one CSS pixel at a given map scale.
 *
 * One CSS pixel is 1/layoutDpi inches on paper, which at 1:N is N/layoutDpi
 * inches on the ground. Note this depends on the LAYOUT resolution, not the
 * output resolution — deviceScaleFactor multiplies the backing store without
 * changing what a CSS pixel means.
 */
export function metresPerPixel(scale: number, layoutDpi: number): number {
    return (scale * M_PER_INCH) / layoutDpi;
}

/**
 * MapLibre zoom that puts a given map scale on the page at a given latitude.
 *
 * Web Mercator resolution varies with latitude, so scale is only exact at the
 * latitude it is computed for — here, the sheet centre. Across a sheet the error
 * is the change in cos(latitude) over its height: about 0.2% for a 20 km sheet at
 * 35 deg N, which is far below what anyone can measure off a printed map. It
 * grows toward the poles and is worth revisiting if this is ever used at high
 * latitude.
 */
export function zoomForScale(scale: number, layoutDpi: number, latitude: number): number {
    const target = metresPerPixel(scale, layoutDpi);
    const atLatitude = BASE_RESOLUTION * Math.cos(radians(latitude));

    return Math.log2(atLatitude / target);
}

/** Inverse of zoomForScale — the scale denominator a given zoom represents. */
export function scaleForZoom(zoom: number, layoutDpi: number, latitude: number): number {
    const resolution = (BASE_RESOLUTION * Math.cos(radians(latitude))) / 2 ** zoom;

    return (resolution * layoutDpi) / M_PER_INCH;
}

export type BBox = [number, number, number, number];

export function bboxCenter(bbox: BBox): [number, number] {
    return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

/**
 * Ground dimensions of a bbox in metres, measured through its centre.
 * Good enough for choosing a sheet scale; not a geodesic area calculation.
 */
export function bboxMetres(bbox: BBox): { width: number; height: number } {
    const [west, south, east, north] = bbox;
    const midLatitude = (south + north) / 2;

    const metresPerDegreeLat = EQUATORIAL_CIRCUMFERENCE / 360;
    const metresPerDegreeLng = metresPerDegreeLat * Math.cos(radians(midLatitude));

    return {
        width: Math.abs(east - west) * metresPerDegreeLng,
        height: Math.abs(north - south) * metresPerDegreeLat,
    };
}

/**
 * Fit-to-area: the smallest scale denominator that fits a drawn bbox inside the
 * map frame. Both axes are checked and the larger requirement wins, so the whole
 * drawn area is on the sheet.
 */
export function scaleForBBox(bbox: BBox, frameInches: { width: number; height: number }): number {
    const ground = bboxMetres(bbox);

    return Math.max(
        ground.width / (frameInches.width * M_PER_INCH),
        ground.height / (frameInches.height * M_PER_INCH),
    );
}

/**
 * Scales offered in the UI. See docs/DESIGN.md section 8.2.
 * 1:15,840 is the old inch-to-the-quarter-mile forest scale.
 */
export const STANDARD_SCALES = [6000, 12000, 15840, 24000, 25000, 50000, 62500, 100000];

/**
 * Snap a computed scale UP to the next standard value.
 *
 * Up, never down: rounding down would crop the area the user drew. The cost is
 * extra margin on the sheet, which is visible and harmless; the alternative is
 * silently losing part of a search area.
 */
export function snapScale(scale: number): number {
    const rung = STANDARD_SCALES.find((candidate) => {
        return candidate >= scale;
    });

    return rung ?? Math.ceil(scale / 10000) * 10000;
}

/**
 * Grid interval in metres for a given scale. Derived from the scale rather than
 * chosen by the user, because printed UTM grid tools are cut for specific
 * scale-and-interval pairings. See docs/DESIGN.md section 8.3.
 */
export function gridInterval(scale: number): number {
    if (scale <= 6000) return 200;
    if (scale <= 12000) return 500;
    if (scale <= 25000) return 1000;
    if (scale <= 62500) return 1000;
    return 5000;
}
