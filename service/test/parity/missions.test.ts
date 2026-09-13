import test from 'node:test';
import assert from 'node:assert/strict';
import { sendable, uploadUrl } from '../../../plugin/lib/datasync.js';

/**
 * Real Data Sync names from a CCSO server: the management syncs are
 * distinguished by name and nothing else, so the filter has to read names.
 */
const LIST = [
    { guid: 'a', name: 'Oak Creek Search' },
    { guid: 'b', name: 'CCSO MGMT' },
    { guid: 'c', name: 'SAR Ops' },
    { guid: 'd', name: 'Region 2 Mgmt Coordination' },
    { guid: 'e', name: 'Management Team' },
];

test('MGMT Data Syncs are not offered as a destination', () => {
    const names = sendable(LIST).map(m => m.name);

    assert.deepEqual(names, ['Oak Creek Search', 'SAR Ops', 'Management Team']);
});

test('the match is case-insensitive, and "management" spelled out is not MGMT', () => {
    // "Mgmt" and "MGMT" are the same abbreviation and both go. A sync spelled
    // "Management" does NOT contain the substring and is kept -- pinned here
    // because it is the first thing someone will assume works, and widening the
    // pattern should be a decision rather than a surprise.
    assert.equal(sendable([{ guid: 'x', name: 'mgmt' }]).length, 0);
    assert.equal(sendable([{ guid: 'x', name: 'MGMT' }]).length, 0);
    assert.equal(sendable([{ guid: 'x', name: 'CCSO-Mgmt-2026' }]).length, 0);
    assert.equal(sendable([{ guid: 'x', name: 'Management Team' }]).length, 1);
});

test('an empty list stays empty rather than throwing', () => {
    assert.deepEqual(sendable([]), []);
});

test('the upload URL carries the name CloudTAK requires', () => {
    const url = uploadUrl('https://cloudtak.example.org', 'GUID-1', 'oak-creek-24000-20260913T1530Z-preview.pdf');

    assert.equal(
        url,
        'https://cloudtak.example.org/api/marti/missions/GUID-1/upload'
        + '?name=oak-creek-24000-20260913T1530Z-preview.pdf',
    );
});

test('a trailing slash on the server URL does not double up', () => {
    assert.match(uploadUrl('https://cloudtak.example.org/', 'g', 'x.pdf'), /org\/api\/marti/);
});

test('a guid with URL-significant characters is escaped', () => {
    // Mission guids are UUIDs in practice, but the path is built by hand and a
    // slash in one would silently retarget the request at another route.
    assert.match(uploadUrl('https://h', 'a/b', 'x.pdf'), /missions\/a%2Fb\/upload/);
});
