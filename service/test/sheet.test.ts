import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetHtml, formatScale } from '../lib/sheet.js';
import { sheet as geometry } from '../lib/paper.js';

const build = (over: Partial<Parameters<typeof sheetHtml>[0]['meta']> = {}, warnings?: string[]) => {
    const g = geometry('tabloid', 'portrait');
    return sheetHtml({
        map: Buffer.alloc(0),
        sheet: g.sheet,
        frame: g.frame,
        meta: {
            title: 'Assignment 3 — North Drainage',
            incident: '24-0417',
            scale: 24000,
            generated: '2026-09-04T23:05:00.000Z',
            dpi: 200,
            warnings,
            ...over,
        },
    });
};

test('scale is formatted the way it is spoken and printed', () => {
    assert.equal(formatScale(24000), '1:24,000');
    assert.equal(formatScale(6000), '1:6,000');
    assert.equal(formatScale(100000), '1:100,000');
});

test('the page is declared at real paper inches, so nothing scales the map', () => {
    // If @page did not match the sheet, a printed inch would no longer be
    // `scale` inches on the ground and every measurement off the sheet is wrong.
    assert.match(build(), /@page\s*\{\s*size:\s*11in 17in;/);
});

test('the map image is sized to the frame in inches, not pixels', () => {
    const html = build();
    const g = geometry('tabloid', 'portrait');

    assert.match(html, new RegExp(`width:\\s*${g.frame.width}in`));
    assert.match(html, new RegExp(`height:\\s*${g.frame.height}in`));
});

test('the title block carries what someone needs weeks later', () => {
    const html = build({ author: 'P. Clifton' });

    assert.match(html, /Assignment 3/);
    assert.match(html, /24-0417/);
    assert.match(html, /1:24,000/);
    assert.match(html, /WGS 84/);
    assert.match(html, /2026-09-04 23:05Z/);
    assert.match(html, /P\. Clifton/);
});

test('optional fields are omitted rather than left blank', () => {
    const html = build({ incident: undefined, author: undefined });

    assert.doesNotMatch(html, /Incident/);
    assert.doesNotMatch(html, /Author/);
    assert.match(html, /Scale/, 'the fields that always apply must still be there');
});

test('a sheet rendered with failures is marked on the paper, not only in the API', () => {
    // A field team holding the sheet cannot see the job status, so an incomplete
    // render has to say so on the page itself.
    const html = build({}, ['source 4 omitted', 'request failed']);

    assert.match(html, /INCOMPLETE/);
    assert.match(html, /2 source\(s\)/);
});

test('a clean sheet carries no caution', () => {
    assert.doesNotMatch(build({}, []), /INCOMPLETE/);
});

test('titles are escaped, not injected', () => {
    const html = build({ title: '<script>alert(1)</script> & "quotes"' });

    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&amp;/);
});

test('landscape swaps the page declaration', () => {
    const g = geometry('ansi-d', 'landscape');
    const html = sheetHtml({
        map: Buffer.alloc(0),
        sheet: g.sheet,
        frame: g.frame,
        meta: { title: 'x', scale: 24000, generated: '2026-09-04T23:05:00.000Z' },
    });

    assert.match(html, /@page\s*\{\s*size:\s*34in 22in;/);
});
