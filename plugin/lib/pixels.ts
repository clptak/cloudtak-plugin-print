/**
 * Reading pixels out of a MapLibre image entry.
 *
 * Pure and dependency-free so it can be tested directly -- this is the second time
 * this handful of lines has broken silently, and the failure mode is bad: every
 * icon vanishes from the printed sheet and nothing anywhere says so.
 *
 * The shape is the trap. map.getImage(id) returns a StyleImage:
 *
 *     { data: { width, height, data: Uint8Array }, pixelRatio, sdf }
 *
 * The pixels, and the dimensions, live on `.data`. The StyleImage itself has no
 * width or height at all. Reach for the wrong object and width comes back
 * undefined, the entry fails a validity check, and it is skipped -- silently, and
 * for every image at once.
 */

export type Pixels = {
    width: number;
    height: number;
    data: Uint8Array | Uint8ClampedArray;
};

/** A MapLibre image entry, whose concrete shape varies by how it was added. */
export type ImageEntry = {
    data?: unknown;
    userImage?: unknown;
    pixelRatio?: number;
    sdf?: boolean;
};

function isPixels(value: unknown): value is Pixels {
    if (!value || typeof value !== 'object') return false;

    const candidate = value as Partial<Pixels>;

    return typeof candidate.width === 'number'
        && typeof candidate.height === 'number'
        && candidate.width > 0
        && candidate.height > 0
        && !!candidate.data
        && typeof (candidate.data as { length?: number }).length === 'number';
}

/**
 * The readable pixel buffer inside an image entry, or null if it needs drawing to
 * a canvas first (a bitmap or an <img>), which callers with a DOM can do.
 *
 * Order matters and mirrors what MapLibre actually produces: an RGBAImage on
 * `.data` first, then a user-supplied image, then the entry itself for the rare
 * case where it is already the pixel object.
 */
export function readPixels(entry: ImageEntry | undefined | null): Pixels | null {
    if (!entry) return null;

    for (const candidate of [entry.data, entry.userImage, entry]) {
        if (isPixels(candidate)) return candidate;
    }

    return null;
}

/** The object a caller should draw to a canvas when readPixels returns null. */
export function drawableFrom(entry: ImageEntry | undefined | null): unknown {
    if (!entry) return null;

    return entry.data ?? entry.userImage ?? entry;
}
