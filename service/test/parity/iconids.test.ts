import test from 'node:test';
import assert from 'node:assert/strict';
import { propertiesRead, iconSources, iconIdsFrom } from '../../../plugin/lib/iconids.js';

/**
 * Measured on a live CloudTAK map: pool 3301, shipped 30, and all 3271 missing
 * were bare CoT types -- ids that appear nowhere in the style document because
 * their features come from a vector tile source, and that match no on-demand
 * grammar. Selecting by style text shipped the inline ones and dropped the rest,
 * so some icons printed and some did not.
 */

// CloudTAK's real icon-image expression, from api/web/src/utils/styles.ts.
const ICON_IMAGE = [
    'case',
    ['all', ['has', 'marker-color'], ['!=', ['slice', ['get', 'icon'], 0, 4], '2525']],
    ['concat', ['get', 'icon'], '-colored-', ['slice', ['get', 'marker-color'], 1]],
    ['get', 'icon'],
];

test('the property a layer reads its icon from is found inside the expression', () => {
    const props = propertiesRead(ICON_IMAGE);

    assert.ok(props.has('icon'));
    assert.ok(props.has('marker-color'));
});

test('symbol layers are paired with the source to ask', () => {
    const queries = iconSources([
        { id: 'cot', type: 'symbol', source: 'cot-source', layout: { 'icon-image': ICON_IMAGE } },
        { 'id': 'tiles', 'type': 'symbol', 'source': 'vec', 'source-layer': 'points', 'layout': { 'icon-image': ICON_IMAGE } },
        { id: 'roads', type: 'line', source: 'basemap' },
        { id: 'labels', type: 'symbol', source: 'basemap', layout: { 'text-field': 'x' } },
        { id: 'fixed', type: 'symbol', source: 'basemap', layout: { 'icon-image': 'course' } },
    ]);

    assert.equal(queries.length, 2, 'only data-driven symbol layers need querying');
    assert.deepEqual(queries[0], { source: 'cot-source', sourceLayer: undefined, properties: ['icon', 'marker-color'] });
    assert.equal(queries[1].sourceLayer, 'points', 'a vector source carries its source-layer');
});

test('ids come off the features, including tile-backed ones', () => {
    // These are exactly the shapes that were being dropped.
    const features = [
        { properties: { icon: 'a-f-G-U-C-I' } },
        { properties: { 'icon': 'a-h-G-E-W-M-A-T-R', 'marker-color': '#FF0000' } },
        { properties: { icon: '2525E:10041000000000000000' } },
        { properties: null },
        { properties: { icon: '' } },
        { properties: { icon: 42 } },
    ];

    const ids = iconIdsFrom(features, ['icon']);

    assert.ok(ids.has('a-f-G-U-C-I'), 'a bare CoT type must be collected');
    assert.ok(ids.has('a-h-G-E-W-M-A-T-R'));
    assert.ok(ids.has('2525E:10041000000000000000'));
    assert.equal(ids.size, 3, 'empty, missing and non-string values are skipped');
});

test('collection accumulates across sources', () => {
    const into = new Set<string>(['already-there']);

    iconIdsFrom([{ properties: { icon: 'a-f-G' } }], ['icon'], into);
    iconIdsFrom([{ properties: { icon: 'a-u-G' } }], ['icon'], into);

    assert.deepEqual([...into].sort(), ['a-f-G', 'a-u-G', 'already-there']);
});

test('a layer with no icon-image is not queried', () => {
    assert.equal(iconSources([{ id: 'x', type: 'symbol', source: 's' }]).length, 0);
});
