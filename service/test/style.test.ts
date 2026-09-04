import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteStyle } from '../lib/style.js';

const OPTS = {
    apiInternalUrl: 'http://cloudtak-api:5000',
    tilesInternalUrl: 'http://cloudtak-tiles:5002',
    apiPublicHost: 'cloudtak.ccsosar.net',
    tilesPublicHost: 'tiles.cloudtak.ccsosar.net',
    allowHosts: ['basemap.nationalmap.gov'],
};

const base = () => ({
    version: 8,
    glyphs: 'https://cloudtak.ccsosar.net/api/fonts/{fontstack}/{range}.pbf?token=abc',
    sprite: [{ id: 'default', url: 'cloudtak-sprite://default' }],
    sources: {} as Record<string, unknown>,
    layers: [] as Array<Record<string, unknown>>,
});

test('the browser-only sprite protocol becomes the API endpoint the client falls back to', () => {
    const { style } = rewriteStyle(base(), OPTS);

    assert.deepEqual(style.sprite, [
        { id: 'default', url: 'http://cloudtak-api:5000/api/iconset/default/sprite' },
    ]);
});

test('glyphs are rewritten to the internal API with placeholders and token intact', () => {
    const { style } = rewriteStyle(base(), OPTS);

    assert.equal(
        style.glyphs,
        'http://cloudtak-api:5000/api/fonts/{fontstack}/{range}.pbf?token=abc',
    );
});

test('tile URLs on the public tiles host are rewritten to the internal tile service', () => {
    const style = base();
    style.sources.basemap = {
        type: 'raster',
        tiles: ['https://tiles.cloudtak.ccsosar.net/tiles/public/topo/tiles/{z}/{x}/{y}.png?token=abc'],
    };

    const { style: out, warnings } = rewriteStyle(style, OPTS);

    assert.deepEqual(warnings, []);
    assert.deepEqual((out.sources as Record<string, { tiles: string[] }>).basemap.tiles, [
        'http://cloudtak-tiles:5002/tiles/public/topo/tiles/{z}/{x}/{y}.png?token=abc',
    ]);
});

test('an allowlisted third-party host is left alone, not rewritten', () => {
    const style = base();
    style.sources.usgs = {
        type: 'raster',
        tiles: ['https://basemap.nationalmap.gov/arcgis/tile/{z}/{y}/{x}'],
    };

    const { style: out, warnings } = rewriteStyle(style, OPTS);

    assert.deepEqual(warnings, []);
    assert.deepEqual((out.sources as Record<string, { tiles: string[] }>).usgs.tiles, [
        'https://basemap.nationalmap.gov/arcgis/tile/{z}/{y}/{x}',
    ]);
});

test('a subdomain of an allowlisted host is permitted', () => {
    const style = base();
    style.sources.usgs = { type: 'raster', tiles: ['https://a.basemap.nationalmap.gov/{z}/{y}/{x}'] };

    assert.deepEqual(rewriteStyle(style, OPTS).warnings, []);
});

test('an unlisted host is dropped with a warning, never fetched', () => {
    const style = base();
    style.sources.sketchy = { type: 'raster', tiles: ['https://evil.example.com/{z}/{x}/{y}.png'] };
    style.layers = [{ id: 'sketchy-layer', type: 'raster', source: 'sketchy' }];

    const { style: out, warnings } = rewriteStyle(style, OPTS);

    assert.equal(Object.keys(out.sources as object).length, 0);
    assert.equal((out.layers as unknown[]).length, 0, 'orphaned layers must go too, or the style is rejected');
    assert.match(warnings[0], /sketchy.*allowlist.*evil\.example\.com/);
});

test('internal docker hostnames are not reachable from a submitted style', () => {
    const style = base();
    style.sources.probe = { type: 'raster', tiles: ['http://cloudtak-postgis:5432/{z}/{x}/{y}'] };

    const { warnings } = rewriteStyle(style, OPTS);

    assert.match(warnings[0], /allowlist/);
});

test('inline GeoJSON overlays pass through untouched', () => {
    const style = base();
    const data = { type: 'FeatureCollection', features: [] };
    style.sources.cot = { type: 'geojson', data };

    const { style: out, warnings } = rewriteStyle(style, OPTS);

    assert.deepEqual(warnings, []);
    assert.deepEqual((out.sources as Record<string, { data: unknown }>).cot.data, data);
});

test('an unresolved browser-only protocol is called out by name, not lumped in with bad hosts', () => {
    const style = base();
    // Every CloudTAK overlay is fronted by this protocol, resolved from Dexie.
    style.sources.overlay12 = { type: 'vector', url: 'cloudtak-tilejson://12' };
    style.layers = [{ id: 'overlay12-line', type: 'line', source: 'overlay12' }];

    const { style: out, warnings } = rewriteStyle(style, OPTS);

    assert.equal(Object.keys(out.sources as object).length, 0);
    assert.equal((out.layers as unknown[]).length, 0);
    assert.match(warnings[0], /'cloudtak-tilejson:\/\/' is a browser-only protocol/);
    assert.match(warnings[0], /plugin must resolve it/);
});

test('the input style is not mutated', () => {
    const style = base();
    const before = JSON.stringify(style);

    rewriteStyle(style, OPTS);

    assert.equal(JSON.stringify(style), before);
});
