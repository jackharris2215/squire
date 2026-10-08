<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Editor from './Editor.vue'
import { draggedNotePath } from './dragNote'
import { closePane, focusedPaneId, panes, setFocus, topRightPaneId, type LayoutNode, type Pane, type Split } from './layout'
import { isLoadingPath, openInPane, openInSplit, paneBack, paneForward } from './store'
import type { Block, MenuContext } from './types'

// Draws a layout node: a pane is an Editor, a split is its children side by side
// (or stacked) with a draggable divider between each pair. It draws itself for the
// children. Menu requests from the editors are passed up to App.vue unchanged.
const props = defineProps<{ node: LayoutNode }>()

type BlockMenuArgs = [MouseEvent, Block, MenuContext]
type TableMenuArgs = [MouseEvent, Block, MenuContext, number, number]
type BlankMenuArgs = [MouseEvent, string]

const emit = defineEmits<{
  'block-menu': BlockMenuArgs
  'table-menu': TableMenuArgs
  'blank-menu': BlankMenuArgs
}>()

// Only worth showing which pane has the focus when there is more than one.
const several = computed(() => panes().length > 1)

// Dropping a note dragged from the sidebar: the middle of a pane opens it there,
// an edge splits the pane and puts the note on that side. An empty pane has only
// the middle.
type Zone = 'center' | 'left' | 'right' | 'top' | 'bottom'
const EDGE = 0.25 // how far in from each edge the edge zones reach, as a share of the pane
const zone = ref<Zone | null>(null)

watch(draggedNotePath, (path) => {
  if (!path) zone.value = null
})

function zoneAt(event: DragEvent, pane: Pane): Zone {
  if (!pane.path) return 'center'
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = (event.clientX - rect.left) / rect.width
  const y = (event.clientY - rect.top) / rect.height
  const nearX = Math.min(x, 1 - x)
  const nearY = Math.min(y, 1 - y)
  if (Math.min(nearX, nearY) >= EDGE) return 'center'
  if (nearX < nearY) return x < 0.5 ? 'left' : 'right'
  return y < 0.5 ? 'top' : 'bottom'
}

function onNoteDragOver(event: DragEvent, pane: Pane) {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  zone.value = zoneAt(event, pane)
}

function onNoteDragLeave(event: DragEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) zone.value = null
}

function onNoteDrop(event: DragEvent, pane: Pane) {
  event.preventDefault()
  const path = draggedNotePath.value
  const where = zoneAt(event, pane)
  zone.value = null
  draggedNotePath.value = null
  if (!path) return
  if (where === 'center') openInPane(pane.id, path)
  else openInSplit(path, where, pane.id)
}

const MIN_PANE_PX = 200
const splitEl = ref<HTMLElement | null>(null)
const resizing = ref(false)

// Dragging the divider before child `index` moves space between the two children
// beside it.
function startResize(event: MouseEvent, index: number) {
  const split = props.node as Split
  const container = splitEl.value
  if (!container) return
  const horizontal = split.direction === 'row'
  const rect = container.getBoundingClientRect()
  const total = horizontal ? rect.width : rect.height
  const origin = horizontal ? event.clientX : event.clientY
  const before = split.sizes[index - 1]!
  const after = split.sizes[index]!
  const min = Math.min(MIN_PANE_PX / total, (before + after) / 2)
  resizing.value = true

  const onMove = (e: MouseEvent) => {
    const delta = ((horizontal ? e.clientX : e.clientY) - origin) / total
    const newBefore = Math.min(Math.max(before + delta, min), before + after - min)
    split.sizes[index - 1] = newBefore
    split.sizes[index] = before + after - newBefore
  }
  const onUp = () => {
    resizing.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
</script>

<template>
  <div
    v-if="node.kind === 'pane'"
    class="pane"
    :class="{ focused: several && node.id === focusedPaneId }"
    @mousedown.capture="setFocus(node.id)"
    @focusin="setFocus(node.id)"
  >
    <Editor
      :path="node.path"
      :loading="isLoadingPath(node.path)"
      :focused="node.id === focusedPaneId"
      :can-back="node.back.length > 0"
      :can-forward="node.forward.length > 0"
      :right-panel-button="node.id === topRightPaneId()"
      @block-menu="(...args: BlockMenuArgs) => emit('block-menu', ...args)"
      @table-menu="(...args: TableMenuArgs) => emit('table-menu', ...args)"
      @blank-menu="(...args: BlankMenuArgs) => emit('blank-menu', ...args)"
      @back="paneBack(node.id)"
      @forward="paneForward(node.id)"
      @close="closePane(node.id)"
    />
    <div
      v-if="draggedNotePath"
      class="drop-overlay"
      @dragover="onNoteDragOver($event, node)"
      @dragleave="onNoteDragLeave"
      @drop="onNoteDrop($event, node)"
    >
      <div v-if="zone" class="drop-preview" :class="zone" />
    </div>
  </div>

  <div v-else ref="splitEl" class="split" :class="[node.direction, { resizing }]">
    <template v-for="(child, i) in node.children" :key="child.id">
      <div v-if="i > 0" class="divider" @mousedown.prevent="startResize($event, i)" />
      <div class="split-child" :style="{ flex: `${node.sizes[i]} 1 0` }">
        <PaneLayout
          :node="child"
          @block-menu="(...args: BlockMenuArgs) => emit('block-menu', ...args)"
          @table-menu="(...args: TableMenuArgs) => emit('table-menu', ...args)"
          @blank-menu="(...args: BlankMenuArgs) => emit('blank-menu', ...args)"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.pane {
  position: relative;
  flex: 1;
  display: flex;
  min-width: 0;
  min-height: 0;
}

/* A thin outline on the pane that has the focus, drawn over the pane without
   catching the mouse. */
.pane.focused::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px solid color-mix(in srgb, var(--color-accent) 55%, transparent);
  pointer-events: none;
  z-index: 5;
}

/* Covers the pane while a note is dragged over from the sidebar; the preview shows
   what a drop would do. */
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
}

.drop-preview {
  position: absolute;
  background: color-mix(in srgb, var(--color-accent) 22%, transparent);
  border: 2px solid var(--color-accent);
  pointer-events: none;
}

.drop-preview.center {
  inset: 0;
}

.drop-preview.left {
  inset: 0 50% 0 0;
}

.drop-preview.right {
  inset: 0 0 0 50%;
}

.drop-preview.top {
  inset: 0 0 50% 0;
}

.drop-preview.bottom {
  inset: 50% 0 0 0;
}

.split {
  flex: 1;
  display: flex;
  min-width: 0;
  min-height: 0;
}

.split.row {
  flex-direction: row;
}

.split.column {
  flex-direction: column;
}

.split.resizing {
  user-select: none;
}

.split-child {
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.divider {
  flex-shrink: 0;
  background: var(--color-border);
  transition: background 0.15s;
}

.split.row > .divider {
  width: 4px;
  cursor: col-resize;
}

.split.column > .divider {
  height: 4px;
  cursor: row-resize;
}

.divider:hover,
.split.resizing > .divider {
  background: var(--color-accent);
}
</style>
