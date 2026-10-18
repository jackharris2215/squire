<script setup lang="ts">
import { computed } from 'vue'
import type { Variable } from './types'
import { variableProblem } from './variables'

// The list of variables. Each row is two lines: a type icon (A for text, 1 for
// number) and the name on top, the value centered below. Right-clicking a row is
// reported upward (its menu changes the type or deletes it). It doesn't own the
// list; every change goes up as a whole new list, and whoever shows it decides
// where that is stored.
// `readonly` is for the global variables list: no add button, and a row is drawn as
// plain text (no inputs at all) rather than the editable fields the notebook's and a
// note's variables get. It can still be right-clicked to insert it (the menu itself
// hides Type/Delete, and Insert only offers Display — there's no widget that isn't
// also a way to change the value).
const props = defineProps<{ variables: Variable[]; readonly?: boolean }>()
const emit = defineEmits<{
  change: [variables: Variable[]]
  menu: [event: MouseEvent, index: number, variable: Variable]
}>()

// Each variable's problem (or null); one with a problem is shown in red.
const problems = computed(() => props.variables.map((_, i) => variableProblem(props.variables, i)))

const TYPE_ICONS = { text: 'A', number: '1', boolean: '✓', date: 'D', time: 'T' }
const TYPE_LABELS = { text: 'Text', number: 'Number', boolean: 'Boolean', date: 'Date', time: 'Time' }

function add() {
  emit('change', [...props.variables, { name: '', type: 'text', value: '' }])
}

function update(index: number, changes: Partial<Variable>) {
  emit('change', props.variables.map((v, i) => (i === index ? { ...v, ...changes } : v)))
}

function setNumber(index: number, event: Event) {
  const typed = parseFloat((event.target as HTMLInputElement).value)
  update(index, { value: Number.isNaN(typed) ? 0 : typed })
}

function displayValue(variable: Variable): string {
  return variable.type === 'boolean' ? (variable.value ? 'true' : 'false') : String(variable.value)
}
</script>

<template>
  <div class="variables">
    <template v-if="readonly">
      <div
        v-for="(variable, i) in variables"
        :key="i"
        class="variable variable-global"
        @contextmenu.prevent.stop="emit('menu', $event, i, variable)"
      >
        <div class="global-top">
          <span class="variable-type" :title="TYPE_LABELS[variable.type]">{{ TYPE_ICONS[variable.type] }}</span>
          <span class="global-name">{{ variable.name }}</span>
        </div>
        <div class="global-value">{{ displayValue(variable) }}</div>
      </div>
    </template>
    <template v-else>
      <div
        v-for="(variable, i) in variables"
        :key="i"
        class="variable variable-stacked"
        :class="{ invalid: problems[i] }"
        :title="problems[i] ?? undefined"
        @contextmenu.prevent.stop="emit('menu', $event, i, variable)"
      >
        <div class="global-top">
          <span class="variable-type" :title="TYPE_LABELS[variable.type]">{{ TYPE_ICONS[variable.type] }}</span>
          <input
            class="variable-name"
            type="text"
            placeholder="name"
            spellcheck="false"
            :value="variable.name"
            @input="update(i, { name: ($event.target as HTMLInputElement).value })"
          />
        </div>
        <button
          v-if="variable.type === 'boolean'"
          class="variable-value variable-bool"
          title="Click to flip"
          @click="update(i, { value: !variable.value })"
        >
          {{ variable.value ? 'true' : 'false' }}
        </button>
        <input
          v-else-if="variable.type === 'number'"
          class="variable-value"
          type="number"
          placeholder="value"
          :value="variable.value"
          @change="setNumber(i, $event)"
        />
        <input
          v-else-if="variable.type === 'date'"
          class="variable-value"
          type="date"
          :value="variable.value"
          @change="update(i, { value: ($event.target as HTMLInputElement).value })"
        />
        <input
          v-else-if="variable.type === 'time'"
          class="variable-value"
          type="time"
          :value="variable.value"
          @change="update(i, { value: ($event.target as HTMLInputElement).value })"
        />
        <input
          v-else
          class="variable-value"
          type="text"
          placeholder="value"
          spellcheck="false"
          :value="variable.value"
          @input="update(i, { value: ($event.target as HTMLInputElement).value })"
        />
      </div>
      <button class="settings-apply" @click="add">+ Add variable</button>
    </template>
  </div>
</template>

<style scoped>
.variable {
  display: flex;
  align-items: stretch;
  margin-bottom: 0.4rem;
  font-size: 0.8rem;
  background: rgb(var(--tint) / 0.06);
  border: 1px solid var(--color-border-hover);
  border-radius: 4px;
}

.variable:focus-within {
  border-color: var(--color-accent);
}

/* A variable with a bad name: red, and ignored by anything that looks variables up. */
.variable.invalid,
.variable.invalid:focus-within {
  border-color: #e08080;
  background: rgba(224, 128, 128, 0.1);
}

.variable.invalid .variable-type {
  color: #e08080;
}

.variable-type {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  font-weight: 700;
  color: var(--color-accent);
  user-select: none;
}

.variable-name,
.variable-value {
  flex: 1;
  min-width: 0;
  padding: 0.3rem 0.4rem;
  font: inherit;
  color: var(--color-text-strong);
  background: transparent;
  border: none;
  outline: none;
}

.variable-stacked .variable-value {
  text-align: center;
  border-top: 1px solid var(--color-border-hover);
}

.variable-bool {
  cursor: pointer;
}

/* No up/down arrows in a number's box; there's no room for them. */
.variable-value[type='number'] {
  appearance: textfield;
}

.variable-value[type='number']::-webkit-inner-spin-button,
.variable-value[type='number']::-webkit-outer-spin-button {
  appearance: none;
}

/* Every row is type + name on one line, then the value by itself on a line below,
   centered — an editable row's value is a live input/button, a global row's (which has
   no inputs at all) is plain text. */
.variable-global,
.variable-stacked {
  flex-direction: column;
  align-items: stretch;
}

.global-top {
  display: flex;
  align-items: center;
}

.global-name {
  flex: 1;
  min-width: 0;
  padding: 0.3rem 0.4rem;
  color: var(--color-text-strong);
}

.global-value {
  padding: 0.3rem 0.4rem;
  text-align: center;
  color: var(--color-text-strong);
  border-top: 1px solid var(--color-border-hover);
}
</style>
