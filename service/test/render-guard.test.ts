import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedHosts, isPermittedUrl } from '../lib/render.js';

const OPTS = {
    apiInternalUrl: 'http://cloudtak-api:5000',
    tilesInternalUrl: 'http://cloudtak-tiles:5002',
    allowHosts: ['basemap.nationalmap.gov'],
};

test('the allowlist is the internal services plus explicitly named hosts, ports stripped', () => {
    assert.deepEqual(allowedHosts(OPTS), [
        'cloudtak-api',
        'cloudtak-tiles',
        'basemap.nationalmap.gov',
    ]);
});

test('the internal services and allowlisted hosts are reachable', () => {
    const allow = allowedHosts(OPTS);

    assert.ok(isPermittedUrl('http://cloudtak-api:5000/api/fonts/Open%20Sans/0-255.pbf', allow));
    assert.ok(isPermittedUrl('http://cloudtak-tiles:5002/tiles/public/a/1/2/3.png', allow));
    assert.ok(isPermittedUrl('https://basemap.nationalmap.gov/arcgis/tile/1/2/3', allow));
    assert.ok(isPermittedUrl('https://a.basemap.nationalmap.gov/tile/1/2/3', allow));
});

test('a TileJSON that redirects tiles to an unlisted host is still blocked', () => {
    // The case the style rewriter cannot see: the source URL was allowed, but the
    // document it returned names tiles somewhere else.
    const allow = allowedHosts(OPTS);

    assert.equal(isPermittedUrl('https://evil.example.com/1/2/3.png', allow), false);
});

test('other services on the docker network are not reachable', () => {
    const allow = allowedHosts(OPTS);

    for (const url of [
        'http://cloudtak-postgis:5432/',
        'http://cloudtak-store:9000/cloudtak/',
        'http://takserver-5.6-RELEASE-22:8443/',
        'http://authentik-server-1:9000/',
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost:5010/print-api/jobs',
    ]) {
        assert.equal(isPermittedUrl(url, allow), false, url);
    }
});

test('non-http schemes are refused outright', () => {
    const allow = allowedHosts(OPTS);

    assert.equal(isPermittedUrl('file:///etc/passwd', allow), false);
    assert.equal(isPermittedUrl('ws://cloudtak-api:5000/', allow), false);
    assert.equal(isPermittedUrl('not a url', allow), false);
});

test('a lookalike host does not match by suffix', () => {
    const allow = allowedHosts(OPTS);

    // 'notbasemap.nationalmap.gov.evil.com' must not pass by containing the name.
    assert.equal(isPermittedUrl('https://basemap.nationalmap.gov.evil.com/x', allow), false);
    assert.equal(isPermittedUrl('https://xbasemap.nationalmap.gov/x', allow), false);
});

test('an empty allowlist permits nothing external', () => {
    const allow = allowedHosts({ ...OPTS, allowHosts: [] });

    assert.equal(isPermittedUrl('https://basemap.nationalmap.gov/x', allow), false);
    assert.ok(isPermittedUrl('http://cloudtak-tiles:5002/x', allow));
});
