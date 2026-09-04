import test from 'node:test';
import assert from 'node:assert/strict';
import { forPrint, scaleNumeric, floorNumeric } from '../lib/cartography.js';

const OPTS = { markScale: 2, minLineMm: 0.2, layoutDpi: 200, lineOpacityBoost: 1 };
// 0.2mm at 200 css px/inch
const MIN_PX = (0.2 / 25.4) * 200;

test('numeric properties scale in every form MapLibre allows', () => {
    assert.equal(scaleNumeric(0.6, 2, 1), 1.2);
    assert.deepEqual(
        scaleNumeric({ base: 1.2, stops: [[11, 0.7], [16, 1.1]] }, 2, 1),
        { base: 1.2, stops: [[11, 1.4], [16, 2.2]] },
    );
    // Expressions may be data-driven, so they are wrapped rather than evaluated.
    assert.deepEqual(scaleNumeric(['get', 'w'], 2, 1), ['*', ['get', 'w'], 2]);
    // An absent property still has a spec default that must be scaled.
    assert.equal(scaleNumeric(undefined, 2, 1), 2);
});

test('a floor applies to every form too', () => {
    assert.equal(floorNumeric(0.5, 1.5), 1.5);
    assert.equal(floorNumeric(3, 1.5), 3);
    assert.deepEqual(floorNumeric(['get', 'w'], 1.5), ['max', ['get', 'w'], 1.5]);
    assert.deepEqual(
        floorNumeric({ stops: [[11, 0.2], [16, 4]] }, 1.5),
        { stops: [[11, 1.5], [16, 4]] },
    );
});

test('the contour hairline that vanished on paper is brought up to the floor', () => {
    // The real case: 26-Contour_12/0 is line-width 0.6, which is 0.16mm at 96dpi.
    const style = {
        layers: [{ id: 'contour', type: 'line', paint: { 'line-width': 0.6 } }],
    };

    forPrint(style, OPTS);

    const width = (style.layers[0].paint as Record<string, number>)['line-width'];
    assert.equal(width, MIN_PX);
    assert.ok((width / OPTS.layoutDpi) * 25.4 >= 0.2, 'must print at least 0.2mm');
});

test('a line already thick enough is scaled, not floored', () => {
    const style = { layers: [{ id: 'road', type: 'line', paint: { 'line-width': 4 } }] };

    forPrint(style, OPTS);

    assert.equal((style.layers[0].paint as Record<string, number>)['line-width'], 8);
});

test('text and icons keep their physical size', () => {
    const style = {
        layers: [{ id: 'labels', type: 'symbol', layout: { 'text-size': 12, 'icon-size': 1 } }],
    };

    forPrint(style, OPTS);

    const layout = style.layers[0].layout as Record<string, number>;
    assert.equal(layout['text-size'], 24);
    assert.equal(layout['icon-size'], 2);
});

test('a line with no explicit width still gets a printable one', () => {
    const style = { layers: [{ id: 'bare', type: 'line', paint: {} }] };

    forPrint(style, OPTS);

    // Spec default is 1px; scaled to 2, which already clears the floor.
    assert.equal((style.layers[0].paint as Record<string, number>)['line-width'], 2);
});

test('circle radius and stroke scale together', () => {
    const style = {
        layers: [{ id: 'cot', type: 'circle', paint: { 'circle-radius': 5, 'circle-stroke-width': 1 } }],
    };

    forPrint(style, OPTS);

    const paint = style.layers[0].paint as Record<string, number>;
    assert.equal(paint['circle-radius'], 10);
    assert.equal(paint['circle-stroke-width'], 2);
});

test('opacity is left alone unless a boost is asked for', () => {
    const style = { layers: [{ id: 'c', type: 'line', paint: { 'line-width': 2, 'line-opacity': 0.5 } }] };

    forPrint(style, { ...OPTS, lineOpacityBoost: 1 });
    assert.equal((style.layers[0].paint as Record<string, number>)['line-opacity'], 0.5);

    forPrint(style, { ...OPTS, lineOpacityBoost: 1.5 });
    assert.equal((style.layers[0].paint as Record<string, number>)['line-opacity'], 0.75);
});

test('a boost never pushes opacity past fully opaque', () => {
    const style = { layers: [{ id: 'c', type: 'line', paint: { 'line-width': 2, 'line-opacity': 0.9 } }] };

    forPrint(style, { ...OPTS, lineOpacityBoost: 4 });

    assert.equal((style.layers[0].paint as Record<string, number>)['line-opacity'], 1);
});

test('a scale of 1 with no floor leaves the style untouched', () => {
    const style = { layers: [{ id: 'a', type: 'line', paint: { 'line-width': 0.6 } }] };

    const { adjusted } = forPrint(style, { markScale: 1, minLineMm: 0, layoutDpi: 96 });

    assert.equal(adjusted, 0);
    assert.equal((style.layers[0].paint as Record<string, number>)['line-width'], 0.6);
});
