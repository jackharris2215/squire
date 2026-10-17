<script setup lang="ts">
import { ref, watch } from 'vue'

// A one-line setting: shows the current value, and commits a new one on Enter or when
// leaving the box, if `validate` accepts it. A bad value stays in the box with the
// reason under it on Enter, and is put back when leaving; Escape puts it back too.
const props = defineProps<{
  modelValue: string
  validate?: (value: string) => string | null
  canReset?: boolean // shows a Reset button
  narrow?: boolean
  placeholder?: string
}>()

const emit = defineEmits<{ commit: [value: string]; reset: [] }>()

const draft = ref(props.modelValue)
const error = ref<string | null>(null)

watch(
  () => props.modelValue,
  (value) => {
    draft.value = value
    error.value = null
  },
)

function revert() {
  draft.value = props.modelValue
  error.value = null
}

function commit(fromEnter: boolean) {
  const value = draft.value.trim()
  if (value === props.modelValue) {
    revert()
    return
  }
  const problem = props.validate?.(value) ?? null
  if (problem) {
    if (fromEnter) error.value = problem
    else revert()
    return
  }
  error.value = null
  emit('commit', value)
}
</script>

<template>
  <div class="field">
    <div class="field-row">
      <input
        v-model="draft"
        class="settings-input field-input"
        :class="{ narrow, invalid: error }"
        type="text"
        spellcheck="false"
        :placeholder="placeholder"
        @input="error = null"
        @keydown.enter.prevent="commit(true)"
        @keydown.esc.prevent="revert"
        @blur="commit(false)"
      />
      <button v-if="canReset" class="settings-apply" @click="emit('reset')">Reset</button>
    </div>
    <p v-if="error" class="settings-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.field-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.field-input {
  flex: 1;
  margin-bottom: 0;
}

.field-input.narrow {
  flex: 0 0 8rem;
}

.field-input.invalid {
  border-color: #e08080;
}
</style>
