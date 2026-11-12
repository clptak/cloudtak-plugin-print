/**
 * What a print job produces, and what the file is called.
 *
 * Deliberately free of CloudTAK imports, like datasync.ts, so service/test/parity
 * can cover it.
 */

export type OutputFormat = 'pdf' | 'tif';

/**
 * The output menu, label to format.
 *
 * Named for what each one is FOR rather than for the file type: the sheet is
 * what gets printed, the overlay is what goes back on the map. A GeoPDF also
 * imports, but carries its collar with it (docs/GEOREFERENCING.md section 4);
 * the GeoTIFF is the map frame alone.
 */
export const OUTPUTS: Array<[string, OutputFormat]> = [
    ['PDF Sheet', 'pdf'],
    ['GeoTIFF Overlay', 'tif'],
];

export function formatFor(label: string): OutputFormat {
    return OUTPUTS.find(([l]) => l === label)?.[1] ?? 'pdf';
}

/**
 * The filename for a finished job.
 *
 * A Data Sync or the Imports list keeps everything ever sent to it, so callers
 * add a timestamp suffix where names could collide. CloudTAK's importer picks
 * its transform by extension, so the extension has to be right, not just
 * cosmetic: `.tif` is what routes the file to GDAL.
 */
export function outputName(title: string, scale: number, format: OutputFormat, suffix = ''): string {
    const stem = title.trim()
        ? title.replace(/[^\w-]+/g, '-').toLowerCase().replace(/^-+|-+$/g, '')
        : 'map';

    return `${stem || 'map'}-${scale}${suffix}.${format}`;
}
