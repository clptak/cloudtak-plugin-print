/**
 * Standard American sheet sizes, in inches, portrait (width x height).
 * See docs/DESIGN.md section 8.1 for why this list.
 */
export const PAPER = {
    'letter': { label: 'Letter', width: 8.5, height: 11 },
    'legal': { label: 'Legal', width: 8.5, height: 14 },
    'tabloid': { label: 'Tabloid / ANSI B', width: 11, height: 17 },
    'ansi-c': { label: 'ANSI C', width: 17, height: 22 },
    'ansi-d': { label: 'ANSI D', width: 22, height: 34 },
    'arch-d': { label: 'Arch D', width: 24, height: 36 },
    'arch-e': { label: 'Arch E', width: 36, height: 48 },
} as const;

export type PaperSize = keyof typeof PAPER;
export type Orientation = 'portrait' | 'landscape';

export const PAPER_SIZES = Object.keys(PAPER) as PaperSize[];

/** Default margins in inches. The bottom strip carries the title block. */
export const MARGINS = { top: 0.5, right: 0.5, bottom: 1.3, left: 0.5 };

/**
 * Space reserved immediately below the map frame for the bottom row of grid
 * labels. Without it the title block's rule runs straight through them, which is
 * exactly what happened on the first gridded sheet.
 */
export const GRID_GUTTER = 0.45;

/** Metres per inch. */
const M_PER_INCH = 0.0254;

export type Sheet = {
    /** Full sheet dimensions in inches. */
    sheet: { width: number; height: number };
    /** The map frame, inside the margins, in inches. */
    frame: { width: number; height: number };
};

export function sheet(size: PaperSize, orientation: Orientation): Sheet {
    const paper = PAPER[size];

    const width = orientation === 'portrait' ? paper.width : paper.height;
    const height = orientation === 'portrait' ? paper.height : paper.width;

    return {
        sheet: { width, height },
        frame: {
            width: width - MARGINS.left - MARGINS.right,
            height: height - MARGINS.top - MARGINS.bottom,
        },
    };
}

/**
 * Ground footprint of the map frame at a given scale.
 *
 * ground_metres = frame_inches x scale x 0.0254
 *
 * At 1:24,000 one paper inch is 609.6 m on the ground. Paper size, margins and
 * scale together fully determine the rectangle — which is why the on-map box is a
 * placement, not a size.
 */
export function footprint(size: PaperSize, orientation: Orientation, scale: number): { width: number; height: number } {
    const { frame } = sheet(size, orientation);

    return {
        width: frame.width * scale * M_PER_INCH,
        height: frame.height * scale * M_PER_INCH,
    };
}
