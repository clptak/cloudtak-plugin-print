/**
 * The map layers this plugin adds for its own use.
 *
 * Pure and dependency-free so both the map code and the harvest can share it, and
 * so service/test/parity can exercise it.
 *
 * The harvest captures the live style with map.getStyle(), which returns
 * everything currently on the map -- including the sheet box. Left in, the box's
 * translucent blue fill covers exactly the print area, so every sheet came out with
 * a blue wash over the whole map and a faint rectangle where the box edge fell.
 * The box is a tool for choosing what to print. It is not part of the map.
 */

export const SHEET_BOX_SOURCE = 'cloudtak-print-sheet';
export const SHEET_BOX_FILL = 'cloudtak-print-sheet-fill';
export const SHEET_BOX_LINE = 'cloudtak-print-sheet-line';

export const SHEET_BOX_LAYERS = [SHEET_BOX_FILL, SHEET_BOX_LINE];

/** True for anything this plugin put on the map itself. */
export function isPluginLayer(id: unknown): boolean {
    return typeof id === 'string' && id.startsWith('cloudtak-print-');
}

/**
 * Remove this plugin's own layers and sources from a captured style, in place.
 *
 * Matches on the id prefix rather than the exact list, so a layer added later --
 * a fit-to-area rubber band, a preview outline -- cannot leak onto a sheet by
 * being forgotten here.
 */
export function stripPluginLayers(style: Record<string, unknown>): { layers: number; sources: number } {
    let layers = 0;
    let sources = 0;

    if (Array.isArray(style.layers)) {
        const kept = (style.layers as Array<Record<string, unknown>>).filter((layer) => {
            const drop = isPluginLayer(layer.id);
            if (drop) layers++;
            return !drop;
        });

        style.layers = kept;
    }

    const bag = style.sources as Record<string, unknown> | undefined;
    if (bag && typeof bag === 'object') {
        for (const id of Object.keys(bag)) {
            if (isPluginLayer(id)) {
                delete bag[id];
                sources++;
            }
        }
    }

    return { layers, sources };
}
