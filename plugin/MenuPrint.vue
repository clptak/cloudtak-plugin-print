<template>
    <MenuTemplate
        name='Print Map'
        :loading='loading'
    >
        <template #default>
            <TablerAlert
                v-if='error'
                :err='error'
            />

            <template v-else-if='info'>
                <TablerInlineAlert
                    v-if='jobError'
                    severity='danger'
                    title='Print failed'
                    :description='jobError.message'
                />

                <div class='my-2'>
                    <TablerEnum
                        v-model='scaleLabel'
                        label='Scale'
                        :options='scaleOptions'
                    />
                </div>

                <div
                    v-if='scaleLabel === CUSTOM'
                    class='my-2'
                >
                    <TablerInput
                        v-model='customScale'
                        type='number'
                        label='Custom Scale (1:x)'
                        description='Clamped to the range the service accepts, 1:100 to 1:5,000,000'
                    />
                </div>

                <div class='my-2'>
                    <TablerEnum
                        v-model='paperLabel'
                        label='Paper Size'
                        :options='paperOptions'
                    />
                </div>

                <div class='my-2'>
                    <ButtonChoice
                        v-model='orientationLabel'
                        label='Orientation'
                        :options='["Portrait", "Landscape"]'
                    />
                </div>

                <!--
                    The footprint is the number that decides whether this sheet is
                    usable, so it is stated plainly rather than left to be inferred
                    from the box on the map.
                -->
                <div class='my-3 rounded border px-2 py-2'>
                    <div class='d-flex align-items-center'>
                        <span class='subheader'>Footprint</span>
                        <span
                            class='ms-auto'
                            v-text='footprintLabel'
                        />
                    </div>
                    <div class='d-flex align-items-center'>
                        <span class='subheader'>Grid</span>
                        <span
                            class='ms-auto'
                            v-text='gridLabel'
                        />
                    </div>
                    <div class='d-flex align-items-center'>
                        <span class='subheader'>Centre</span>
                        <span
                            class='ms-auto'
                            v-text='centreLabel'
                        />
                    </div>
                </div>

                <div class='my-2'>
                    <TablerInput
                        v-model='title'
                        label='Title'
                        placeholder='Map Title'
                    />
                </div>

                <div class='my-2'>
                    <TablerInput
                        v-model='incident'
                        label='Incident'
                        placeholder='Incident number'
                    />
                </div>

                <div class='my-2'>
                    <TablerInput
                        v-model='agency'
                        label='Agency'
                    />
                </div>

                <div class='my-2'>
                    <ButtonChoice
                        v-model='gridChoice'
                        label='Grid'
                        :options='GRID_OPTIONS'
                    />
                </div>

                <div class='my-2'>
                    <ButtonChoice
                        v-model='outputLabel'
                        label='Output'
                        :options='OUTPUTS.map(([label]) => label)'
                    />
                    <div
                        v-if='format === "tif"'
                        class='subheader mt-1'
                    >
                        The map frame alone as a GeoTIFF, grid drawn in, for loading as an overlay in CloudTAK, ATAK or desktop GIS. No margins or title block.
                    </div>
                </div>

                <div
                    v-if='format === "pdf"'
                    class='my-2'
                >
                    <TablerToggle
                        v-model='geopdf'
                        label='GeoPDF'
                    />
                    <div class='subheader mt-1'>
                        Georeferenced, so the sheet imports back into CloudTAK, ATAK or TAK Aware as an overlay. Prints the same either way.
                    </div>
                </div>

                <div class='my-2'>
                    <ButtonChoice
                        v-model='markLabel'
                        label='Marker &amp; Label Size'
                        :options='markChoices'
                    />
                </div>

                <div class='my-2'>
                    <ButtonChoice
                        v-model='qualityLabel'
                        label='Quality'
                        :options='qualityChoices'
                    />
                </div>

                <div
                    v-if='missionOptions.length > 1'
                    class='my-2'
                >
                    <TablerEnum
                        v-model='missionLabel'
                        label='Data Sync Invite QR'
                        :options='missionOptions'
                    />
                </div>

                <!--
                    Nothing reaches a Data Sync unless it is pushed here. Neither
                    Preview nor Print uploads on its own: a mission keeps
                    everything ever attached to it, and a sheet that went there
                    because a button happened to be pressed is somebody else's
                    problem to sort out later.
                -->
                <div
                    v-if='sendOptions.length > 1'
                    class='my-2'
                >
                    <TablerEnum
                        v-model='sendLabel'
                        label='Send to Data Sync'
                        :options='sendOptions'
                    />
                    <div class='d-flex mt-2'>
                        <TablerButton
                            class='btn-sm ms-auto'
                            :disabled='busy || sending || !sendMission'
                            @click='send'
                        >
                            {{ sending ? 'Sending…' : 'Send' }}
                        </TablerButton>
                    </div>
                </div>

                <!--
                    Imports are the user's own until shared, so this is safe to
                    offer to everyone -- but it is still a button, never a side
                    effect of Print. Same quality as Print, like Send.
                -->
                <div
                    v-if='importable'
                    class='my-2 d-flex align-items-center'
                >
                    <span class='subheader'>Load as an overlay in CloudTAK</span>
                    <TablerButton
                        class='btn-sm ms-auto'
                        :disabled='busy || sending'
                        @click='sendImport'
                    >
                        {{ sending ? 'Sending…' : 'Send to Imports' }}
                    </TablerButton>
                </div>

                <TablerInlineAlert
                    v-if='sendError'
                    severity='danger'
                    title='Send failed'
                    :description='sendError.message'
                />

                <div
                    v-if='sendNote'
                    class='subheader my-2 d-flex align-items-center'
                >
                    <span v-text='sendNote' />
                    <a
                        v-if='importId'
                        class='ms-auto cursor-pointer'
                        @click='router.push(`/menu/imports/${importId}`)'
                    >Open Import</a>
                </div>

                <!--
                    An overlay the service cannot resolve is dropped silently on its
                    side, which is how a sheet comes back missing the one layer the
                    team needed. Say so before the job is submitted, not after.
                -->
                <TablerInlineAlert
                    v-if='iconWarning'
                    severity='warning'
                    title='Icons may be missing'
                    :description='iconWarning'
                />

                <TablerInlineAlert
                    v-if='unresolved.length'
                    severity='warning'
                    title='Overlays not ready'
                    :description='unresolvedDescription'
                />

                <div class='my-3 d-flex'>
                    <TablerButton
                        class='btn-sm'
                        :disabled='busy || sending'
                        @click='fitToSheet'
                    >
                        Fit Map to Sheet
                    </TablerButton>

                    <div class='ms-auto'>
                        <TablerButton
                            class='btn-sm me-2'
                            :disabled='busy || sending'
                            @click='run(true)'
                        >
                            Preview
                        </TablerButton>

                        <TablerButton
                            class='btn-sm btn-primary'
                            :disabled='busy || sending'
                            @click='run(false)'
                        >
                            Print
                        </TablerButton>
                    </div>
                </div>

                <div
                    v-if='job'
                    class='my-3'
                >
                    <div class='d-flex align-items-center mb-1'>
                        <span
                            class='subheader'
                            v-text='job.step || job.status'
                        />
                        <span
                            class='ms-auto'
                            v-text='`${Math.round(job.progress * 100)}%`'
                        />
                    </div>
                    <TablerProgress :percent='job.progress' />
                </div>

                <TablerInlineAlert
                    v-for='warning of job?.warnings || []'
                    :key='warning'
                    severity='warning'
                    title='Render warning'
                    :description='warning'
                />
            </template>
        </template>
    </MenuTemplate>
