import Subscription from '../../../src/base/subscription.ts';
import { serverUrl, getRuntimeToken } from '../../../src/std.ts';
import { uploadUrl } from './datasync.ts';

/**
 * Data Syncs (Missions) and their invite QR codes.
 *
 * CloudTAK renders the invite QR itself, at
 * GET /api/marti/missions/{guid}/qr, as SVG. There is no reason to reimplement
 * it: the encoded string is a TAK quick-connect payload built from the server's
 * own configuration, and a second implementation would drift from the one people
 * already scan in the app.
 *
 * MissionInfo.vue reaches that endpoint with an <img src>, which cannot set
 * headers and so puts the token in the query string. A fetch can send the header
 * instead, and this is same-origin, so it costs no preflight.
 */

export type MissionOption = {
    guid: string;
    name: string;
};

/**
 * The Data Syncs this user is subscribed to, sorted by name.
 *
 * Read from the client's local database rather than the server: it is what the
 * rest of CloudTAK lists (see ShareToMission.vue), it needs no round trip, and it
 * cannot offer a mission whose invite the user could not fetch anyway.
 */
export async function missions(): Promise<MissionOption[]> {
    const local = await Subscription.localList({ role: 'MISSION_SUBSCRIBER' });

    return Array.from(local)
        .map((entry) => {
            return { guid: entry.guid, name: entry.name };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Attach a file to a Data Sync.
 *
 * Multipart, as CloudTAK's own Upload component sends it. Before CloudTAK
 * 13.122 this route took the raw bytes and read `content-length` off the
 * request; it now refuses anything but multipart/form-data with a 400. The
 * server stages the part to disk and hands it to TAK Server, so the browser no
 * longer has to send a known length.
 *
 * `name` still goes in the query string, where it overrides the multipart
 * filename -- the same name either way, but the query is what the route reads
 * first.
 *
 * No mission token is sent. The route falls back to the caller's own
 * subscription when the header is absent, and every mission in this list is one
 * the user is subscribed to with write access -- `missions()` filters on
 * MISSION_SUBSCRIBER, which excludes read-only subscribers.
 */
export async function attach(guid: string, file: Blob, name: string): Promise<void> {
    const token = await getRuntimeToken();

    const form = new FormData();
    form.append('file', file, name);

    const res = await fetch(uploadUrl(String(serverUrl), guid, name), {
        method: 'POST',
        // No Content-Type: the browser has to set it, boundary included.
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => {
            return '';
        });

        throw new Error(
            `The Data Sync refused the upload (${res.status})`
            + (detail ? `: ${detail.slice(0, 200)}` : ''),
        );
    }
}

/** The invite QR for one Data Sync, as SVG markup. */
export async function inviteQr(guid: string): Promise<string> {
    const token = await getRuntimeToken();

    const target = `${String(serverUrl).replace(/\/$/, '')}/api/marti/missions/${encodeURIComponent(guid)}/qr`;

    const res = await fetch(target, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (!res.ok) {
        throw new Error(`Could not fetch the invite QR for this Data Sync (${res.status})`);
    }

    const svg = await res.text();

    // The service validates this properly; this only catches an obvious wrong turn
    // -- an HTML error page, say -- while the user is still looking at the panel.
    if (!svg.includes('<svg')) {
        throw new Error('CloudTAK did not return an invite QR for this Data Sync');
    }

    return svg;
}
