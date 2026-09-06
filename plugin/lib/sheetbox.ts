import type { Map, MapMouseEvent, MapTouchEvent, GeoJSONSource, LngLatBoundsLike } from 'maplibre-gl';
import { mercatorX, mercatorY, lngFrom, latFrom, corners, boundsOf } from './geometry.ts';
import type { SheetBoxState } from './geometry.ts';

/**
 * The sheet box: a rectangle on the map showing exactly what will land on paper.
 *
 * Because the sheet is north-up and its size is fully determined by scale, paper and
 * margins, the only free variable is position -- one point. So the whole interaction
 * is "drag the rectangle", and the rectangle is authoritative: what is inside it
 * prints, what is outside does not.
 *
 * The geometry lives in ./geometry.ts, which is pure and tested; this file is the
 * MapLibre binding and the drag.
 */

export type { SheetBoxState };

const SOURCE = 'cloudtak-print-sheet';
const FILL = 'cloudtak-print-sheet-fill';
const LINE = 'cloudtak-print-sheet-line';

function feature(state: SheetBoxState) {
    return {
        type: 'FeatureCollection' as const,
        features: [{
            type: 'Feature' as const,
            properties: {},
            geometry: {
                type: 'Polygon' as const,
                coordinates: [corners(state)],
            },
        }],
    };
}

export class SheetBox {
    private map: Map;
    private state: SheetBoxState;
    private onMove?: (center: [number, number]) => void;

    /** Mercator offset from the pointer to the box centre, held for the drag. */
    private grab: { x: number; y: number } | null = null;
    private added = false;

    constructor(map: Map, state: SheetBoxState, opts: { onMove?: (center: [number, number]) => void } = {}) {
        this.map = map;
        this.state = state;
        this.onMove = opts.onMove;

        this.add();
    }

    private add() {
        if (this.map.getSource(SOURCE)) this.remove();

        this.map.addSource(SOURCE, { type: 'geojson', data: feature(this.state) });

        this.map.addLayer({
            id: FILL,
            type: 'fill',
            source: SOURCE,
            paint: {
                'fill-color': '#0d6efd',
                // Low enough to read the map through, high enough to be an obvious
                // grab target on a tablet in daylight.
                'fill-opacity': 0.12,
            },
        });

        this.map.addLayer({
            id: LINE,
            type: 'line',
            source: SOURCE,
            paint: {
                'line-color': '#0d6efd',
                'line-width': 2,
            },
        });

        this.map.on('mouseenter', FILL, this.hoverOn);
        this.map.on('mouseleave', FILL, this.hoverOff);
        this.map.on('mousedown', FILL, this.pressMouse);
        this.map.on('touchstart', FILL, this.pressTouch);

        this.added = true;
    }

    private hoverOn = () => {
        this.map.getCanvas().style.cursor = 'move';
    };

    private hoverOff = () => {
        if (!this.grab) this.map.getCanvas().style.cursor = '';
    };

    private beginDrag(lng: number, lat: number) {
        this.grab = {
            x: mercatorX(this.state.center[0]) - mercatorX(lng),
            y: mercatorY(this.state.center[1]) - mercatorY(lat),
        };

        // Otherwise the map pans underneath the box being dragged.
        this.map.dragPan.disable();
        this.map.getCanvas().style.cursor = 'move';
    }

    private pressMouse = (event: MapMouseEvent) => {
        event.preventDefault();
        this.beginDrag(event.lngLat.lng, event.lngLat.lat);

        this.map.on('mousemove', this.dragMouse);
        this.map.once('mouseup', this.release);
    };

    private pressTouch = (event: MapTouchEvent) => {
        // A two-finger gesture is a map zoom, not a box drag.
        if (event.points.length !== 1) return;

        event.preventDefault();
        this.beginDrag(event.lngLat.lng, event.lngLat.lat);

        this.map.on('touchmove', this.dragTouch);
        this.map.once('touchend', this.release);
    };

    private moveTo(lng: number, lat: number) {
        if (!this.grab) return;

        const center: [number, number] = [
            lngFrom(mercatorX(lng) + this.grab.x),
            latFrom(mercatorY(lat) + this.grab.y),
        ];

        this.state = { ...this.state, center };
        this.draw();

        if (this.onMove) this.onMove(center);
    }

    private dragMouse = (event: MapMouseEvent) => {
        this.moveTo(event.lngLat.lng, event.lngLat.lat);
    };

    private dragTouch = (event: MapTouchEvent) => {
        this.moveTo(event.lngLat.lng, event.lngLat.lat);
    };

    private release = () => {
        this.grab = null;

        this.map.off('mousemove', this.dragMouse);
        this.map.off('touchmove', this.dragTouch);

        this.map.dragPan.enable();
        this.map.getCanvas().style.cursor = '';
    };

    private draw() {
        const source = this.map.getSource(SOURCE) as GeoJSONSource | undefined;
        if (source) source.setData(feature(this.state));
    }

    get center(): [number, number] {
        return this.state.center;
    }

    get bounds(): LngLatBoundsLike {
        return boundsOf(this.state);
    }

    update(state: Partial<SheetBoxState>) {
        this.state = { ...this.state, ...state };
        this.draw();
    }

    private remove() {
        for (const id of [FILL, LINE]) {
            if (this.map.getLayer(id)) this.map.removeLayer(id);
        }
        if (this.map.getSource(SOURCE)) this.map.removeSource(SOURCE);
    }

    destroy() {
        if (!this.added) return;

        this.release();

        this.map.off('mouseenter', FILL, this.hoverOn);
        this.map.off('mouseleave', FILL, this.hoverOff);
        this.map.off('mousedown', FILL, this.pressMouse);
        this.map.off('touchstart', FILL, this.pressTouch);

        this.remove();
        this.added = false;
    }
}
