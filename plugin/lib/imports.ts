import { serverUrl, getRuntimeToken } from '../../../src/std.ts';

/**
 * Send a file to the user's own CloudTAK Imports.
 *
 * The same route CloudTAK's own upload dialog uses, PUT /api/import, as
 * multipart. The server creates the import row, writes the file to S3 and marks
 * it pending; the events worker picks it up from there and, for a GeoTIFF or a
 * GeoPDF, runs the GDAL transform that turns it into an overlay. Nothing on the
 * CloudTAK side changes.
 *
 * The import belongs to whoever is signed in. It is not shared with anyone until
 * they share it, which is why this is a button and not a side effect of Print.
 *
 * Returns the import's id, for linking to it in the Imports menu.
 */
export async function sendToImports(file: Blob, name: string): Promise<string> {
    const token = await getRuntimeToken();

    const form = new FormData();
    form.append('file', file, name);

    const res = await fetch(`${String(serverUrl).replace(/\/$/, '')}/api/import`, {
        method: 'PUT',
        // No Content-Type: the browser has to set it, boundary included.
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => {
            return '';
        });

        throw new Error(
            `CloudTAK refused the import (${res.status})`
            + (detail ? `: ${detail.slice(0, 200)}` : ''),
        );
    }

    const body = await res.json() as { imports?: Array<{ uid: string }> };
    const uid = body.imports?.[0]?.uid;

    if (!uid) throw new Error('CloudTAK accepted the upload but returned no import');

    return uid;
}
