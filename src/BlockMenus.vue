<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ALIGNMENTS, COLORS } from './blocks'
import { allBlocks, breakUndoStep, findAnyBlock, findBlockPosition, hookBlock, noteCache } from './store'
import { parseTable, serializeTable, type TableData } from './table'
import type { Block, MenuContext } from './types'
import { randomUUID } from './uuid'

// The three right-click menus inside a note: one for a block (alignment, text
// color, background), one for a table cell (row and column operations), and one
// for the blank area below the last block (insert a table, checklist or bulleted
// list there). The parent opens and closes them (defineExpose below), since
// clicking elsewhere or opening another menu closes these.
const blockMenu = ref<{ ctx: MenuContext; blockId: string; x: number; y: number } | null>(null)
const tableMenu = ref<{ ctx: MenuContext; blockId: string; x: number; y: number; row: number; col: number } | null>(null)
const blankMenu = ref<{ path: string; x: number; y: number } | null>(null)

const blockMenuEl = ref<HTMLElement | null>(null)
const tableMenuEl = ref<HTMLElement | null>(null)
const blankMenuEl = ref<HTMLElement | null>(null)

// Once a menu is on screen, measure it and slide it up or left if it runs past the
// window's edge.
// The element is looked up after the render: on a first open it doesn't exist yet.
async function keepOnScreen(menu: { x: number; y: number } | null, getEl: () => HTMLElement | null) {
  await nextTick()
  const el = getEl()
  if (!menu || !el) return
  const { width, height } = el.getBoundingClientRect()
  menu.x = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))
  menu.y = Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))
}

function openBlock(event: MouseEvent, block: Block, ctx: MenuContext) {
  tableMenu.value = null
  blankMenu.value = null
  blockMenu.value = { ctx, blockId: block.id, x: event.clientX, y: event.clientY }
  keepOnScreen(blockMenu.value, () => blockMenuEl.value)
}

// row is -1 for the header row.
function openTable(event: MouseEvent, block: Block, ctx: MenuContext, row: number, col: number) {
  blockMenu.value = null
  blankMenu.value = null
  tableMenu.value = { ctx, blockId: block.id, x: event.clientX, y: event.clientY, row, col }
  keepOnScreen(tableMenu.value, () => tableMenuEl.value)
}

function openBlank(event: MouseEvent, path: string) {
  blockMenu.value = null
  tableMenu.value = null
  blankMenu.value = { path, x: event.clientX, y: event.clientY }
  keepOnScreen(blankMenu.value, () => blankMenuEl.value)
}

function close() {
  blockMenu.value = null
  tableMenu.value = null
  blankMenu.value = null
}

defineExpose({ openBlock, openTable, openBlank, close })

// The note of the pane the open menu came from, and that pane's selection.
const menuContext = computed(() => (blockMenu.value ?? tableMenu.value)?.ctx)
const note = computed(() => {
  const path = menuContext.value?.path
  return path ? noteCache.get(path) : undefined
})

// The block a menu is open for, through the note's reactive data so that
// changing it re-renders the block and triggers a save.
function blockById(id: string | undefined) {
  return id ? findAnyBlock(note.value, id) : undefined
}

// --- Block menu: changing a setting leaves the menu open ---

const menuBlock = computed(() => blockById(blockMenu.value?.blockId))

// The blocks the menu acts on: all the Ctrl+clicked blocks if it was opened on one
// of them, otherwise just the block it was opened on. In document order.
const targetBlocks = computed(() => {
  const block = menuBlock.value
  if (!block) return []
  const selected = menuContext.value?.selectedIds ?? []
  if (selected.length > 1 && selected.includes(block.id)) {
    return allBlocks(note.value).filter((b) => selected.includes(b.id))
  }
  return [block]
})

const targetLabel = computed(() => (targetBlocks.value.length > 1 ? `${targetBlocks.value.length} blocks` : 'block'))

