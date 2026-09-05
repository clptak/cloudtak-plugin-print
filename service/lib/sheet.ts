import { getBrowser, ORIGIN } from './browser.js';
import { MARGINS } from './paper.js';

/**
 * Compose the finished sheet and emit a PDF.
 *
 * The map arrives as a raster, but everything else on the page is laid out in
 * HTML and printed by Chromium, so the title block, the neatline and — later —
 * the grid labels and scale bar come out as VECTOR text and line work. Only the
 * map imagery is pixels. That is why a sheet forced down to 150 DPI by the
 * texture limit still prints crisp type.
 *
 * `@page { size: <W>in <H>in }` with `preferCSSPageSize` makes the paper size
 * literal: no scaling step between the map's ground resolution and the paper, so
 * a printed inch really is `scale` inches on the ground.
 */

export type SheetMeta = {
    title: string;
    incident?: string;
    author?: string;
    /** Scale denominator: 24000 means 1:24,000. */
    scale: number;
    /** ISO timestamp the sheet was produced. */
    generated: string;
    datum?: string;
    /** Rendered map resolution, for the provenance line. */
    dpi?: number;
    /** e.g. "UTM 12S · 1000 m". Printed so a reader knows what grid they have. */
    gridZone?: string;
    /** Anything the operator should know about this sheet. */
    warnings?: string[];
};

export type SheetOptions = {
    /** PNG of the map area. */
    map: Buffer;
    /** Full sheet size in inches. */
    sheet: { width: number; height: number };
    /**
     * UTM grid as an SVG overlay sized to the map frame. Kept out of the map
     * raster so it prints as vector line work and vector text — a grid is
     * measured against, so it must not inherit the imagery's resolution cap.
     */
    grid?: string;
    /** Map frame size in inches, inside the margins. */
    frame: { width: number; height: number };
    meta: SheetMeta;
};

const escape = (value: string): string => {
    return value.replace(/[&<>"']/g, (c) => {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] as string;
    });
};

/** 1:24000 -> "1:24,000" */
export function formatScale(scale: number): string {
    return `1:${scale.toLocaleString('en-US')}`;
}

export function sheetHtml(opts: SheetOptions): string {
    const { sheet, frame, meta } = opts;

    const when = new Date(meta.generated);
    const stamp = `${when.toISOString().slice(0, 16).replace('T', ' ')}Z`;

    // Fields are laid out as a row of labelled cells so the block stays readable
    // when a value is missing, rather than collapsing into ambiguity.
    const fields: Array<[string, string]> = [
        ['Scale', formatScale(meta.scale)],
        ['Datum', meta.datum ?? 'WGS 84'],
        ['Generated', stamp],
    ];

    if (meta.gridZone) fields.splice(2, 0, ['Grid', meta.gridZone]);
    if (meta.incident) fields.unshift(['Incident', meta.incident]);
    if (meta.author) fields.push(['Author', meta.author]);

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {
    size: ${sheet.width}in ${sheet.height}in;
    margin: 0;
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    width: ${sheet.width}in;
    height: ${sheet.height}in;
    font-family: "Liberation Sans", "DejaVu Sans", Arial, Helvetica, sans-serif;
    color: #111;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .sheet {
    position: relative;
    width: ${sheet.width}in;
    height: ${sheet.height}in;
    padding: ${MARGINS.top}in ${MARGINS.right}in ${MARGINS.bottom}in ${MARGINS.left}in;
  }

  /* The neatline is the map's border and the reference edge for grid labels
     later, so it is drawn as a real element rather than an image effect. */
  .frame {
    position: relative;
    width: ${frame.width}in;
    height: ${frame.height}in;
    border: 0.5pt solid #111;
    overflow: hidden;
  }

  .frame img,
  .frame svg {
    display: block;
    width: ${frame.width}in;
    height: ${frame.height}in;
  }

  .frame svg {
    position: absolute;
    inset: 0;
  }

  .title-block {
    position: absolute;
    left: ${MARGINS.left}in;
    right: ${MARGINS.right}in;
    bottom: 0.28in;
    height: ${MARGINS.bottom - 0.45}in;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.3in;
    border-top: 1pt solid #111;
    padding-top: 0.10in;
  }

  .title {
    font-size: 16pt;
    font-weight: 700;
    line-height: 1.15;
    letter-spacing: -0.01em;
    max-width: 55%;
  }

  .fields {
    display: flex;
    gap: 0.30in;
    text-align: right;
  }

  .field-label {
    font-size: 6.5pt;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: #555;
    white-space: nowrap;
  }

  .field-value {
    font-size: 10.5pt;
    font-weight: 600;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* Provenance, deliberately small: it matters when someone questions a sheet
     weeks later, and never before then. */
  .provenance {
    position: absolute;
    left: ${MARGINS.left}in;
    bottom: 0.13in;
    font-size: 6pt;
    color: #777;
  }

  .caution {
    position: absolute;
    right: ${MARGINS.right}in;
    bottom: 0.13in;
    font-size: 6pt;
    font-weight: 700;
    color: #a11;
    text-align: right;
    max-width: 4in;
  }
</style>
</head>
<body>
  <div class="sheet">
    <div class="frame"><img src="${ORIGIN}/map.png" alt="">${opts.grid ?? ''}</div>

    <div class="title-block">
      <div class="title">${escape(meta.title)}</div>
      <div class="fields">
        ${fields.map(([label, value]) => {
            return `<div><div class="field-label">${escape(label)}</div>`
                + `<div class="field-value">${escape(value)}</div></div>`;
        }).join('\n        ')}
      </div>
    </div>

    <div class="provenance">CloudTAK Print${meta.dpi ? ` &middot; map imagery ${meta.dpi} dpi` : ''} &middot; north up</div>
    ${meta.warnings && meta.warnings.length
        ? `<div class="caution">INCOMPLETE: ${escape(String(meta.warnings.length))} source(s) or request(s) failed &mdash; see job warnings</div>`
        : ''}
  </div>
</body>
</html>`;
}

/**
 * Print the sheet.
 *
 * A separate page from the map render: this one needs no WebGL, and keeping it
 * separate means a layout mistake cannot cost a re-render of the map.
 */
export async function composeSheet(opts: SheetOptions): Promise<Buffer> {
    const browser = await getBrowser();
    const context = await browser.newContext();

    try {
        const page = await context.newPage();

        await page.route(`${ORIGIN}/**`, async (route) => {
            const pathname = new URL(route.request().url()).pathname;

            if (pathname === '/map.png') {
                return route.fulfill({ status: 200, contentType: 'image/png', body: opts.map });
            }
            if (pathname === '/' || pathname === '/sheet.html') {
                return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: sheetHtml(opts) });
            }

            return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
        });

        await page.goto(`${ORIGIN}/sheet.html`, { waitUntil: 'domcontentloaded' });

        // page.pdf does not wait for images; a sheet printed early is a blank frame.
        await page.waitForFunction(() => {
            return Array.from(document.images).every((img) => {
                return img.complete && img.naturalWidth > 0;
            });
        }, undefined, { timeout: 120000 });

        return await page.pdf({
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
        });
    } finally {
        await context.close();
    }
}
