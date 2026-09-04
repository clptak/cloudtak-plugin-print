/**
 * Adapt a screen style for paper.
 *
 * A MapLibre style is authored for a backlit screen at roughly 96 CSS px to the
 * inch. Printed at 200 dpi with the same CSS layout, every mark keeps its pixel
 * width and so shrinks physically: a 0.6px contour becomes 0.16 mm, below what
 * most printers reproduce, which is why contours come out as ghosts.
 *
 * The fix has two halves, and they belong together:
 *
 *  1. Lay the map out at the OUTPUT resolution rather than a screen resolution.
 *     That makes deviceScaleFactor 1, so MapLibre selects raster tiles for the
 *     zoom actually being printed instead of picking screen-zoom tiles and
 *     letting Chromium stretch them. Same output pixel count, sharper imagery.
 *  2. Scale every mark back up by the same factor, so a line that read as 1px on
 *     screen still occupies the same physical width on paper.
 *
 * Then put a floor under line width, in millimetres, because a style may specify
 * marks that are simply too fine to print no matter how the page is laid out.
 */

export type CartographyOptions = {
    /** Multiply mark sizes by this. Normally layoutDpi / 96. */
    markScale: number;
    /** Minimum printed line width in millimetres. */
    minLineMm: number;
    /** CSS pixels per inch the map is laid out at, to convert mm to px. */
    layoutDpi: number;
    /** Multiply line opacity by this, capped at 1. 1 leaves opacity alone. */
    lineOpacityBoost?: number;
};

type Json = unknown;

const isStops = (v: Json): v is { base?: number; stops: Array<[number, number]> } => {
    return !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { stops?: unknown }).stops);
};

/**
 * Multiply a numeric style property, whatever form it takes.
 *
 * MapLibre allows a plain number, a legacy `{base, stops}` object, or an
 * expression. Expressions cannot be evaluated here — they may be data-driven —
 * so they are wrapped rather than computed.
 */
export function scaleNumeric(value: Json, factor: number, fallback: number): Json {
    if (factor === 1) return value === undefined ? undefined : value;

    if (value === undefined) return fallback * factor;

    if (typeof value === 'number') return value * factor;

    if (isStops(value)) {
        return {
            ...value,
            stops: value.stops.map(([zoom, v]) => {
                return [zoom, typeof v === 'number' ? v * factor : v] as [number, number];
            }),
        };
    }

    if (Array.isArray(value)) return ['*', value, factor];

    return value;
}

/** Apply a lower bound to a numeric property, preserving expressions. */
export function floorNumeric(value: Json, minimum: number): Json {
    if (typeof value === 'number') return Math.max(value, minimum);
    if (value === undefined) return minimum;

    if (isStops(value)) {
        return {
            ...value,
            stops: (value.stops as Array<[number, number]>).map(([zoom, v]) => {
                return [zoom, typeof v === 'number' ? Math.max(v, minimum) : v] as [number, number];
            }),
        };
    }

    if (Array.isArray(value)) return ['max', value, minimum];

    return value;
}

export function forPrint(
    style: Record<string, unknown>,
    opts: CartographyOptions,
): { style: Record<string, unknown>; adjusted: number } {
    const minLinePx = (opts.minLineMm / 25.4) * opts.layoutDpi;
    const boost = opts.lineOpacityBoost ?? 1;

    if (opts.markScale === 1 && minLinePx <= 0 && boost === 1) return { style, adjusted: 0 };

    const layers = (style.layers ?? []) as Array<Record<string, unknown>>;
    let adjusted = 0;

    for (const layer of layers) {
        const paint = (layer.paint ?? {}) as Record<string, Json>;
        const layout = (layer.layout ?? {}) as Record<string, Json>;
        let touched = false;

        if (layer.type === 'line') {
            // Defaults from the style spec, so an unspecified width still gets a floor.
            paint['line-width'] = floorNumeric(scaleNumeric(paint['line-width'], opts.markScale, 1), minLinePx);
            if (paint['line-gap-width'] !== undefined) {
                paint['line-gap-width'] = scaleNumeric(paint['line-gap-width'], opts.markScale, 0);
            }
            if (boost !== 1 && typeof paint['line-opacity'] === 'number') {
                paint['line-opacity'] = Math.min(1, paint['line-opacity'] * boost);
            }
            touched = true;
        }

        if (layer.type === 'circle') {
            paint['circle-radius'] = scaleNumeric(paint['circle-radius'], opts.markScale, 5);
            if (paint['circle-stroke-width'] !== undefined) {
                paint['circle-stroke-width'] = scaleNumeric(paint['circle-stroke-width'], opts.markScale, 0);
            }
            touched = true;
        }

        if (layer.type === 'symbol') {
            layout['text-size'] = scaleNumeric(layout['text-size'], opts.markScale, 16);
            layout['icon-size'] = scaleNumeric(layout['icon-size'], opts.markScale, 1);
            if (paint['text-halo-width'] !== undefined) {
                paint['text-halo-width'] = scaleNumeric(paint['text-halo-width'], opts.markScale, 0);
            }
            touched = true;
        }

        if (layer.type === 'fill' && paint['fill-outline-color'] !== undefined) {
            // Fill outlines are always one pixel wide in MapLibre and cannot be
            // scaled, so they simply become hairlines on paper. Nothing to do
            // here, but worth knowing when a boundary looks weak.
            touched = touched || false;
        }

        if (touched) {
            layer.paint = paint;
            layer.layout = layout;
            adjusted++;
        }
    }

    return { style, adjusted };
}