function setBlockSetting<K extends 'align' | 'textColor' | 'background'>(field: K, value: NonNullable<Block[K]>) {
  for (const block of targetBlocks.value) block[field] = value
}

// Both close the menu and need no confirmation: undo brings the blocks back. A copy
// goes in its own row just below the original, even if the original is a column.
function duplicateBlock() {
  if (!note.value) return
  for (const block of [...targetBlocks.value]) {
    const copy = { ...JSON.parse(JSON.stringify(block)), id: `block-${randomUUID()}` }
    const pos = findBlockPosition(note.value, block.id)
    if (pos) {
      note.value.blocks.splice(pos.rowIndex + 1, 0, [copy as Block])
      continue
    }
    // A floating block's copy floats a little down and right of it, in front.
    const floating = note.value.floating
    const original = floating?.find((b) => b.id === block.id)
    if (!floating || !original) continue
    floating.push({ ...copy, x: original.x + 24, y: original.y + 24, z: Math.max(...floating.map((b) => b.z)) + 1 })
  }
  menuContext.value?.clearSelection()
  close()
}

// Unhook acts on the targeted blocks that are in the flow, Hook back on the floating
// ones, so a mixed selection can show both.
const hookedTargets = computed(() => targetBlocks.value.filter((b) => findBlockPosition(note.value, b.id)))
const floatingTargets = computed(() => targetBlocks.value.filter((b) => !findBlockPosition(note.value, b.id)))

function unhookBlocks() {
  menuContext.value?.unhook(hookedTargets.value.map((b) => b.id))
  menuContext.value?.clearSelection()
  close()
}

function hookBlocks() {
  const path = menuContext.value?.path
  if (path) for (const block of floatingTargets.value.map((b) => b.id)) hookBlock(path, block)
  menuContext.value?.clearSelection()
  close()
}

function deleteBlock() {
  if (!note.value) return
  for (const block of [...targetBlocks.value]) {
    const pos = findBlockPosition(note.value, block.id)
    if (pos) {
      const row = note.value.blocks[pos.rowIndex]!
      row.splice(pos.colIndex, 1)
      if (row.length === 0) note.value.blocks.splice(pos.rowIndex, 1)
      continue
    }
    const floating = note.value.floating
    const index = floating?.findIndex((b) => b.id === block.id) ?? -1
    if (!floating || index === -1) continue
    floating.splice(index, 1)
    if (!floating.length) delete note.value.floating // the field exists only while a block floats
  }
  menuContext.value?.clearSelection()
  close()
}

// --- Blank-area menu: adds a new block of the given kind at the end of the note,
// the same kinds a click there would let you type manually. ---

const NEW_BLOCK_CONTENT = {
  table: serializeTable({ header: ['', ''], rows: [['', '']], align: [null, null] }),
  checklist: '- [ ] ',
  bulletlist: '- ',
} as const

function insertNewBlock(kind: keyof typeof NEW_BLOCK_CONTENT) {
  const path = blankMenu.value?.path
  const target = path && noteCache.get(path)
  if (!target) return
  target.blocks.push([{ id: `block-${randomUUID()}`, type: kind, content: NEW_BLOCK_CONTENT[kind] }])
  close()
}

// --- Table menu: row and column operations relative to the clicked cell ---

const tableMenuBlock = computed(() => blockById(tableMenu.value?.blockId))

// Which operations make sense for the clicked cell. The header row can't be
// deleted or moved, and a table keeps at least one column.
const tableMenuState = computed(() => {
  const menu = tableMenu.value
  const table = tableMenuBlock.value && parseTable(tableMenuBlock.value.content)
  if (!menu || !table) return null
  const lastRow = table.rows.length - 1
  const lastCol = table.header.length - 1
  return {
    columnAlign: table.align[menu.col] ?? 'left',
    canDeleteRow: menu.row >= 0,
    canMoveRowUp: menu.row > 0,
    canMoveRowDown: menu.row >= 0 && menu.row < lastRow,
    canDeleteColumn: lastCol > 0,
    canMoveColumnLeft: menu.col > 0,
    canMoveColumnRight: menu.col < lastCol,
  }
})

