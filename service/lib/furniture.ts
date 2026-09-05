import geomagnetism from 'geomagnetism';
import { centralMeridian } from './utm.js';

/**
 * Margin furniture: the scale bar and the north arrow.
 *
 * Both are SVG so they stay vector in the PDF, and both are sized in real units
 * rather than pixels — a scale bar that is not exactly the length it claims is
 * worse than no scale bar, since someone will measure against it.
 */

const M_PER_INCH = 0.0254;
const M_PER_MILE = 1609.344;
const FONT = 'Liberation Sans, DejaVu Sans, Arial, sans-serif';

/** Ground metres represented by one inch of paper at a given scale. */
export const groundPerInch = (scale: number): number => {
    return scale * M_PER_INCH;
};

/**
 * Pick the longest "round" distance that fits the space available.
 *
 * Round because a scale bar is read by eye: 1 km divided into quarters is usable,
 * 1.37 km is not.
 */
export function niceLength(candidates: number[], maxMetres: number): number {
    let best = candidates[0];
    for (const c of candidates) if (c <= maxMetres) best = c;
    return best;
}

const METRIC = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000];
const IMPERIAL_MILES = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 50];

export type Drawing = { svg: string; widthPx: number; heightPx: number; viewBox: string };
export type ScaleBar = Drawing & { metric: number; miles: number };

/**
 * A dual scale bar, metric above imperial, sharing a zero.
 *
 * Both units because SAR runs on both: distances come off a map in kilometres and
 * out of a radio in miles.
 */
export function scaleBar(opts: { scale: number; layoutDpi: number; maxInches: number }): ScaleBar {
    const { scale, layoutDpi } = opts;
    const perInch = groundPerInch(scale);
    const mm = (v: number) => {
        return (v / 25.4) * layoutDpi;
    };

    const maxMetres = opts.maxInches * perInch;
    const metric = niceLength(METRIC, maxMetres);
    const miles = niceLength(IMPERIAL_MILES.map((m) => {
        return m * M_PER_MILE;
    }), maxMetres) / M_PER_MILE;

    const metricPx = (metric / perInch) * layoutDpi;
    const milesPx = ((miles * M_PER_MILE) / perInch) * layoutDpi;
    const widthPx = Math.max(metricPx, milesPx);

    const barH = mm(1.6);
    const labelPx = mm(2.2);
    const tickPx = mm(1.5);

    const divisions = 4;

    const bar = (lengthPx: number, y: number) => {
        const seg = lengthPx / divisions;
        const cells: string[] = [];
        for (let i = 0; i < divisions; i++) {
            cells.push(`<rect x="${(i * seg).toFixed(1)}" y="${y.toFixed(1)}"`
                + ` width="${seg.toFixed(1)}" height="${barH.toFixed(1)}"`
                + ` fill="${i % 2 ? '#fff' : '#111'}" stroke="#111" stroke-width="${mm(0.15).toFixed(2)}"/>`);
        }
        return cells.join('');
    };

    const label = (x: number, y: number, text: string, anchor = 'middle') => {
        return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}"`
            + ` font-family="${FONT}" font-size="${labelPx.toFixed(1)}" fill="#111">${text}</text>`;
    };

    const metricText = metric >= 1000 ? `${metric / 1000} km` : `${metric} m`;
    const milesText = miles === 1 ? '1 mile' : `${miles} miles`;

    // End labels are anchored to the end of their bar, not centred on it, so a
    // long unit string cannot run outside the drawing's box and be clipped.
    const yMetric = labelPx + mm(0.8);
    const yMiles = yMetric + barH + labelPx + mm(2.6);
    const heightPx = yMiles + barH + labelPx + mm(0.8);

    const svg = `<g class="scalebar">`
        + bar(metricPx, yMetric)
        + label(0, yMetric - tickPx, '0', 'start')
        + label(metricPx, yMetric - tickPx, metricText, 'end')
        + bar(milesPx, yMiles)
        + label(0, yMiles + barH + labelPx, '0', 'start')
        + label(milesPx, yMiles + barH + labelPx, milesText, 'end')
        + `</g>`;

    return {
        svg,
        widthPx,
        heightPx,
        viewBox: `0 0 ${widthPx.toFixed(1)} ${heightPx.toFixed(1)}`,
        metric,
        miles,
    };
}

export type Declination = {
    /** Degrees east of true north. Negative is west. */
    declination: number;
    /** Grid north relative to true north, degrees east. */
    convergence: number;
    model: string;
    /** True when the model is outside its validity window and should not be trusted. */
    expired: boolean;
};

/**
 * Magnetic declination and grid convergence at a point.
 *
 * Computed offline from the World Magnetic Model — this must not depend on
 * reaching NOAA, because a sheet is printed when the network is least reliable.
 * The model's validity is reported so an expired one can be said so on the paper
 * rather than silently printing a stale bearing onto a navigation aid.
 */
export function declinationAt(longitude: number, latitude: number, zone: number, when = new Date()): Declination {
    /*
     * The library THROWS once the date leaves the model's validity window, which
     * would take every sheet with a north arrow down on the day WMM-2025 lapses
     * (13 Nov 2029) rather than degrading. A print service must not have that
     * kind of time bomb in it: fall back to extrapolating from the last model and
     * say so on the paper, so the sheet still prints and the reader is told the
     * bearing needs verifying.
     */
    let model;
    let expired = false;

    try {
        model = geomagnetism.model(when);
    } catch {
        expired = true;
        model = geomagnetism.model(when, { allowOutOfBoundsModel: true });
    }

    const point = model.point([latitude, longitude]);

    // Grid convergence: the angle from true north to grid north.
    const dLon = ((longitude - centralMeridian(zone)) * Math.PI) / 180;
    const phi = (latitude * Math.PI) / 180;
    const convergence = (Math.atan(Math.tan(dLon) * Math.sin(phi)) * 180) / Math.PI;

    return {
        declination: point.decl,
        convergence,
        model: model.name ?? `WMM-${model.epoch}`,
        expired,
    };
}

