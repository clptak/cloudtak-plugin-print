import Subscription from '../../../src/base/subscription.ts';
import { serverUrl, getRuntimeToken } from '../../../src/std.ts';

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