</template>

<script setup lang='ts'>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import MenuTemplate from '../../src/components/CloudTAK/util/MenuTemplate.vue';
import {
    TablerEnum,
    TablerInput,
    TablerAlert,
    TablerButton,
    TablerToggle,
    TablerProgress,
    TablerInlineAlert,
} from '@tak-ps/vue-tabler';
import { useMapStore } from '../../src/stores/map.ts';
import { info as fetchInfo, submit, wait, result } from './lib/api.ts';
import type { PrintInfo, JobStatus, PrintRequest } from './lib/api.ts';
import { harvest } from './lib/harvest.ts';
import { missions, inviteQr, attach } from './lib/missions.ts';
import { sendable } from './lib/datasync.ts';
import type { MissionOption } from './lib/missions.ts';
import { SheetBox } from './lib/sheetbox.ts';
import ButtonChoice from './ButtonChoice.vue';
import { OUTPUTS, formatFor, outputName } from './lib/output.ts';
import { sendToImports } from './lib/imports.ts';
import { useRouter } from 'vue-router';

const CUSTOM = 'Custom…';
const NO_MISSION = 'None';

/*
 * Marker and label size, as a multiplier on the size they have on screen.
 *
 * The renderer keeps marks at their physical screen size by default, which is
 * right on a plotter sheet and too heavy on Letter -- the paper got smaller and
 * the icon did not. Remembered between prints so it is set once, not every time.
 */
