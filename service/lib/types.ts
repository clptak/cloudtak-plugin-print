import { Type, type Static } from '@sinclair/typebox';
import { PAPER_SIZES } from './paper.js';

/**
 * The job request contract. Phase 1 validates the whole shape but only acts on a
 * subset; the rest is here so the plugin and service agree on it from the start.
 */
export const PrintRequest = Type.Object({
    title: Type.String({ minLength: 1, maxLength: 200 }),
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

    /** MapLibre style document, exactly as the client currently has it. */
    style: Type.Optional(Type.Record(Type.String(), Type.Unknown())),

    /** Overlay FeatureCollections, in draw order. */
    overlays: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),

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
    pixels: Type.Object({ width: Type.Integer(), height: Type.Integer() }),
    /** Why the requested DPI was lowered, if it was. */
    clampedBy: Type.Union([Type.Literal('none'), Type.Literal('ceiling'), Type.Literal('texture')]),
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
    /** Presigned URL to the finished artifact. Absent until complete. */
    url: Type.Optional(Type.String()),
});

export type JobStatusType = Static<typeof JobStatus>;
