import test from 'node:test';
import assert from 'node:assert/strict';
import config, { resetConfig } from '../lib/config.js';

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(values)) {
        previous.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    resetConfig();
    try {
        fn();
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        resetConfig();
    }
}

test('internal URL fallbacks are the stock CloudTAK service names', () => {
    withEnv(
        {
            SigningSecret: 'test-secret',
            API_INTERNAL_URL: undefined,
            TILES_INTERNAL_URL: undefined,
        },
        () => {
            const c = config();
            assert.equal(c.apiUrl, 'http://api:5000');
            assert.equal(c.tilesInternalUrl, 'http://tiles:5002');
        },
    );
});

test('API_INTERNAL_URL and TILES_INTERNAL_URL override the stock fallbacks', () => {
    withEnv(
        {
            SigningSecret: 'test-secret',
            API_INTERNAL_URL: 'http://cloudtak-api:5000',
            TILES_INTERNAL_URL: 'http://cloudtak-tiles:5002',
        },
        () => {
            const c = config();
            assert.equal(c.apiUrl, 'http://cloudtak-api:5000');
            assert.equal(c.tilesInternalUrl, 'http://cloudtak-tiles:5002');
        },
    );
});
