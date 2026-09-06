import test from 'node:test';
import assert from 'node:assert/strict';
import {
    stripPluginLayers,
    isPluginLayer,
    SHEET_BOX_SOURCE,
    SHEET_BOX_LAYERS,
} from '../../../plugin/lib/printlayers.js';

/**
 * The harvest captures the live style, which contains the sheet box the plugin put
 * on the map. Its translucent blue fill covers exactly the print area, so a sheet
 * printed with it came out washed blue with a rectangle where the box edge fell.
 *
 * Lives under test/parity because it reaches into plugin/, which is not in the
 * service's Docker build context.
 */

function styleWithBox() {
    return {
        sources: {
            basemap: { type: 'vector', tiles: ['https://example/{z}/{x}/{y}'] },
            [SHEET_BOX_SOURCE]: { type: 'geojson', data: {} },
        },
        layers: [
            { id: 'contours', type: 'line', source: 'basemap' },
            { id: SHEET_BOX_LAYERS[0], type: 'fill', source: SHEET_BOX_SOURCE },
            { id: 'labels', type: 'symbol', source: 'basemap' },
            { id: SHEET_BOX_LAYERS[1], type: 'line', source: SHEET_BOX_SOURCE },
        ],
    } as Record<string, unknown>;
}

test('the sheet box never reaches the sheet', () => {
    const style = styleWithBox();
    const removed = stripPluginLayers(style);

    assert.deepEqual(removed, { layers: 2, sources: 1 });

    const ids = (style.layers as Array<{ id: string }>).map(l => l.id);
    assert.deepEqual(ids, ['contours', 'labels'], 'map layers must survive untouched');

    assert.ok(!(SHEET_BOX_SOURCE in (style.sources as Record<string, unknown>)));
    assert.ok('basemap' in (style.sources as Record<string, unknown>));
});

test('a plugin layer added later is stripped without being listed here', () => {
    // Matching on the prefix rather than the known ids means a rubber band or a
    // preview outline added later cannot leak onto a sheet by being forgotten.
    const style = {
        sources: { 'cloudtak-print-preview': { type: 'geojson' } },
        layers: [{ id: 'cloudtak-print-preview-outline', type: 'line' }],
    } as Record<string, unknown>;

    assert.deepEqual(stripPluginLayers(style), { layers: 1, sources: 1 });
    assert.equal((style.layers as unknown[]).length, 0);
});

test('a style with nothing of ours is left alone', () => {
    const style = {
        sources: { basemap: { type: 'vector' } },
        layers: [{ id: 'contours', type: 'line' }],
    } as Record<string, unknown>;

    assert.deepEqual(stripPluginLayers(style), { layers: 0, sources: 0 });
    assert.equal((style.layers as unknown[]).length, 1);
});

test('only our own prefix counts', () => {
    assert.ok(isPluginLayer('cloudtak-print-sheet-fill'));
    assert.ok(!isPluginLayer('cloudtak-tilejson-overlay'));
    assert.ok(!isPluginLayer('print-shop'));
    assert.ok(!isPluginLayer(undefined));
});