const bearingPoint = (degrees: number, length: number): [number, number] => {
    const t = (degrees * Math.PI) / 180;
    return [Math.sin(t) * length, -Math.cos(t) * length];
};

/**
 * The three-north diagram from a topographic sheet: true, grid and magnetic.
 *
 * All three are needed together. The sheet is drawn north-up so true north is
 * vertical; the grid is UTM so grid north is off true north by the convergence;
 * and a compass in the field reads magnetic. A field team taking a bearing off
 * this sheet needs the difference between the grid they measure against and the
 * needle they walk on.
 */
export function northArrow(opts: {
    declination: Declination;
    layoutDpi: number;
    heightInches: number;
}): Drawing {
    const { declination: dec, layoutDpi } = opts;
    const mm = (v: number) => {
        return (v / 25.4) * layoutDpi;
    };

    const heightPx = opts.heightInches * layoutDpi;
    const labelPx = mm(2.0);
    const notePx = mm(1.6);

    // Room above the arms for the tip labels: an arm reaching the top of the box
    // puts its label's ascenders outside it, and the PDF clips them.
    const armPx = heightPx - labelPx * 3.4;
    const originX = 0;
    const originY = heightPx - labelPx * 1.4;

    const arms: Array<{ bearing: number; key: string; text: string; weight: string }> = [
        { bearing: 0, key: 'TN', text: 'true north', weight: '700' },
        {
            bearing: dec.convergence,
            key: 'GN',
            text: `${Math.abs(dec.convergence).toFixed(1)}°${dec.convergence >= 0 ? 'E' : 'W'}`,
            weight: '400',
        },
        {
            bearing: dec.declination,
            key: 'MN',
            text: `${Math.abs(dec.declination).toFixed(1)}°${dec.declination >= 0 ? 'E' : 'W'}`,
            weight: '400',
        },
    ];

    const parts: string[] = [];
    let maxX = 0;

    for (const arm of arms) {
        const [dx, dy] = bearingPoint(arm.bearing, armPx);
        const x = originX + dx;
        const y = originY + dy;
        maxX = Math.max(maxX, x);

        parts.push(`<line x1="${originX}" y1="${originY.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"`
            + ` stroke="#111" stroke-width="${mm(arm.bearing === 0 ? 0.5 : 0.3).toFixed(2)}"/>`);

        // A solid head on true north only, so the sheet's own orientation reads at
        // a glance and the other two are plainly references off it.
        if (arm.bearing === 0) {
            const w = mm(1.6);
            parts.push(`<path d="M${x.toFixed(1)} ${(y - mm(1.4)).toFixed(1)}`
                + ` L${(x - w / 2).toFixed(1)} ${(y + mm(1.5)).toFixed(1)}`
                + ` L${(x + w / 2).toFixed(1)} ${(y + mm(1.5)).toFixed(1)} Z" fill="#111"/>`);
        }

        /*
         * The arm's initials, set at a different radius per arm. Grid north sits
         * a fraction of a degree off true north, so labels at a common radius
         * overlap into an unreadable smudge exactly where the precision matters.
         */
        const [lx, ly] = bearingPoint(arm.bearing, armPx * (arm.key === 'GN' ? 0.62 : 1));
        parts.push(`<text x="${(originX + lx).toFixed(1)}" y="${(originY + ly - mm(1.5)).toFixed(1)}"`
            + ` text-anchor="middle" font-family="${FONT}" font-size="${(labelPx * 0.85).toFixed(1)}"`
            + ` font-weight="700" fill="#111">${arm.key}</text>`);
    }

    /*
     * The angles are read from a stacked legend rather than from labels at the
     * arm tips. Grid north is often a fraction of a degree off true north, so
     * tip labels collide and become unreadable exactly where precision matters.
     */
    const legendX = maxX + mm(4);
    const lineH = labelPx * 1.35;
    const legendTop = originY - armPx + labelPx;

    arms.forEach((arm, i) => {
        parts.push(`<text x="${legendX.toFixed(1)}" y="${(legendTop + i * lineH).toFixed(1)}"`
            + ` font-family="${FONT}" font-size="${labelPx.toFixed(1)}" fill="#111">`
            + `<tspan font-weight="700">${arm.key}</tspan>`
            + `<tspan> ${arm.text}</tspan></text>`);
    });

    const note = dec.expired ? `${dec.model} EXPIRED — verify` : dec.model;
    parts.push(`<text x="${legendX.toFixed(1)}" y="${(legendTop + arms.length * lineH + notePx * 0.4).toFixed(1)}"`
        + ` font-family="${FONT}" font-size="${notePx.toFixed(1)}"`
        + ` fill="${dec.expired ? '#a11' : '#777'}">${note}</text>`);

    const left = -armPx * 0.3;
    const widthPx = (legendX - left) + mm(26);

    return {
        svg: `<g class="north">${parts.join('')}</g>`,
        widthPx,
        heightPx,
        viewBox: `${left.toFixed(1)} 0 ${widthPx.toFixed(1)} ${heightPx.toFixed(1)}`,
    };
}
