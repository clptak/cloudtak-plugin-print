import Err from '@openaddresses/batch-error';

/**
 * Output resolutions we are willing to emit, highest first.
 *
 * A ladder rather than an arbitrary number: a sheet that silently comes out at
 * 178 DPI is harder to reason about than one that comes out at 150, and printers
 * and expectations both work in round numbers.
 */
export const DPI_LADDER = [300, 200, 150, 120, 100, 72];

export type Resolved = {
    dpi: number;
    /** Layout size in CSS pixels — this is what drives label density. */
    css: { width: number; height: number };
    /** Chromium deviceScaleFactor. */
    deviceScale: number;
    /** Backing store size, which is what the GL texture limit applies to. */
    pixels: { width: number; height: number };
    /** Why the requested DPI was lowered, if it was. */
    clampedBy: 'none' | 'ceiling' | 'texture';
};

/**
 * Pick the output resolution for a sheet.
 *
 * The binding constraint is measured, not assumed: under SwiftShader, Chromium
 * reports MAX_TEXTURE_SIZE of 8192, not the 16384 typical of real hardware. The
 * backing store is CSS size x deviceScaleFactor, so the longest edge of the map
 * frame is what caps DPI — and it is why an E-size sheet cannot be rendered at
 * 200 DPI in one pass on this box.
 *
 * Lowering resolution costs less than it sounds like: in the finished PDF only
 * the basemap imagery is raster. Text, grid lines and the scale bar are vector
 * and unaffected.
 */
export function resolve(opts: {
    frameInches: { width: number; height: number };
    requestedDpi?: number;
    maxDpi: number;
    layoutDpi: number;
    maxTexture: number;
}): Resolved {
    const { frameInches, maxDpi, layoutDpi, maxTexture } = opts;

    const longestEdge = Math.max(frameInches.width, frameInches.height);
    const textureCeiling = maxTexture / longestEdge;

    const requested = opts.requestedDpi ?? maxDpi;
    const budget = Math.min(requested, maxDpi, textureCeiling);

    const dpi = DPI_LADDER.find((rung) => {
        return rung <= budget;
    });

    if (!dpi) {
        throw new Err(
            422,
            null,
            `Sheet is too large to render in one pass: a ${longestEdge}in frame needs `
            + `${Math.ceil(longestEdge * DPI_LADDER[DPI_LADDER.length - 1])}px, `
            + `over the ${maxTexture}px GL texture limit. Use a smaller sheet or a lower DPI.`,
        );
    }

    let clampedBy: Resolved['clampedBy'] = 'none';
    if (dpi < requested) {
        clampedBy = textureCeiling < Math.min(requested, maxDpi) ? 'texture' : 'ceiling';
    }

    const css = {
        width: frameInches.width * layoutDpi,
        height: frameInches.height * layoutDpi,
    };

    const deviceScale = dpi / layoutDpi;

    return {
        dpi,
        css,
        deviceScale,
        pixels: {
            width: Math.round(css.width * deviceScale),
            height: Math.round(css.height * deviceScale),
        },
        clampedBy,
    };
}