const MARK_SIZES: Array<[string, number]> = [
    ['Smallest — 50%', 0.5],
    ['Smaller — 75%', 0.75],
    ['Normal — 100%', 1],
    ['Larger — 125%', 1.25],
    ['Largest — 150%', 1.5],
];

const MARK_KEY = 'cloudtak-print-mark-size';
const M_PER_INCH = 0.0254;

const mapStore = useMapStore();

const loading = ref(true);
const busy = ref(false);

/** Fatal: the service could not be reached, so there is no form to show. */
const error = ref<Error | undefined>();
/** Recoverable: a job failed. The form, the fields and the box all stay put. */
const jobError = ref<Error | undefined>();

const info = ref<PrintInfo | undefined>();
const job = ref<JobStatus | undefined>();

const scaleLabel = ref('1:24,000');
const customScale = ref(24000);
const paperLabel = ref('');
const orientationLabel = ref('Portrait');
const qualityLabel = ref('Standard — 200 DPI');
const markLabel = ref('Normal — 100%');

/*
 * UTM on by default: the grid is the reason most of these sheets get printed.
 *
 * MGRS / USNG draws the same lines -- that grid IS the UTM grid -- so it is a
 * choice of labelling, and one control rather than two toggles that could both
 * be on. USNG and MGRS print identical references inside the US; the name and
 * the datum are the only difference. The menu names both so the option is
 * recognisable outside the US. The print request still sends grid: 'usng'.
 */
const GRID_MGRS_USNG = 'MGRS / USNG';
const GRID_OPTIONS = ['UTM', GRID_MGRS_USNG, 'Off'];
const gridChoice = ref('UTM');
const grid = computed(() => {
    return gridChoice.value !== 'Off';
});

// On by default too. It costs nothing to print -- the georeferencing is invisible
// to a printer -- and a sheet that cannot be put back on a map is a dead end.
// The toggle exists because it is not free everywhere: it adds a viewport
// dictionary some third-party PDF tooling has opinions about.
const geopdf = ref(true);

// PDF by default: printing is what this panel is for. Not remembered, like the
// GeoPDF toggle -- a GeoTIFF left selected from last time is a sheet that does
// not come out of the printer.
const outputLabel = ref(OUTPUTS[0][0]);
const format = computed(() => {
    return formatFor(outputLabel.value);
});

// A PDF imports only when it carries its georeferencing.
const importable = computed(() => {
    return format.value === 'tif' || geopdf.value;
});

const router = useRouter();
const importId = ref('');

const title = ref('');
const incident = ref('');
const agency = ref('');

const centre = ref<[number, number]>([0, 0]);
const missionList = ref<MissionOption[]>([]);
const missionLabel = ref(NO_MISSION);

// Its own selection, not the invite QR's. Sending a map somewhere and inviting
// people to join it are different decisions, and the common case is one without
// the other.
const sendLabel = ref(NO_MISSION);
const sending = ref(false);
const sendError = ref<Error | undefined>();
const sendNote = ref('');
const unresolved = ref<string[]>([]);
const iconWarning = ref('');

let box: SheetBox | undefined;

function formatScale(scale: number): string {
    return `1:${scale.toLocaleString('en-US')}`;
}

const scaleOptions = computed(() => {
    if (!info.value) return [CUSTOM];

    return [
        ...info.value.scales.map((option) => formatScale(option.scale)),
        CUSTOM,
    ];
});

const paperOptions = computed(() => {
    if (!info.value) return [];
    return info.value.paper.map((option) => option.label);
});

const qualityOptions = computed(() => {
    const maxDpi = info.value?.maxDpi;
    if (!maxDpi) return [];

    // The ceiling is the service's, which is itself bounded by the GL texture limit.
    // Offering a DPI the service will silently clamp would make the panel lie.
    return [100, 150, 200, 300]
        .filter((dpi) => dpi <= maxDpi)
        .map((dpi) => {
            const name = dpi <= 100 ? 'Draft' : dpi <= 150 ? 'Field' : dpi <= 200 ? 'Standard' : 'Plotter';
            return `${name} — ${dpi} DPI`;
        });
});

