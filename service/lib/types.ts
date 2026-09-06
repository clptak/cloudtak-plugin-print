import { Type, type Static } from '@sinclair/typebox';
import { PAPER_SIZES } from './paper.js';

/**
 * The job request contract. Phase 1 validates the whole shape but only acts on a
 * subset; the rest is here so the plugin and service agree on it from the start.
 */
export const PrintRequest = Type.Object({
    /** Optional: an untitled sheet prints without a title line rather than a placeholder. */
    title: Type.Optional(Type.String({ maxLength: 200 })),
    incident: Type.Optional(Type.String({ maxLength: 100 })),
    author: Type.Optional(Type.String({ maxLength: 100 })),

    /** Denominator only: 24000 means 1:24,000. */
    scale: Type.Integer({ minimum: 100, maximum: 5000000 }),

    paper: Type.Object({
        size: Type.Union(PAPER_SIZES.map((s) => {
            return Type.Literal(s);
        })),
        orientation: Type.Union([Type.Literal('portrait'), Type.Literal('landscape')]),
    }),

    /** Scale-first mode: [lng, lat] of the sheet centre. */
    center: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
    /** Fit-to-area mode: [w, s, e, n]. Mutually exclusive with `center`. */
    bbox: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()])),

    dpi: Type.Optional(Type.Integer({ minimum: 50, maximum: 600 })),

    /**
     * Render tiny and fail fast. Same style, same sources, same code path, but a
     * postcard-sized viewport and a short timeout — so diagnosing a stuck render
     * costs a minute instead of ten. Not for producing a sheet.
     */
    probe: Type.Optional(Type.Boolean()),

    /**
     * 'pdf' is the deliverable; 'png' returns the bare map raster and exists for
     * debugging the render without the page layout in the way.
     */
    format: Type.Optional(Type.Union([Type.Literal('pdf'), Type.Literal('png')])),

    /** MapLibre style document, exactly as the client currently has it. */
    style: Type.Optional(Type.Record(Type.String(), Type.Unknown())),

    /**
     * Sprite images harvested from the client's live map. CloudTAK resolves most
     * CoT icons lazily from Dexie, so without these the sheet renders with
     * missing icons. Base64 RGBA, width * height * 4 bytes.
     */
    images: Type.Optional(Type.Array(Type.Object({
        id: Type.String(),
        width: Type.Integer({ minimum: 1, maximum: 1024 }),
        height: Type.Integer({ minimum: 1, maximum: 1024 }),
        data: Type.String(),
        pixelRatio: Type.Optional(Type.Number({ minimum: 1, maximum: 4 })),
        sdf: Type.Optional(Type.Boolean()),
    }))),

    /** Feature data to apply to named style sources after load. */
    overlays: Type.Optional(Type.Array(Type.Object({
        source: Type.String(),
        data: Type.Record(Type.String(), Type.Unknown()),
    }))),

    /**
     * Mission invite QR, as SVG from CloudTAK's own
     * GET /api/marti/missions/{guid}/qr. The plugin fetches it in the browser,
     * where the session already has credentials; the service extracts geometry
     * only. See lib/qr.ts.
     */
    qr: Type.Optional(Type.Object({
        svg: Type.String({ maxLength: 200000 }),
        /** Data Sync name, printed under the code. */
        label: Type.Optional(Type.String({ maxLength: 100 })),
    })),

    furniture: Type.Optional(Type.Object({
        grid: Type.Optional(Type.Union([Type.Literal('utm'), Type.Literal('none')])),
        legend: Type.Optional(Type.Boolean()),
        declination: Type.Optional(Type.Boolean()),
        branding: Type.Optional(Type.String({ maxLength: 64 })),
    })),
});

export type PrintRequestType = Static<typeof PrintRequest>;

/**
 * The geometry the service derived from paper + orientation + scale + DPI.
 * Returned with the job so a caller can see exactly what was computed rather
 * than inferring it from a blank sheet.
 */
export const SheetGeometry = Type.Object({
    frameInches: Type.Object({ width: Type.Number(), height: Type.Number() }),
    groundMetres: Type.Object({ width: Type.Number(), height: Type.Number() }),
    dpi: Type.Integer(),
    /** CSS pixels per inch used for layout; equals dpi unless overridden. */
    layoutDpi: Type.Integer(),
    pixels: Type.Object({ width: Type.Integer(), height: Type.Integer() }),
    /** Why the requested DPI was lowered, if it was. */
    clampedBy: Type.Union([Type.Literal('none'), Type.Literal('ceiling'), Type.Literal('texture')]),
    /** Effective scale denominator — computed in fit-to-area mode, echoed otherwise. */
    scale: Type.Integer(),
    /** MapLibre zoom the renderer used, exact at the sheet's centre latitude. */
    zoom: Type.Number(),
});

export type SheetGeometryType = Static<typeof SheetGeometry>;

export const JobStatus = Type.Object({
    job: Type.String(),
    status: Type.Union([
        Type.Literal('queued'),
        Type.Literal('running'),
        Type.Literal('complete'),
        Type.Literal('failed'),
    ]),
    progress: Type.Number({ minimum: 0, maximum: 1 }),
    step: Type.Optional(Type.String()),
    created: Type.String(),
    error: Type.Optional(Type.String()),
    sheet: Type.Optional(SheetGeometry),
    /** Sources dropped or requests blocked. A blank map is never silent. */
    warnings: Type.Optional(Type.Array(Type.String())),
    /** Presigned URL to the finished artifact. Absent until complete. */
    url: Type.Optional(Type.String()),
});

export type JobStatusType = Static<typeof JobStatus>;
