/**
 * Which icon ids the features on the map actually ask for.
 *
 * Pure, so it can be tested without a browser.
 *
 * The style text is not enough. CloudTAK's symbol layers choose an icon from a
 * feature property --
 *
 *     'icon-image': ['case', ..., ['concat', ['get','icon'], '-colored-', ...],
 *                                  ['get','icon']]
 *
 * -- so the id appears in the layer only as the NAME of a property. When the
 * features come from inline GeoJSON the ids are at least somewhere in the style
 * document; when they come from a vector tile source they are nowhere in it at
 * all. A map that preloads an image per CoT type then has thousands in its pool
 * and no way to tell which few matter, and picking by text ships the inline ones
 * and silently drops the rest. That is the difference between an icon that prints
 * and one that does not.
 */

/** Property names an expression reads with ["get", "..."]. */
export function propertiesRead(expression: unknown, into = new Set<string>()): Set<string> {
    if (!Array.isArray(expression)) return into;

    if (expression[0] === 'get' && typeof expression[1] === 'string') {
        into.add(expression[1]);
    }

    for (const part of expression) propertiesRead(part, into);

    return into;
}

export type IconLayer = {
    id: string;
    type?: string;
    source?: string;
    'source-layer'?: string;
    layout?: Record<string, unknown>;
};

/** Symbol layers that pick their icon from the data, with the source to ask. */
export function iconSources(layers: IconLayer[]): Array<{
    source: string;
    sourceLayer?: string;
    properties: string[];
}> {
    const out: Array<{ source: string; sourceLayer?: string; properties: string[] }> = [];

    for (const layer of layers) {
        if (layer.type !== 'symbol' || !layer.source) continue;

        const icon = layer.layout?.['icon-image'];
        if (icon === undefined) continue;

        const properties = [...propertiesRead(icon)];
        if (!properties.length) continue;

        out.push({
            source: layer.source,
            sourceLayer: layer['source-layer'],
            properties,
        });
    }

    return out;
}

/** Icon ids carried by these features, read from the named properties. */
export function iconIdsFrom(
    features: Array<{ properties?: Record<string, unknown> | null }>,
    properties: string[],
    into = new Set<string>(),
): Set<string> {
    for (const feature of features) {
        const bag = feature.properties;
        if (!bag) continue;

        for (const name of properties) {
            const value = bag[name];
            if (typeof value === 'string' && value) into.add(value);
        }
    }

    return into;
}