// "Standard — 200 DPI" as two lines on a button, name over resolution.
const qualityChoices = computed(() => {
    return qualityOptions.value.map((label) => {
        const [text, sub] = label.split(' — ');
        return { value: label, text, sub };
    });
});

const missionOptions = computed(() => {
    return [NO_MISSION, ...missionList.value.map((entry) => entry.name)];
});

const mission = computed(() => {
    if (missionLabel.value === NO_MISSION) return undefined;
    return missionList.value.find((entry) => entry.name === missionLabel.value);
});

const sendList = computed(() => {
    return sendable(missionList.value);
});

const sendOptions = computed(() => {
    return [NO_MISSION, ...sendList.value.map((entry) => entry.name)];
});

const sendMission = computed(() => {
    if (sendLabel.value === NO_MISSION) return undefined;
    return sendList.value.find((entry) => entry.name === sendLabel.value);
});

const markOptions = MARK_SIZES.map(([label]) => label);

// The buttons show the percentage only; the stored value stays the full label so
// a size remembered by an earlier version of the panel still matches.
const markChoices = MARK_SIZES.map(([label, size]) => {
    return { value: label, text: `${Math.round(size * 100)}%` };
});

const markSize = computed(() => {
    const match = MARK_SIZES.find(([label]) => label === markLabel.value);
    return match ? match[1] : 1;
});

// Remembered per browser. A failure here must never stop a print, so the read and
// the write are both allowed to do nothing.
watch(markLabel, (value) => {
    try {
        localStorage.setItem(MARK_KEY, value);
    } catch {
        // Private window, or storage disabled.
    }
});

const dpi = computed(() => {
    const match = qualityLabel.value.match(/(\d+) DPI/);
    return match ? Number(match[1]) : 200;
});

const scale = computed(() => {
    if (scaleLabel.value === CUSTOM) {
        // The service rejects anything outside this range, and a 400 after a full
        // harvest is an expensive way to learn you typed an extra zero.
        const typed = Math.round(Number(customScale.value)) || 24000;
        return Math.min(5000000, Math.max(100, typed));
    }

    const match = info.value?.scales.find((option) => {
        return formatScale(option.scale) === scaleLabel.value;
    });

    return match?.scale ?? 24000;
});

const paper = computed(() => {
    return info.value?.paper.find((option) => option.label === paperLabel.value);
});

const orientation = computed<'portrait' | 'landscape'>(() => {
    return orientationLabel.value === 'Landscape' ? 'landscape' : 'portrait';
});

/**
 * The map frame in inches, computed from the margins the service publishes rather
 * than a second copy of them here. See service/routes/base.ts.
 */
const frameInches = computed(() => {
    if (!info.value || !paper.value) return { width: 0, height: 0 };

    const { margins } = info.value;
    const portrait = orientation.value === 'portrait';

    const width = portrait ? paper.value.width : paper.value.height;
    const height = portrait ? paper.value.height : paper.value.width;

    return {
        width: width - margins.left - margins.right,
        height: height - margins.top - margins.bottom,
    };
});

const groundMetres = computed(() => {
    return {
        width: frameInches.value.width * scale.value * M_PER_INCH,
        height: frameInches.value.height * scale.value * M_PER_INCH,
    };
});

/**
 * Every threshold in the service's gridInterval() sits on a published scale, so the
 * first rung at or above the chosen scale gives the exact interval that will print,
 * including for a custom scale. service/test/base.test.ts pins that equivalence.
 */
const gridMetres = computed(() => {
    if (!info.value?.scales.length) return 0;

    // USNG steps in powers of ten, on a ladder the service publishes whole.
    if (gridChoice.value === GRID_MGRS_USNG && info.value.usngLadder?.length) {
        const ladder = info.value.usngLadder;
        const step = ladder.find((r) => {
            return r.max === null || scale.value <= r.max;
        });

        return (step ?? ladder[ladder.length - 1]).interval;
    }

    const rung = info.value.scales.find((option) => {
        return option.scale >= scale.value;
    });

    return (rung ?? info.value.scales[info.value.scales.length - 1]).grid;
});

const footprintLabel = computed(() => {
    const { width, height } = groundMetres.value;
    if (!width || !height) return '—';

    return `${(width / 1000).toFixed(1)} × ${(height / 1000).toFixed(1)} km`;
});

