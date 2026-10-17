<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Variable } from './types'
import { WIDGETS, widgetAccepts, widgetSnippet } from './variables'

// The right-click menu on a variable row: copy its name or value, insert it into the
// block being edited (as a display or a widget), switch its type, or delete it. The parent
// opens and closes it (defineExpose below), like SidebarMenu, and does the changes.
const emit = defineEmits<{
  'set-type': [index: number, type: Variable['type']]
  remove: [index: number]
  insert: [text: string, select?: [number, number]]
}>()

// The same icons as the type slot of a variable's row.
const TYPES: { type: Variable['type']; icon: string; label: string }[] = [
  { type: 'text', icon: 'A', label: 'Text' },
  { type: 'number', icon: '1', label: 'Number' },
  { type: 'boolean', icon: '✓', label: 'Boolean' },
  { type: 'date', icon: 'D', label: 'Date' },
  { type: 'time', icon: 'T', label: 'Time' },
]

// canInsert: a block is being edited and the variable's name is valid. readonly: a
// global variable, so there's no type to switch and nothing to delete.
const menu = ref<{ index: number; variable: Variable; canInsert: boolean; readonly: boolean; x: number; y: number } | null>(null)

// What can be inserted for the open variable: its display, then each widget that works
// with its type. A global variable can only be displayed — every widget is a way to
// change the value, and a global variable can't be.
const insertItems = computed(() => {
  if (menu.value?.readonly) return [{ kind: null, label: 'Display' }]
  const type = menu.value?.variable.type
  const widgets = Object.keys(WIDGETS)
    .filter((kind) => type && widgetAccepts(kind, type))
    .map((kind) => ({ kind, label: kind[0]!.toUpperCase() + kind.slice(1) }))
  return [{ kind: null, label: 'Display' }, ...widgets]
})

function open(event: MouseEvent, index: number, variable: Variable, canInsert: boolean, readonly = false) {
  // Keep the menu on screen near the cursor.
  const x = Math.min(event.clientX, window.innerWidth - 230)
  const y = Math.min(event.clientY, window.innerHeight - 400)
  menu.value = { index, variable, canInsert, readonly, x, y }
}

function close() {
  menu.value = null
}

defineExpose({ open, close })

function copy(text: string) {
  close()
  navigator.clipboard.writeText(text)
}

function insert(kind: string | null) {
  if (!menu.value) return
  const snippet = widgetSnippet(kind, menu.value.variable.name.trim())
  close()
  emit('insert', snippet.text, snippet.select)
}

function setType(type: Variable['type']) {
  if (!menu.value || type === menu.value.variable.type) return
  const { index } = menu.value
  close()
  emit('set-type', index, type)
}

function remove() {
  if (!menu.value) return
  const { index } = menu.value
  close()
  emit('remove', index)
}
</script>

<template>
  <div
    v-if="menu"
    class="context-menu"
    :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
    @click.stop
    @mousedown.prevent
    @contextmenu.prevent.stop
  >
    <button class="context-item" @click="copy(menu.variable.name)">Copy name</button>
    <button class="context-item" @click="copy(String(menu.variable.value))">Copy value</button>
    <div class="context-separator" />
    <div class="menu-group-label">Insert at cursor</div>
    <button v-for="item in insertItems" :key="item.label" class="context-item" :disabled="!menu.canInsert" @click="insert(item.kind)">
      {{ item.label }}
    </button>
    <template v-if="!menu.readonly">
      <div class="context-separator" />
      <div class="menu-group-label">Type</div>
      <div class="segmented variable-types">
        <button
          v-for="t in TYPES"
          :key="t.type"
          class="segment"
          :class="{ active: menu.variable.type === t.type }"
          :title="t.label"
          :aria-label="t.label"
          @click="setType(t.type)"
        >
          {{ t.icon }}
        </button>
      </div>
      <div class="context-separator" />
      <button class="settings-delete context-delete" @click="remove">Delete</button>
    </template>
  </div>
</template>

<style scoped>
.variable-types {
  margin: 0.15rem 0.5rem 0.35rem;
}
</style>
