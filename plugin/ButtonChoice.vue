<template>
    <div>
        <label
            class='form-label'
            v-text='label'
        />
        <!--
            Buttons rather than a select, for touch: a pulldown is two taps and a
            small target, and on a tablet in a vehicle the native picker covers the
            map the choice is about. Every option is visible and one tap away.
        -->
        <div
            class='print-choice'
            :class='{ "print-choice--list": columns === 1 }'
            :style='{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }'
            role='radiogroup'
            :aria-label='label'
        >
            <button
                v-for='option of normalised'
                :key='option.value'
                type='button'
                role='radio'
                class='btn print-choice__btn'
                :class='option.value === modelValue ? "btn-primary" : ""'
                :aria-checked='option.value === modelValue'
                :disabled='disabled'
                :title='option.text'
                @click='emit("update:modelValue", option.value)'
            >
                <span
                    class='print-choice__text'
                    v-text='option.text'
                />
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
import { computed } from 'vue';

export type Choice = string | { value: string; text: string; sub?: string };

const props = withDefaults(defineProps<{
    modelValue: string;
    label: string;
    options: Choice[];
    /** Buttons per row. Defaults to every option on one row, up to four. */
    columns?: number;
    disabled?: boolean;
}>(), {
    columns: undefined,
    disabled: false,
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
}>();

const normalised = computed(() => {
    return props.options.map((option) => {
        return typeof option === 'string' ? { value: option, text: option, sub: undefined } : option;
    });
});

const columns = computed(() => {
    return props.columns ?? Math.min(Math.max(normalised.value.length, 1), 4);
});
</script>

<style scoped>
.print-choice {
    display: grid;
    gap: 6px;
}

.print-choice__btn {
    /* 44px is the minimum comfortable touch target. */
    min-height: 44px;
    min-width: 0;
    padding: 4px 6px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    line-height: 1.15;
    white-space: normal;
}

.print-choice--list .print-choice__btn {
    align-items: flex-start;
    text-align: left;
}

.print-choice__text {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.print-choice__sub {
    font-size: 0.75em;
    opacity: 0.75;
}
</style>
