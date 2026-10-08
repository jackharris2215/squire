<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Block } from './types'
import { revealBlock, unhookBlocksInFocused } from './blockActions'
import { findBlockPosition, noteCache, placeBlock, selectedFile } from './store'

// The right panel's block browser: every block of the note in the focused pane, so any
// block can be found and grabbed, even one stuck behind others. Clicking a row selects
// the block and scrolls to it. The note's blocks come first, in order; under the
// "Unhooked" heading are the floating ones, front to back.
//
// Rows can be dragged: within the first list to reorder (a block dropped between others
// gets its own row there), from it into the Unhooked section to float the block where it
// is, and from the Unhooked section into the first list to hook it back at that place.
const note = computed(() => (selectedFile.value ? (noteCache.get(selectedFile.value) ?? null) : null))

// "Starts With:" filter: only blocks whose content starts with the typed text are shown.
const filterText = ref('')
function startsWith(block: Block) {
  return !filterText.value || block.content.toLowerCase().startsWith(filterText.value.toLowerCase())
}

const hooked = computed(() => (note.value?.blocks.flat() ?? []).filter(startsWith))
const floating = computed(() => [...(note.value?.floating ?? [])].sort((a, b) => b.z - a.z).filter(startsWith))

function preview(block: Block) {
  return block.content.replace(/\s+/g, ' ').trim() || 'Empty block'
}

// --- Dragging rows ---

const dragged = ref<{ id: string; floating: boolean } | null>(null)
const gap = ref<number | null>(null) // where a drop in the first list would go: 0 to hooked.length
const overUnhooked = ref(false)
const hookedZone = ref<HTMLElement | null>(null)

function onDragStart(event: DragEvent, block: Block, isFloating: boolean) {
  dragged.value = { id: block.id, floating: isFloating }
  event.dataTransfer?.setData('text/plain', block.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragEnd() {
  dragged.value = null
  gap.value = null
  overUnhooked.value = false
}

// The gap the pointer is nearest to: before the first row whose middle is below it.
function gapAt(clientY: number) {
  const rows = [...(hookedZone.value?.querySelectorAll('li.browser-item') ?? [])]
  const index = rows.findIndex((row) => clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2)
  return index === -1 ? rows.length : index
}

// A gap right beside the dragged block itself would change nothing.
function isNoOp(at: number) {
  const drag = dragged.value
  if (!drag || drag.floating) return false
  const index = hooked.value.findIndex((b) => b.id === drag.id)
  return at === index || at === index + 1
}

function leaves(event: DragEvent) {
  return !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)
}

function onHookedDragOver(event: DragEvent) {
  if (!dragged.value) return
  event.preventDefault()
  overUnhooked.value = false
  const at = gapAt(event.clientY)
  gap.value = isNoOp(at) ? null : at
}

// A block dropped before another goes in a row of its own just above that block's row;
// dropped at the end, it goes last.
function onHookedDrop() {
  const drag = dragged.value
  const at = gap.value
  const current = note.value
  onDragEnd()
  if (!drag || at === null || !current || !selectedFile.value) return
  const before = hooked.value[at]
  const rowIndex = before ? findBlockPosition(current, before.id)!.rowIndex : current.blocks.length
  placeBlock(selectedFile.value, drag.id, rowIndex)
}

function onUnhookedDragOver(event: DragEvent) {
  if (!dragged.value || dragged.value.floating) return
  event.preventDefault()
  gap.value = null
  overUnhooked.value = true
}

function onUnhookedDrop() {
  const drag = dragged.value
  onDragEnd()
  if (drag && !drag.floating) unhookBlocksInFocused([drag.id])
}
</script>

<template>
  <div class="block-browser scroll-area">
    <p v-if="!note" class="browser-hint">Open a note to see its blocks.</p>
    <template v-else>
      <input v-model="filterText" type="text" class="browser-filter-input" placeholder="Starts With..." spellcheck="false" />
      <div
        ref="hookedZone"
        class="browser-zone hooked-zone"
        @dragover="onHookedDragOver"
        @dragleave="leaves($event) && (gap = null)"
        @drop.prevent="onHookedDrop"
      >
        <ul class="browser-list">
          <template v-for="(block, i) in hooked" :key="block.id">
            <li class="browser-gap" :class="{ active: gap === i }" />
            <li
              class="browser-item"
              :class="{ dragging: dragged?.id === block.id }"
              draggable="true"
              @dragstart="onDragStart($event, block, false)"
              @dragend="onDragEnd"
              @click="revealBlock(block.id)"
            >
              <span class="browser-preview">{{ preview(block) }}</span>
            </li>
          </template>
          <li class="browser-gap" :class="{ active: gap === hooked.length }" />
        </ul>
      </div>

      <p class="browser-heading">Unhooked</p>
      <div
        class="browser-zone unhooked-zone"
        :class="{ over: overUnhooked }"
        @dragover="onUnhookedDragOver"
        @dragleave="leaves($event) && (overUnhooked = false)"
        @drop.prevent="onUnhookedDrop"
      >
        <p v-if="!floating.length" class="browser-hint">Drag a block here to unhook it.</p>
        <ul v-else class="browser-list">
          <li
            v-for="block in floating"
            :key="block.id"
            class="browser-item"
            :class="{ dragging: dragged?.id === block.id }"
            draggable="true"
            @dragstart="onDragStart($event, block, true)"
            @dragend="onDragEnd"
            @click="revealBlock(block.id)"
          >
            <span class="browser-preview">{{ preview(block) }}</span>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<style scoped>
.block-browser {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0.5rem;
}

.browser-hint {
  padding: 0.25rem 0.4rem;
  font-size: 0.8rem;
  color: var(--color-text);
  opacity: 0.6;
}

.browser-filter-input {
  display: block;
  width: calc(100% - 0.8rem);
  box-sizing: border-box;
  font: inherit;
  font-size: 0.8rem;
  color: var(--color-text-strong);
  background: rgb(var(--tint) / 0.06);
  border: 1px solid var(--color-border-hover);
  border-radius: 4px;
  padding: 0.3rem 0.5rem;
  margin: 0.25rem 0.4rem 0.5rem;
}

.browser-filter-input:focus {
  outline: none;
  border-color: var(--color-accent);
}

.browser-heading {
  margin: 0.75rem 0.4rem 0.25rem;
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--color-text);
}

/* Drop areas: kept at least a row tall, so an empty list can still be dropped on. */
.browser-zone {
  min-height: 1.75rem;
  border-radius: 4px;
}

.unhooked-zone.over {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  outline: 1px dashed var(--color-accent);
}

.browser-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.browser-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.4rem;
  margin: 0.1rem 0;
  font-size: 0.85rem;
  border-radius: 4px;
  cursor: pointer;
}

.browser-item:hover {
  background: rgb(var(--tint) / 0.08);
}

.browser-item.dragging {
  opacity: 0.4;
}

/* Where a dragged row would land; lights up between rows. */
.browser-gap {
  height: 6px;
  margin: -3px 0;
  border-radius: 3px;
}

.browser-gap.active {
  background: var(--color-accent);
}

.browser-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
