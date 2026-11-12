import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTPUTS, formatFor, outputName } from '../../../plugin/lib/output.js';

test('every output label maps to its own format', () => {
    for (const [label, format] of OUTPUTS) assert.equal(formatFor(label), format);
    assert.equal(formatFor('something stale from an old build'), 'pdf');
});

test('the extension follows the format, because the importer routes on it', () => {
    assert.equal(outputName('Oak Creek Search', 24000, 'pdf'), 'oak-creek-search-24000.pdf');
    assert.equal(outputName('Oak Creek Search', 24000, 'tif'), 'oak-creek-search-24000.tif');
    assert.equal(outputName('Oak Creek', 6000, 'tif', '-20261111T1200Z'), 'oak-creek-6000-20261111T1200Z.tif');
});

test('an untitled or unprintable title still names the file', () => {
    assert.equal(outputName('', 24000, 'tif'), 'map-24000.tif');
    assert.equal(outputName('   ', 24000, 'pdf'), 'map-24000.pdf');
    assert.equal(outputName('!!!', 24000, 'pdf'), 'map-24000.pdf');
});