// Rewrites the table's markdown with a change applied to its data, then closes
// the menu.
function editTable(change: (table: TableData, row: number, col: number) => void, closeAfter = true) {
  const block = tableMenuBlock.value
  const menu = tableMenu.value
  const table = block && parseTable(block.content)
  if (!block || !menu || !table) return
  breakUndoStep(menu.ctx.path) // a table operation is an undo step of its own
  change(table, menu.row, menu.col)
  block.content = serializeTable(table)
  if (closeAfter) close()
}

// Alignment is a property of the whole column, as in markdown. The menu stays
// open so the toggle can be changed again.
const alignColumn = (value: 'left' | 'center' | 'right') =>
  editTable((t, _row, col) => (t.align[col] = value), false)

const swap = <T,>(items: T[], i: number, j: number) => ([items[i], items[j]] = [items[j]!, items[i]!])

// New rows and columns go after the clicked cell's; from the header row, a new
// row becomes the first row of the body.
const insertRow = () => editTable((t, row) => t.rows.splice(row + 1, 0, t.header.map(() => '')))
const deleteRow = () => editTable((t, row) => t.rows.splice(row, 1))
const moveRow = (by: -1 | 1) => editTable((t, row) => swap(t.rows, row, row + by))

const insertColumn = () =>
  editTable((t, _row, col) => {
    t.header.splice(col + 1, 0, '')
    t.align.splice(col + 1, 0, null)
    for (const row of t.rows) row.splice(col + 1, 0, '')
  })
const deleteColumn = () =>
  editTable((t, _row, col) => {
    t.header.splice(col, 1)
    t.align.splice(col, 1)
    for (const row of t.rows) row.splice(col, 1)
  })
const moveColumn = (by: -1 | 1) =>
  editTable((t, _row, col) => {
    for (const cells of [t.header, t.align, ...t.rows]) swap(cells as unknown[], col, col + by)
  })
</script>

