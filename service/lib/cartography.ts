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
 * Does this expression reference the zoom level anywhere inside it?
 *
 * It matters because MapLibre requires `["zoom"]` to be the direct input of a
 * TOP-LEVEL `step` or `interpolate`. Wrapping such an expression in anything —
 * `["*", expr, 2]`, `["max", expr, 1.5]` — makes it invalid and MapLibre rejects
 * the whole style. So a zoom expression must be transformed from the inside, by
 * rewriting its output values, never from the outside.
 */
function referencesZoom(value: Json): boolean {
    if (!Array.isArray(value)) return false;
    if (value[0] === 'zoom') return true;
    return value.some((item) => {
        return referencesZoom(item);
    });
}

const INTERPOLATORS = new Set(['interpolate', 'interpolate-hcl', 'interpolate-lab']);

/**
 * Apply a numeric transform to a style property in any form MapLibre allows.
 *
 * Plain numbers and legacy `{base, stops}` are transformed directly. For
 * `interpolate` and `step` the OUTPUT values are transformed and the zoom input
 * left untouched, which keeps the expression valid. Any other expression that
 * mentions zoom is left alone rather than risking an invalid style; everything
 * else is wrapped.
 */
function mapNumeric(
    value: Json,
    leaf: (n: number) => number,
    wrap: (expr: Json[]) => Json,
    fallback?: number,
): Json {
    if (value === undefined) return fallback === undefined ? undefined : leaf(fallback);

    if (typeof value === 'number') return leaf(value);

    if (isStops(value)) {
        return {
            ...value,
            stops: value.stops.map(([zoom, v]) => {
                return [zoom, typeof v === 'number' ? leaf(v) : v] as [number, number];
            }),
        };
    }

    if (Array.isArray(value)) {
        const op = value[0];

        if (INTERPOLATORS.has(op as string)) {
            // ["interpolate", interpolation, input, stop_in, stop_out, ...]
            const out = value.slice();
            for (let i = 4; i < out.length; i += 2) out[i] = mapNumeric(out[i], leaf, wrap);
            return out;
        }

        if (op === 'step') {
            // ["step", input, default_out, stop_in, stop_out, ...]
            const out = value.slice();
            out[2] = mapNumeric(out[2], leaf, wrap);
            for (let i = 4; i < out.length; i += 2) out[i] = mapNumeric(out[i], leaf, wrap);
            return out;
        }

        if (referencesZoom(value)) return value;

        return wrap(value);
    }

    return value;
}

/** Multiply a numeric style property, whatever form it takes. */
export function scaleNumeric(value: Json, factor: number, fallback: number): Json {
    if (factor === 1) return value;

    return mapNumeric(
        value,
        (n) => {
            return n * factor;
        },
        (expr) => {
            return ['*', expr, factor];
        },
        fallback,
    );
}

/** Apply a lower bound to a numeric property, preserving expressions. */
export function floorNumeric(value: Json, minimum: number): Json {
    return mapNumeric(
        value,
        (n) => {
            return Math.max(n, minimum);
        },
        (expr) => {
            return ['max', expr, minimum];
        },
        minimum,
    );
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
            const scaled = scaleNumeric(paint['line-width'], opts.markScale, 1);
            // Only apply the floor when there is one; otherwise every expression
            // picks up a pointless ["max", expr, 0] wrapper.
            paint['line-width'] = minLinePx > 0 ? floorNumeric(scaled, minLinePx) : scaled;
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