const gridLabel = computed(() => {
    if (!grid.value) return 'Off';
    return gridMetres.value ? `${gridChoice.value} \u00b7 ${gridMetres.value.toLocaleString('en-US')} m` : '—';
});

const centreLabel = computed(() => {
    return `${centre.value[1].toFixed(5)}, ${centre.value[0].toFixed(5)}`;
});

const unresolvedDescription = computed(() => {
    return `${unresolved.value.join(', ')}. Pan the map and let these finish loading, `
        + 'or they will be missing from the printed sheet.';
});

function refreshBox() {
    if (!box) return;
    box.update({ groundMetres: groundMetres.value });
}

watch([scale, paper, orientation], refreshBox);

function fitToSheet() {
    if (!box) return;
    mapStore.map.fitBounds(box.bounds, { padding: 40 });
}

/**
 * The request, exactly as it would be submitted.
 *
 * Shared with the debug dump below so what gets saved is byte-for-byte what gets
 * printed -- a dump built by a separate path would describe a different render,
 * which is precisely the trap the old console harvester became.
 */
/**
 * What the sheet is called.
 *
 * A Data Sync keeps everything ever attached to it, so two sheets of the same
 * area on the same incident must not collide -- hence the timestamp. Minutes,
 * not seconds: it is there to disambiguate, not to be read.
 */
function sheetName(suffix = ''): string {
    return outputName(title.value, scale.value, format.value, suffix);
}

function stamp(): string {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').slice(0, 14) + 'Z';
}

async function compose(preview: boolean): Promise<PrintRequest> {
    const captured = await harvest(mapStore.map);
    unresolved.value = captured.unresolved;

    // Say so when icons are not going to print. This going unreported is how
    // every sheet came out with labels and no symbols for an entire phase.
    iconWarning.value = '';
    if (captured.pool > 0 && captured.images.length === 0) {
        iconWarning.value = `None of the ${captured.pool} map icons could be read, so the sheet will `
            + 'print symbols without their icons. This is a bug worth reporting.';
    } else if (captured.skipped > 0) {
        iconWarning.value = `${captured.skipped} of ${captured.pool} map icons could not be read and `
            + 'will be missing from the sheet.';
    }

    // Fetched at submit rather than on selection: the invite is stamped with a
    // token, and one minted when the panel opened could be stale by the time
    // someone has finished positioning the sheet.
    // Captioned with the incident, not the Data Sync name: the person holding
    // the sheet is being told which incident this code joins them to. Blank
    // incident means the code prints uncaptioned.
    const qr = mission.value
        ? { svg: await inviteQr(mission.value.guid), label: incident.value || undefined }
        : undefined;

    return {
        title: title.value || undefined,
        incident: incident.value || undefined,
        scale: scale.value,
        paper: {
            size: paper.value?.id ?? 'tabloid',
            orientation: orientation.value,
        },
        center: centre.value,
        // A preview exists to check composition and coverage, not detail, so it
        // runs the same code path at the lowest rung on the DPI ladder.
        dpi: preview ? 72 : dpi.value,
        markSize: markSize.value,
        style: captured.style,
        images: captured.images,
        qr,
        format: format.value,
        georeference: geopdf.value,
        furniture: {
            grid: gridChoice.value === GRID_MGRS_USNG ? 'usng' : gridChoice.value === 'UTM' ? 'utm' : 'none',
            branding: agency.value || undefined,
        },
    };
}

/**
 * Render and attach the result to a Data Sync.
 *
 * At the quality and output the panel is set to, the same file Print would
 * download. It used to go at preview quality to spare cellular subscribers, but
 * a low-resolution map in a mission is one people end up working from; the
 * Quality menu is where that trade-off is made, by whoever is sending.
 */
async function send() {
    const target = sendMission.value;
    if (!target) return;

    sending.value = true;
    sendError.value = undefined;
    sendNote.value = '';
    importId.value = '';
    job.value = undefined;

    try {
        const submitted = await submit(await compose(false));

        job.value = submitted;

        const finished = await wait(submitted.job, {
            onUpdate: (update) => {
                job.value = update;
            },
        });

        if (finished.status === 'failed') {
            throw new Error(finished.error || 'Print job failed');
        }

        const name = sheetName(`-${stamp()}`);

        await attach(target.guid, await result(submitted.job), name);

        sendNote.value = `Sent ${name} to ${target.name}`;
    } catch (err) {
        sendError.value = err instanceof Error ? err : new Error(String(err));
    } finally {
        sending.value = false;
    }
}

