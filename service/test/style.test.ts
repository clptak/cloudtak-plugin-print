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

test('the sprite declaration is dropped when harvested images are supplied', () => {
    // Every image the sheet would provide has already been added directly, so
    // fetching it is a redundant request that can only cost time or fail.
    const { style } = rewriteStyle(base(), { ...OPTS, hasImages: true });

    assert.equal(style.sprite, undefined);
});

test('the token is stamped onto rewritten CloudTAK URLs, not sent as a header', () => {
    const style = base();
    delete (style as { glyphs?: string }).glyphs;
    style.glyphs = 'https://cloudtak.ccsosar.net/api/fonts/{fontstack}/{range}.pbf';
    style.sources.hosted = {
        type: 'vector',
        tiles: ['https://tiles.cloudtak.ccsosar.net/tiles/public/a/tiles/{z}/{x}/{y}.mvt'],
    };

    const { style: out } = rewriteStyle(style, { ...OPTS, token: 'tok en' });

    assert.match(out.glyphs as string, /token=tok%20en$/);
    assert.match((out.sources as Record<string, { tiles: string[] }>).hosted.tiles[0], /token=tok%20en$/);
    assert.match((out.sprite as Array<{ url: string }>)[0].url, /\/api\/iconset\/default\/sprite\?token=tok%20en$/);
});

test('a stale token in a URL is replaced by the caller\'s, not preserved', () => {
    // The style is a snapshot: CloudTAK stamps tokens into tile URLs when it
    // builds TileJSON, and by submission time that token may be hours old. An
    // expired token on every tile URL fails the entire sheet.
    const { style } = rewriteStyle(base(), { ...OPTS, token: 'fresh' });

    // base() carries ?token=abc on its glyphs.
    assert.match(style.glyphs as string, /token=fresh$/);
    assert.doesNotMatch(style.glyphs as string, /abc/);
});

test('replacing a token does not mangle other query parameters', () => {
    const style = base();
    style.sources.hosted = {
        type: 'raster',
        tiles: ['https://tiles.cloudtak.ccsosar.net/t/{z}/{x}/{y}.png?token=old&ctdarkmode=false'],
    };

    const { style: out } = rewriteStyle(style, { ...OPTS, token: 'fresh' });
    const url = (out.sources as Record<string, { tiles: string[] }>).hosted.tiles[0];

    assert.match(url, /ctdarkmode=false/);
    assert.match(url, /token=fresh/);
    assert.doesNotMatch(url, /token=old/);
});

test('a third-party host never receives the CloudTAK token', () => {
    const style = base();
    style.sources.usgs = { type: 'raster', tiles: ['https://basemap.nationalmap.gov/{z}/{y}/{x}'] };

    const { style: out } = rewriteStyle(style, { ...OPTS, token: 'secret' });

    assert.equal(
        (out.sources as Record<string, { tiles: string[] }>).usgs.tiles[0],
        'https://basemap.nationalmap.gov/{z}/{y}/{x}',
    );
});

test('tokens are never echoed into warnings', () => {
    const style = base();
    style.glyphs = 'https://elsewhere.example.com/fonts/{fontstack}/{range}.pbf?token=SUPERSECRET';
    style.sources.tiles = {
        type: 'vector',
        tiles: ['https://elsewhere.example.com/{z}/{x}/{y}.mvt?token=SUPERSECRET&x=1'],
    };

    const { warnings } = rewriteStyle(style, OPTS);

    for (const warning of warnings) {
        assert.doesNotMatch(warning, /SUPERSECRET/, warning);
    }
    assert.match(warnings[0], /token=<redacted>/);
});

test('a dropped source says so is a config problem when the public hosts are unset', () => {
    const style = base();
    style.sources.cloudtak = { type: 'vector', tiles: ['https://map.example.com/{z}/{x}/{y}.mvt'] };

    const bare = { apiInternalUrl: OPTS.apiInternalUrl, tilesInternalUrl: OPTS.tilesInternalUrl };
    const { warnings } = rewriteStyle(style, bare);

    assert.match(warnings.join('\n'), /API_URL and PMTILES_URL/);
});

test('no configuration hint is added once the public hosts resolve', () => {
    const style = base();
    style.sources.sketchy = { type: 'raster', tiles: ['https://evil.example.com/{z}/{x}/{y}.png'] };

    const { warnings } = rewriteStyle(style, OPTS);

    assert.doesNotMatch(warnings.join('\n'), /API_URL and PMTILES_URL/);
});

test('an invalid scheme on a raster-dem source is stripped rather than failing the sheet', () => {
    // MapLibre rejects the whole style over one unknown property and does not say
    // which source it came from, so this must not reach it.
    const style = base();
    style.sources.dem = {
        type: 'raster-dem',
        tiles: ['https://tiles.cloudtak.ccsosar.net/dem/{z}/{x}/{y}.webp'],
        scheme: 'xyz',
        encoding: 'mapbox',
    };

    const { style: out, warnings } = rewriteStyle(style, OPTS);

    const dem = (out.sources as Record<string, Record<string, unknown>>).dem;
    assert.equal('scheme' in dem, false);
    assert.equal(dem.encoding, 'mapbox', 'valid properties must survive');
    assert.match(warnings.join('\n'), /raster-dem/);
});

test('scheme survives on the source types where it is valid', () => {
    const style = base();
    style.sources.vec = {
        type: 'vector',
        tiles: ['https://tiles.cloudtak.ccsosar.net/v/{z}/{x}/{y}.mvt'],
        scheme: 'tms',
    };

    const { style: out } = rewriteStyle(style, OPTS);

    assert.equal((out.sources as Record<string, Record<string, unknown>>).vec.scheme, 'tms');
});
