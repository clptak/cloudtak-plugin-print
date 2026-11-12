<template>
    <div>
        <p
            class='text-uppercase text-white-50 small mb-1'
            v-text='label'
        />
        <!--
            Buttons rather than a select, for touch: a pulldown is two taps and a
            small target, and on a tablet in a vehicle the native picker covers the
            map the choice is about. Every option is visible and one tap away.

            Styled as cloudtak-plugin-incident-manager does its option groups --
            a joined btn-group, btn-primary for the choice, btn-outline-secondary
            for the rest -- so the two panels read as one product. Taller than
            btn-sm, because these are meant to be hit with a finger.
        -->
        <div
            class='btn-group btn-group-sm w-100 print-choice'
            role='radiogroup'
            :aria-label='label'
            @keydown='onKey'
        >
            <button
                v-for='(option, i) of normalised'
                :key='option.value'
                ref='buttons'
                type='button'
                role='radio'
                class='btn print-choice__btn'
                :class='option.value === modelValue ? "btn-primary" : "btn-outline-secondary"'
                :aria-checked='option.value === modelValue'
                :tabindex='option.value === modelValue || (!hasValue && i === 0) ? 0 : -1'
                :disabled='disabled'
                :title='option.title'
                @click='emit("update:modelValue", option.value)'
            >
                <span v-text='option.text' />
                <span
                    v-if='option.sub'
                    class='print-choice__sub'
                    v-text='option.sub'
                />
            </button>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { computed, ref } from 'vue';

export type Choice = string | { value: string; text: string; sub?: string };

const props = withDefaults(defineProps<{
    modelValue: string;
    label: string;
    options: Choice[];
    disabled?: boolean;
}>(), {
    disabled: false,
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
}>();

const buttons = ref<HTMLButtonElement[]>([]);

const normalised = computed(() => {
    return props.options.map((option) => {
        const o = typeof option === 'string' ? { value: option, text: option, sub: undefined } : option;
        return { ...o, title: o.sub ? `${o.text} — ${o.sub}` : o.text };
    });
});

const hasValue = computed(() => {
    return normalised.value.some((o) => o.value === props.modelValue);
});

/** Arrow keys move the choice, as a radio group should. */
function onKey(e: KeyboardEvent): void {
    const step = ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1
        : ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 0;
    if (!step || props.disabled) return;

    e.preventDefault();
    const list = normalised.value;
    const at = list.findIndex((o) => o.value === props.modelValue);
    const next = Math.max(0, Math.min(list.length - 1, (at < 0 ? -step : at) + step));

    emit('update:modelValue', list[next].value);
    buttons.value[next]?.focus();
}
</script>

<style scoped>
.print-choice__btn {
    /* 44px is the minimum comfortable touch target. */
    min-height: 44px;
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    line-height: 1.15;
    white-space: normal;
}

.print-choice__sub {
    font-size: 0.75em;
    opacity: 0.75;
}
</style>
