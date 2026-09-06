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
                    <TablerEnum
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
                        <span class='subheader'>UTM Grid</span>
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
                    <TablerEnum
                        v-model='qualityLabel'
                        label='Quality'
                        :options='qualityOptions'
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
                    An overlay the service cannot resolve is dropped silently on its
                    side, which is how a sheet comes back missing the one layer the
                    team needed. Say so before the job is submitted, not after.
                -->
                <TablerInlineAlert
                    v-if='unresolved.length'
                    severity='warning'
                    title='Overlays not ready'
                    :description='unresolvedDescription'
                />

                <div class='my-3 d-flex'>
                    <TablerButton
                        class='btn-sm'
                        :disabled='busy'
                        @click='fitToSheet'
                    >
                        Fit Map to Sheet
                    </TablerButton>

                    <div class='ms-auto'>
                        <TablerButton
                            class='btn-sm me-2'
                            :disabled='busy'
                            @click='run(true)'
                        >
                            Preview
                        </TablerButton>

                        <TablerButton
                            class='btn-sm btn-primary'
                            :disabled='busy'
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
    TablerProgress,
    TablerInlineAlert,
} from '@tak-ps/vue-tabler';
import { useMapStore } from '../../src/stores/map.ts';
import { info as fetchInfo, submit, wait, result } from './lib/api.ts';
import type { PrintInfo, JobStatus } from './lib/api.ts';
import { harvest } from './lib/harvest.ts';
import { missions, inviteQr } from './lib/missions.ts';
import type { MissionOption } from './lib/missions.ts';
import { SheetBox } from './lib/sheetbox.ts';

const CUSTOM = 'Custom…';
const NO_MISSION = 'None';
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

const title = ref('');
const incident = ref('');
const agency = ref('');

const centre = ref<[number, number]>([0, 0]);
const missionList = ref<MissionOption[]>([]);
const missionLabel = ref(NO_MISSION);
const unresolved = ref<string[]>([]);

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

const missionOptions = computed(() => {
    return [NO_MISSION, ...missionList.value.map((entry) => entry.name)];
});

const mission = computed(() => {
    if (missionLabel.value === NO_MISSION) return undefined;
    return missionList.value.find((entry) => entry.name === missionLabel.value);
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
    return gridMetres.value ? `${gridMetres.value.toLocaleString('en-US')} m` : '—';
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

async function run(preview: boolean) {
    busy.value = true;
    jobError.value = undefined;
    job.value = undefined;

    try {
        const captured = await harvest(mapStore.map);
        unresolved.value = captured.unresolved;

        // Fetched at submit rather than on selection: the invite is stamped with a
        // token, and one minted when the panel opened could be stale by the time
        // someone has finished positioning the sheet.
        // Captioned with the incident, not the Data Sync name: the person holding
        // the sheet is being told which incident this code joins them to. Blank
        // incident means the code prints uncaptioned.
        const qr = mission.value
            ? { svg: await inviteQr(mission.value.guid), label: incident.value || undefined }
            : undefined;

        const submitted = await submit({
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
            style: captured.style,
            images: captured.images,
            qr,
            furniture: {
                grid: 'utm',
                branding: agency.value || undefined,
            },
        });

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
        const stem = title.value.trim()
            ? title.value.replace(/[^\w-]+/g, '-').toLowerCase().replace(/^-+|-+$/g, '')
            : 'map';
        const name = `${stem}-${scale.value}.pdf`;

        const href = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = preview ? name.replace(/\.pdf$/, '-preview.pdf') : name;
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

onBeforeUnmount(() => {
    if (box) box.destroy();
    box = undefined;
});
</script>
