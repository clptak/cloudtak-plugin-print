/*
 * Harvest a print job payload from a live CloudTAK map.
 *
 * Paste this into the browser console on an open CloudTAK map. It downloads
 * print-job.json, which can be POSTed straight at /print-api/jobs.
 *
 * This is a stand-in for what the plugin will do in phase 5, and it exists now
 * because the render path cannot be trusted until it has drawn a real vector
 * basemap with real glyphs, sprites and overlays. It deliberately does the three
 * things that can only be done in the browser:
 *
 *   1. Resolve `cloudtak-tilejson://<id>` overlay sources to concrete tile URLs.
 *      MapLibre stores the resolved TileJSON on the source object once loaded, so
 *      this reads the live source rather than reaching into Dexie.
 *   2. Harvest sprite images. Most CoT icons are resolved lazily per id and are
 *      not in any sprite sheet, so without this the sheet renders without icons.
 *   3. Capture the style exactly as it currently is — layer visibility, filters,
 *      the user's own tweaks and all.
 *
 * It does NOT harvest your auth token. Mint one on the VPS instead.
 */
(async () => {
    const map =
        window.__map
        || window.map
        || (window.mapStore && window.mapStore.map)
        || (document.querySelector('.maplibregl-map') || {})._map;

    if (!map || typeof map.getStyle !== 'function') {
        console.error(
            'Could not find the MapLibre map on window. Open the CloudTAK map view first. '
            + 'If it is still not found, run:  window.__map = <your map reference>  and re-run this.',
        );
        return;
    }

    const style = JSON.parse(JSON.stringify(map.getStyle()));

    // ---- 1. Resolve browser-only source protocols -------------------------
    const resolved = [];
    const unresolved = [];

    for (const [id, source] of Object.entries(style.sources || {})) {
        const url = source.url;
        if (typeof url !== 'string' || !url.startsWith('cloudtak-')) continue;

        const live = map.getSource(id);
        const tiles = live && Array.isArray(live.tiles) ? live.tiles : null;

        if (tiles && tiles.length) {
            delete source.url;
            source.tiles = tiles;
            if (live.minzoom != null) source.minzoom = live.minzoom;
            if (live.maxzoom != null) source.maxzoom = live.maxzoom;
            if (live.bounds) source.bounds = live.bounds;
            if (live.scheme) source.scheme = live.scheme;
            resolved.push(`${id} (${url})`);
        } else {
            unresolved.push(`${id} (${url})`);
        }
    }

    // ---- 2. Harvest sprite images ----------------------------------------
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const toBase64 = (bytes) => {
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    };

    const images = [];
    let skipped = 0;

    for (const id of map.listImages()) {
        const image = map.getImage(id);
        if (!image) { skipped++; continue; }

        // MapLibre hands back either an RGBAImage-like object or a bitmap.
        const src = image.data || image.userImage || image;
        let width = src.width;
        let height = src.height;
        let data = src.data;

        if (!data && (src instanceof ImageBitmap || src instanceof HTMLImageElement)) {
            canvas.width = width = src.width;
            canvas.height = height = src.height;
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(src, 0, 0);
            data = ctx.getImageData(0, 0, width, height).data;
        }

        if (!data || !width || !height) { skipped++; continue; }

        images.push({
            id,
            width,
            height,
            data: toBase64(new Uint8Array(data.buffer || data)),
            pixelRatio: image.pixelRatio || 1,
            sdf: !!image.sdf,
        });
    }

    // ---- 3. Build the payload --------------------------------------------
    const center = map.getCenter();

    const payload = {
        title: 'Fidelity check',
        incident: 'dev',
        scale: 24000,
        paper: { size: 'tabloid', orientation: 'portrait' },
        center: [Number(center.lng.toFixed(6)), Number(center.lat.toFixed(6))],
        style,
        images,
    };

    const json = JSON.stringify(payload);

    console.log('%ccloudtak-print harvest', 'font-weight:bold');
    console.log('  sources:            ', Object.keys(style.sources || {}).length);
    console.log('  layers:             ', (style.layers || []).length);
    console.log('  overlays resolved:  ', resolved.length, resolved);
    if (unresolved.length) {
        console.warn('  OVERLAYS NOT RESOLVED (these will be dropped):', unresolved);
        console.warn('  They are probably not loaded yet — pan the map, wait, and re-run.');
    }
    console.log('  images harvested:   ', images.length, skipped ? `(${skipped} skipped)` : '');
    console.log('  payload:            ', (json.length / 1048576).toFixed(2), 'MB');
    console.log('  centre:             ', payload.center, ' zoom now:', map.getZoom().toFixed(2));

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'print-job.json';
    a.click();
    URL.revokeObjectURL(a.href);

    console.log('%cDownloaded print-job.json', 'color:green;font-weight:bold');
})();
