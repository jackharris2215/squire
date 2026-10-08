<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { renderBlock } from './markdown'
import { handleWidgetEvent } from './variables'
import { parseTable, serializeTable, type TableData } from './table'
import { createNote, selectFile, validateTitle } from './store'

// A markdown table shown as an editable grid. The block's content stays a
// markdown string: every cell edit is written straight back as markdown. Only
// the cell being edited is a plain input, raw; every other cell shows its
// rendered markdown (bold, [[links]], etc.), the same as a text block, and
// clicking one (outside a link) swaps it into the input to edit it.
const props = defineProps<{ modelValue: string; align?: 'left' | 'center' | 'right'; notePath: string | null }>()

// Positions the table itself within the block (not the text in its cells).
const tablePosition = computed(() => ({
  marginLeft: props.align === 'center' || props.align === 'right' ? 'auto' : undefined,
  marginRight: props.align === 'center' ? 'auto' : undefined,
}))
const emit = defineEmits<{
  'update:modelValue': [value: string]
  // Right-click on a cell: row is -1 for the header row.
  menu: [event: MouseEvent, row: number, col: number]
}>()

const grid = ref<TableData>(parseTable(props.modelValue) ?? { header: [], rows: [], align: [] })

// Pick up outside changes (e.g. a reload), but not the echo of our own edits;
// re-parsing those would be wasted work.
watch(
  () => props.modelValue,
  (value) => {
    if (value === serializeTable(grid.value)) return
    const parsed = parseTable(value)
    if (parsed) grid.value = parsed
  },
)

// row -1 is the header row.
function onCellInput(event: Event, row: number, col: number) {
  const value = (event.target as HTMLInputElement).value
  if (row === -1) grid.value.header[col] = value
  else grid.value.rows[row]![col] = value
  emit('update:modelValue', serializeTable(grid.value))
}

// A right-click on a cell reports which cell it was; anywhere else on the table
// is left alone so the block's own menu handles it.
function onContextMenu(event: MouseEvent) {
  const cell = (event.target as HTMLElement).closest('td, th') as HTMLTableCellElement | null
  const tableRow = cell?.parentElement as HTMLTableRowElement | null
  if (!cell || !tableRow) return
  event.preventDefault()
  event.stopPropagation()
  emit('menu', event, tableRow.rowIndex - 1, cell.cellIndex) // rowIndex 0 is the header
}

// --- Editing one cell at a time: every other cell shows its rendered markdown;
// clicking one (outside a link) opens it as a plain input, raw. ---

const editingCell = ref<{ row: number; col: number } | null>(null) // row -1 is the header
const cellInputs = new Map<string, HTMLInputElement>()
const cellKey = (row: number, col: number) => `${row}:${col}`

function isEditingCell(row: number, col: number) {
  return editingCell.value?.row === row && editingCell.value?.col === col
}

function setCellInputRef(row: number, col: number, el: Element | null) {
  const key = cellKey(row, col)
  if (el) cellInputs.set(key, el as HTMLInputElement)
  else cellInputs.delete(key)
}

function startEditingCell(row: number, col: number) {
  editingCell.value = { row, col }
  nextTick(() => cellInputs.get(cellKey(row, col))?.focus())
}

// Only clears the state if it's still this cell's: moving to another cell (Enter,
// Tab) unmounts this one's focused input, which fires a native blur on it after
// the new cell is already set, which would otherwise wipe that out.
function stopEditingCell(row: number, col: number) {
  if (isEditingCell(row, col)) editingCell.value = null
}

// Clicking a [[link]] in a rendered cell follows it instead of opening the cell.
function onCellClick(event: MouseEvent, row: number, col: number) {
  if (handleWidgetEvent(event, props.notePath)) return // a widget in the cell handles its own click
  const link = (event.target as HTMLElement).closest('.note-link') as HTMLElement | null
  if (link) {
    event.preventDefault()
    const path = link.dataset.path
    const title = link.dataset.title
    if (path) selectFile(path)
    // A name a note can't actually have (the dots in "file.txt", say) just leaves
    // the link missing rather than silently creating something no rename dialog
    // would ever accept.
    else if (title && validateTitle(title, undefined) === null) createNote(title)
    return
  }
  // A plain markdown link (an external URL): the browser opens it in a new tab
  // (see markdown.ts's link renderer) rather than starting to edit the cell.
  if ((event.target as HTMLElement).closest('a')) return
  startEditingCell(row, col)
}