<template>
  <div
    v-if="blockMenu && menuBlock"
    ref="blockMenuEl"
    class="context-menu block-menu"
    :style="{ left: blockMenu.x + 'px', top: blockMenu.y + 'px' }"
    @click.stop
    @mousedown.prevent
    @contextmenu.prevent.stop
  >
    <button class="context-item" @click="duplicateBlock">Duplicate {{ targetLabel }}</button>
    <button v-if="hookedTargets.length" class="context-item" @click="unhookBlocks">
      Unhook {{ hookedTargets.length > 1 ? `${hookedTargets.length} blocks` : 'block' }}
    </button>
    <button v-if="floatingTargets.length" class="context-item" @click="hookBlocks">
      Hook back {{ floatingTargets.length > 1 ? `${floatingTargets.length} blocks` : 'block' }}
    </button>
    <button class="settings-delete" @click="deleteBlock">Delete {{ targetLabel }}</button>
    <div class="context-separator" />

    <div class="settings-label">Alignment</div>
    <div class="segmented">
      <button
        v-for="a in ALIGNMENTS"
        :key="a.value"
        class="segment"
        :class="{ active: (menuBlock.align ?? 'left') === a.value }"
        :title="a.label"
        :aria-label="a.label"
        @click="setBlockSetting('align', a.value)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path :d="a.icon" />
        </svg>
      </button>
    </div>

    <div class="settings-label">Text color</div>
    <div class="swatches">
      <button
        v-for="c in COLORS"
        :key="c.key"
        class="swatch swatch-text"
        :class="{ selected: (menuBlock.textColor ?? 'default') === c.key, 'is-default': c.key === 'default' }"
        :style="{ '--swatch': c.text || 'var(--color-text-strong)' }"
        :title="c.label"
        :aria-label="`Text color: ${c.label}`"
        @click="setBlockSetting('textColor', c.key)"
      />
    </div>

    <div class="settings-label">Background</div>
    <div class="swatches">
      <button
        v-for="c in COLORS"
        :key="c.key"
        class="swatch swatch-bg"
        :class="{ selected: (menuBlock.background ?? 'default') === c.key, 'is-default': c.key === 'default' }"
        :style="{ '--swatch': c.background || 'transparent' }"
        :title="c.label"
        :aria-label="`Background: ${c.label}`"
        @click="setBlockSetting('background', c.key)"
      />
    </div>

  </div>

  <div
    v-if="blankMenu"
    ref="blankMenuEl"
    class="context-menu"
    :style="{ left: blankMenu.x + 'px', top: blankMenu.y + 'px' }"
    @click.stop
    @mousedown.prevent
    @contextmenu.prevent.stop
  >
    <button class="context-item" @click="insertNewBlock('table')">Insert table</button>
    <button class="context-item" @click="insertNewBlock('checklist')">Insert checklist</button>
    <button class="context-item" @click="insertNewBlock('bulletlist')">Insert bulleted list</button>
  </div>

  <div
    v-if="tableMenu && tableMenuBlock && tableMenuState"
    ref="tableMenuEl"
    class="context-menu"
    :style="{ left: tableMenu.x + 'px', top: tableMenu.y + 'px' }"
    @click.stop
    @mousedown.prevent
    @contextmenu.prevent.stop
  >
    <div class="menu-group-label">Column alignment</div>
    <div class="segmented table-align">
      <button
        v-for="a in ALIGNMENTS"
        :key="a.value"
        class="segment"
        :class="{ active: tableMenuState.columnAlign === a.value }"
        :title="a.label"
        :aria-label="a.label"
        @click="alignColumn(a.value)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path :d="a.icon" />
        </svg>
      </button>
    </div>
    <div class="context-separator" />
    <div class="menu-group-label">Row</div>
    <button class="context-item" @click="insertRow">Insert row</button>
    <button class="context-item" :disabled="!tableMenuState.canMoveRowUp" @click="moveRow(-1)">Move row up</button>
    <button class="context-item" :disabled="!tableMenuState.canMoveRowDown" @click="moveRow(1)">Move row down</button>
    <button class="settings-delete" :disabled="!tableMenuState.canDeleteRow" @click="deleteRow">Delete row</button>
    <div class="context-separator" />
    <div class="menu-group-label">Column</div>
    <button class="context-item" @click="insertColumn">Insert column</button>
    <button class="context-item" :disabled="!tableMenuState.canMoveColumnLeft" @click="moveColumn(-1)">Move column left</button>
    <button class="context-item" :disabled="!tableMenuState.canMoveColumnRight" @click="moveColumn(1)">Move column right</button>
    <button class="settings-delete" :disabled="!tableMenuState.canDeleteColumn" @click="deleteColumn">Delete column</button>
  </div>
</template>

<style scoped>
.table-align {
  margin: 0.15rem 0.5rem 0;
}

.block-menu {
  padding: 0.6rem 0.75rem;
}

.block-menu .settings-label {
  margin-top: 0.6rem;
}

.block-menu .context-separator + .settings-label {
  margin-top: 0;
}

.block-menu .swatches + .context-separator {
  margin-top: 0.7rem;
}

.swatches {
  display: flex;
  gap: 0.5rem;
}

.swatch {
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  border: 1px solid rgb(var(--tint) / 0.15);
  cursor: pointer;
  outline: 2px solid transparent;
  outline-offset: 2px;
}

.swatch-text {
  border-radius: 50%;
  background: var(--swatch);
}

.swatch-bg {
  border-radius: 5px;
  background: var(--swatch);
}

.swatch.is-default {
  border-style: dashed;
}

.swatch.selected {
  outline-color: var(--color-text-strong);
}
</style>
