import { getBrowser, ORIGIN } from './browser.js';
import { MARGINS, GRID_GUTTER } from './paper.js';

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
    title?: string;
    incident?: string;
    author?: string;
    /** Scale denominator: 24000 means 1:24,000. */
    scale: number;
    /** ISO timestamp the sheet was produced. */
    generated: string;
    datum?: string;
    /** Rendered map resolution. Reported with the job, not printed on the sheet. */
    dpi?: number;
    /** e.g. "UTM 12S · 1000 m". Printed so a reader knows what grid they have. */
    gridZone?: string;
    /** Agency name, set above the title. */
    agency?: string;
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
    /** Scale bar and north arrow, already sized in real units. */
    furniture?: {
        scaleBar?: { svg: string; widthPx: number; heightPx: number; viewBox: string };
        northArrow?: { svg: string; widthPx: number; heightPx: number; viewBox: string };
        layoutDpi: number;
    };
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

    const dpi = opts.furniture?.layoutDpi ?? 200;
    const embed = (d?: { svg: string; widthPx: number; heightPx: number; viewBox: string }) => {
        if (!d) return '';
        return `<svg width="${(d.widthPx / dpi).toFixed(3)}in" height="${(d.heightPx / dpi).toFixed(3)}in"`
            + ` viewBox="${d.viewBox}" xmlns="http://www.w3.org/2000/svg">${d.svg}</svg>`;
    };

    const drawings = opts.furniture
        ? `<div class="marginalia">${embed(opts.furniture.scaleBar)}${embed(opts.furniture.northArrow)}</div>`
        : '';

    // Fields are laid out as a row of labelled cells so the block stays readable
    // when a value is missing, rather than collapsing into ambiguity.
    // Datum rides with the grid because that is what it qualifies. Five labelled
    // cells never fitted a Letter sheet -- 'Generated' was being silently clipped
    // by the block's overflow long before the strip was compacted, which is why
    // the timestamp is no longer printed at all.
    const datum = meta.datum ?? 'WGS 84';

    const fields: Array<[string, string]> = [
        ['Scale', formatScale(meta.scale)],
    ];

    if (meta.gridZone) {
        fields.push(['Grid', `${meta.gridZone} \u00b7 ${datum}`]);
    } else {
        fields.push(['Datum', datum]);
    }

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

  .frame img {
    display: block;
    width: ${frame.width}in;
    height: ${frame.height}in;
  }

  /* The grid spans the whole sheet, not the frame, so its labels can sit in the
     margin outside the neatline. It must therefore live outside .frame, whose
     overflow is hidden. */
  svg.grid {
    position: absolute;
    inset: 0;
    width: ${sheet.width}in;
    height: ${sheet.height}in;
    pointer-events: none;
  }

  .title-block {
    position: absolute;
    left: ${MARGINS.left}in;
    right: ${MARGINS.right}in;
    bottom: 0.12in;
    height: ${MARGINS.bottom - GRID_GUTTER - 0.12}in;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.28in;
    /* A long title used to wrap and escape upward through the rule into the grid
       labels. Nothing in this block may leave it. */
    overflow: hidden;
  }

  .identity {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    /* flex items refuse to shrink below their content without this, which is
       what let the title push the rest of the block out of shape. */
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
  }

  .agency {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 7pt;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #555;
    margin-bottom: 0.02in;
  }

  /* Scale bar and north arrow sit at the right of the block, in the order a
     reader wants them: how far, then which way. */
  .marginalia {
    display: flex;
    align-items: flex-end;
    gap: 0.28in;
    flex: none;
  }

  .marginalia svg {
    display: block;
  }

  .title {
    font-size: 11pt;
    font-weight: 700;
    line-height: 1.1;
    letter-spacing: -0.01em;
    /* One line, truncated. A sheet title that reflows changes the height of the
       whole block and pushes the scale bar and north arrow out of place. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Under the title, reading left to right, so the title keeps the width it
     needs. Ranged left because it now sits below a left-aligned title. */
  /* Label and value on one line rather than stacked: the stacked form cost an
     extra 0.12in of sheet height on every print for no added clarity. */
  .fields {
    display: flex;
    gap: 0.13in;
    flex: none;
    white-space: nowrap;
    margin-top: 0.04in;
    align-items: baseline;
  }

  .field {
    display: flex;
    align-items: baseline;
    gap: 0.05in;
  }

  .field-label {
    text-align: left;
    font-size: 5.5pt;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: #555;
    white-space: nowrap;
  }

  .field-value {
    text-align: left;
    font-size: 8pt;
    font-weight: 600;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
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
    <div class="frame"><img src="${ORIGIN}/map.png" alt=""></div>
    ${opts.grid ?? ''}

    <div class="title-block">
      <div class="identity">
        ${meta.agency ? `<div class="agency">${escape(meta.agency)}</div>` : ''}
        ${meta.title ? `<div class="title">${escape(meta.title)}</div>` : ''}
        <div class="fields">
          ${fields.map(([label, value]) => {
                return `<div class="field"><span class="field-label">${escape(label)}</span>`
                    + `<span class="field-value">${escape(value)}</span></div>`;
            }).join('\n          ')}
        </div>
      </div>
      ${drawings}
    </div>

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