// Enter moves down to the same column in the next row, like a spreadsheet.
function onCellEnter(row: number, col: number) {
  if (row + 1 <= grid.value.rows.length - 1) startEditingCell(row + 1, col)
}

// Escape leaves the cell without moving anywhere.
function onCellEscape(event: KeyboardEvent) {
  ;(event.target as HTMLInputElement).blur()
}

// Tab moves to the next cell (Shift+Tab the previous one), wrapping to the start
// or end of the next/previous row; it stops instead of leaving the table at
// either end.
function onCellTab(event: KeyboardEvent, row: number, col: number) {
  event.preventDefault()
  const cols = grid.value.header.length
  let nextRow = row
  let nextCol = col + (event.shiftKey ? -1 : 1)
  if (nextCol >= cols) {
    nextCol = 0
    nextRow++
  } else if (nextCol < 0) {
    nextCol = cols - 1
    nextRow--
  }
  if (nextRow < -1 || nextRow > grid.value.rows.length - 1) return
  startEditingCell(nextRow, nextCol)
}
</script>

<template>
  <table class="table-block" :style="tablePosition" @click.stop @contextmenu="onContextMenu">
    <thead>
      <tr>
        <th v-for="(cell, col) in grid.header" :key="col">
          <div class="table-cell">
            <template v-if="isEditingCell(-1, col)">
              <span class="table-cell-sizer">{{ cell || ' ' }}</span>
              <input
                class="table-cell-input"
                :ref="(el) => setCellInputRef(-1, col, el as Element | null)"
                :value="cell"
                :style="{ textAlign: grid.align[col] ?? 'left' }"
                @input="onCellInput($event, -1, col)"
                @keydown.enter.prevent="onCellEnter(-1, col)"
                @keydown.esc="onCellEscape"
                @keydown.tab="onCellTab($event, -1, col)"
                @blur="stopEditingCell(-1, col)"
              />
            </template>
            <div
              v-else
              class="table-cell-rendered"
              :style="{ textAlign: grid.align[col] ?? 'left' }"
              @click="onCellClick($event, -1, col)"
              @change="handleWidgetEvent($event, notePath)"
              v-html="renderBlock(cell, notePath) || '&nbsp;'"
            />
          </div>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(row, rowIndex) in grid.rows" :key="rowIndex">
        <td v-for="(cell, col) in row" :key="col">
          <div class="table-cell">
            <template v-if="isEditingCell(rowIndex, col)">
              <span class="table-cell-sizer">{{ cell || ' ' }}</span>
              <input
                class="table-cell-input"
                :ref="(el) => setCellInputRef(rowIndex, col, el as Element | null)"
                :value="cell"
                :style="{ textAlign: grid.align[col] ?? 'left' }"
                @input="onCellInput($event, rowIndex, col)"
                @keydown.enter.prevent="onCellEnter(rowIndex, col)"
                @keydown.esc="onCellEscape"
                @keydown.tab="onCellTab($event, rowIndex, col)"
                @blur="stopEditingCell(rowIndex, col)"
              />
            </template>
            <div
              v-else
              class="table-cell-rendered"
              :style="{ textAlign: grid.align[col] ?? 'left' }"
              @click="onCellClick($event, rowIndex, col)"
              @change="handleWidgetEvent($event, notePath)"
              v-html="renderBlock(cell, notePath) || '&nbsp;'"
            />
          </div>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.table-block {
  border-collapse: collapse;
  max-width: 100%;
}

.table-block th,
.table-block td {
  padding: 0;
  border: 1px solid var(--color-border-hover);
}

/* The header row looks like any other row: the browser's bold is switched off. */
.table-block th {
  font-weight: inherit;
}

/* The invisible sizer gives the editing cell the width of its raw text; the
   input is laid over it so the editable area fills the whole cell. */
.table-cell {
  position: relative;
}

.table-cell-sizer,
.table-cell-input,
.table-cell-rendered {
  font: inherit;
  padding: 0.3rem 0.75rem;
}

.table-cell-sizer {
  display: block;
  min-width: 3rem;
  white-space: pre;
  visibility: hidden;
}

.table-cell-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  color: inherit;
  background: transparent;
  border: none;
  outline: none;
}

.table-cell-rendered {
  min-width: 3rem;
  min-height: 1.5em;
  color: inherit;
  cursor: text;
}

/* renderBlock wraps even a single line in a <p>; a cell has no room for its
   margin. */
.table-cell-rendered :deep(p) {
  margin: 0;
}

.table-cell-input:focus {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  box-shadow: inset 0 0 0 1px var(--color-accent);
}
</style>
