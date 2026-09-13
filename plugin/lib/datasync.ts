/**
 * Which Data Syncs may receive a map, and where to send it.
 *
 * Deliberately free of CloudTAK imports. Everything here is decided from plain
 * values, which is what lets service/test/parity cover it — lib/missions.ts
 * cannot be loaded outside CloudTAK's tree, because it reaches into the client's
 * own subscription store.
 */

export type MissionTarget = {
    guid: string;
    name: string;
};

/**
 * Management Data Syncs are for coordination traffic, not map products, and a
 * sheet landing in one is noise for everybody subscribed to it. They are
 * recognised by name because that is the only thing that distinguishes them —
 * nothing on a mission records what it is for.
 */
export function sendable<T extends MissionTarget>(list: T[]): T[] {
    return list.filter((mission) => {
        return !/MGMT/i.test(mission.name);
    });
}

/**
 * The upload endpoint for one Data Sync.
 *
 * The `name` query parameter is not optional: CloudTAK's route reads it to name
 * the file on TAK Server, and omitting it fails schema validation rather than
 * defaulting to anything. The guid is escaped because the path is built by hand
 * and a slash in one would silently retarget the request at another route.
 */
export function uploadUrl(base: string, guid: string, name: string): string {
    const url = new URL(
        `${String(base).replace(/\/$/, '')}/api/marti/missions/${encodeURIComponent(guid)}/upload`,
    );

    url.searchParams.set('name', name);

    return url.toString();
}
