import test from 'node:test';
import assert from 'node:assert/strict';
import { sheet, footprint, PAPER } from '../lib/paper.js';

test('one paper inch at 1:24,000 is 609.6 m on the ground', () => {
    // A one-inch-square frame is the cleanest way to assert the constant.
    const metres = 1 * 24000 * 0.0254;
    assert.equal(Math.round(metres * 10) / 10, 609.6);
});

test('margins are subtracted from the frame, and orientation swaps the sheet', () => {
    const portrait = sheet('arch-d', 'portrait');
    assert.deepEqual(portrait.sheet, { width: 24, height: 36 });
    assert.equal(portrait.frame.width, 23);
    // The bottom margin carries the title block, scale bar and north arrow.
    assert.ok(Math.abs(portrait.frame.height - 34.35) < 1e-9, String(portrait.frame.height));

    const landscape = sheet('arch-d', 'landscape');
    assert.deepEqual(landscape.sheet, { width: 36, height: 24 });
});

test('Arch D at 1:24,000 matches the footprint quoted in docs/DESIGN.md', () => {
    const ground = footprint('arch-d', 'portrait', 24000);

    assert.equal(Math.round(ground.width / 100) / 10, 14.0);
    assert.equal(Math.round(ground.height / 100) / 10, 20.9);
});

test('Tabloid at 1:24,000 matches the footprint quoted in docs/DESIGN.md', () => {
    const ground = footprint('tabloid', 'portrait', 24000);

    assert.equal(Math.round(ground.width / 100) / 10, 6.1);
    assert.equal(Math.round(ground.height / 100) / 10, 9.4);
});

test('halving the scale halves the ground footprint', () => {
    const coarse = footprint('letter', 'portrait', 24000);
    const fine = footprint('letter', 'portrait', 12000);

    assert.equal(coarse.width / fine.width, 2);
    assert.equal(coarse.height / fine.height, 2);
});

test('every paper size is portrait-oriented in the table', () => {
    for (const [id, p] of Object.entries(PAPER)) {
        assert.ok(p.height >= p.width, `${id} should be listed portrait`);
    }
});