/**
 * Render at full quality and send the result to the user's own Imports, where
 * CloudTAK turns it into an overlay.
 *
 * Whatever the Output menu says: a GeoTIFF arrives as the map frame alone, a
 * GeoPDF with its collar. The button is hidden for a PDF without georeferencing,
 * which CloudTAK would refuse.
 */
async function sendImport() {
    sending.value = true;
    sendError.value = undefined;
    sendNote.value = '';
    importId.value = '';
    job.value = undefined;

    try {
        const submitted = await submit(await compose(false));

        job.value = submitted;

        const finished = await wait(submitted.job, {
            onUpdate: (update) => {
                job.value = update;
            },
        });

        if (finished.status === 'failed') {
            throw new Error(finished.error || 'Print job failed');
        }

        const name = sheetName(`-${stamp()}`);

        importId.value = await sendToImports(await result(submitted.job), name);
        sendNote.value = `Sent ${name} to Imports`;
    } catch (err) {
        sendError.value = err instanceof Error ? err : new Error(String(err));
    } finally {
        sending.value = false;
    }
}

async function run(preview: boolean) {
    busy.value = true;
    jobError.value = undefined;
    job.value = undefined;

    try {
        const submitted = await submit(await compose(preview));

        job.value = submitted;

        const finished = await wait(submitted.job, {
            onUpdate: (update) => {
                job.value = update;
            },
        });

        if (finished.status === 'failed') {
            throw new Error(finished.error || 'Print job failed');
        }

        const blob = await result(submitted.job);
        const name = sheetName();

        const href = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = preview ? sheetName('-preview') : name;
        anchor.click();
        URL.revokeObjectURL(href);
    } catch (err) {
        jobError.value = err instanceof Error ? err : new Error(String(err));
    } finally {
        busy.value = false;
    }
}

onMounted(async () => {
    try {
        info.value = await fetchInfo();

        if (!paperLabel.value) {
            // Letter by default: it comes out of any printer, anywhere, without
            // anyone having to think about it.
            const preferred = info.value.paper.find((option) => option.id === 'letter');
            paperLabel.value = (preferred ?? info.value.paper[0]).label;
        }

        try {
            const remembered = localStorage.getItem(MARK_KEY);
            if (remembered && markOptions.includes(remembered)) markLabel.value = remembered;
        } catch {
            // Storage unavailable; the default stands.
        }

        if (!qualityOptions.value.includes(qualityLabel.value)) {
            qualityLabel.value = qualityOptions.value[qualityOptions.value.length - 1] ?? qualityLabel.value;
        }

        // Defaults to None. An invite QR covers part of the map and joins whoever
        // scans it to a Data Sync, so it is opted into rather than out of.
        try {
            missionList.value = await missions();
        } catch {
            // A user with no Data Syncs, or a database that is not ready, should
            // still get a print panel.
            missionList.value = [];
        }

        const current = mapStore.map.getCenter();
        centre.value = [Number(current.lng.toFixed(6)), Number(current.lat.toFixed(6))];

        box = new SheetBox(mapStore.map, {
            center: centre.value,
            groundMetres: groundMetres.value,
        }, {
            onMove: (moved) => {
                centre.value = [Number(moved[0].toFixed(6)), Number(moved[1].toFixed(6))];
            },
        });
    } catch (err) {
        error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
        loading.value = false;
    }
});

/*
 * Save the exact request for offline debugging:
 *
 *     await __cloudtakPrintSave()
 *
 * The payload is the one that would be printed, not a reconstruction. Style tile
 * and glyph URLs can carry a session token, so treat the file as a credential:
 * it is gitignored as print-job.json, and it should not be shared further.
 */
declare global {
    interface Window {
        __cloudtakPrintSave?: () => Promise<string>;
    }
}

onMounted(() => {
    window.__cloudtakPrintSave = async () => {
        const body = await compose(false);
        const json = JSON.stringify(body);

        const href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = 'print-job.json';
        anchor.click();
        URL.revokeObjectURL(href);

        return `${(json.length / 1048576).toFixed(2)} MB, ${body.images?.length ?? 0} images`;
    };
});

onBeforeUnmount(() => {
    delete window.__cloudtakPrintSave;
    if (box) box.destroy();
    box = undefined;
});
</script>
