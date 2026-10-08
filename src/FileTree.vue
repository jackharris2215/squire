<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { SidebarRow } from './types'
import { draggedNotePath } from './dragNote'
import { registerTreeReveal } from './locate'
import { renaming } from './overlay'
import FileIcon from './FileIcon.vue'
import { blocksFromMarkdown } from './markdownImport'
import {
  allFolderPaths,
  baseName,
  collapsedFolders,
  config,
  createFolder,
  createNewNote,
  createNote,
  imageList,
  moveItem,
  nameFromPath,
  noteList,
  pdfList,
  renameEntry,
  sanitizeName,
  selectedFile,
  selectFile,
} from './store'

// The sidebar's note tree: the new note and folder buttons, then the notebook laid
// out as nested folders and notes. Right-clicking a row is reported to the parent.
const emit = defineEmits<{ 'row-menu': [event: MouseEvent, row: SidebarRow] }>()

// The tree mirrors the notebook: folders first (alphabetical), then the notes
// directly inside, each folder's contents nested under it. Paths use "/".
const allFolders = computed(() => allFolderPaths())

const sidebarRows = computed<SidebarRow[]>(() => {
  const folderPaths = allFolders.value

  const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
  const rows: SidebarRow[] = []

  function walk(parent: string, depth: number) {
    const subfolders = [...folderPaths].filter((f) => parentOf(f) === parent).sort((a, b) => a.localeCompare(b))
    for (const folder of subfolders) {
      rows.push({ kind: 'folder', path: folder, label: folder.slice(folder.lastIndexOf('/') + 1), depth })
      if (!collapsedFolders.value.has(folder)) walk(folder, depth + 1)
    }
    const filesHere: SidebarRow[] = [
      ...noteList.value
        .filter((entry) => parentOf(entry.path) === parent)
        .map((entry) => ({ kind: 'note' as const, path: entry.path, label: entry.title, depth })),
      ...(config.value.showImagesInTree === false ? [] : imageList.value)
        .filter((path) => parentOf(path) === parent)
        .map((path) => ({ kind: 'image' as const, path, label: baseName(path), depth })),
      ...(config.value.showPdfsInTree === false ? [] : pdfList.value)
        .filter((path) => parentOf(path) === parent)
        .map((path) => ({ kind: 'pdf' as const, path, label: baseName(path), depth })),
    ]
    filesHere.sort((a, b) => a.label.localeCompare(b.label))
    rows.push(...filesHere)
  }

  walk('', 0)
  return rows
})

// Renaming in place: "Rename" in the right-click menu turns a row's name into an input.
// Enter or leaving the box renames it, if the new name is valid (Enter with a bad name
// keeps the box open and shows why; leaving with one puts the old name back); Escape
// puts the old name back. The input is focused and its text selected when it appears.
const renameDraft = ref('')
const renameError = ref<string | null>(null)
let renameBusy = false

const vRenameFocus = {
  mounted(el: HTMLInputElement) {
    el.focus()
    el.select()
  },
}

function isRenaming(row: SidebarRow) {
  return renaming.value?.kind === row.kind && renaming.value.path === row.path
}

watch(renaming, (target) => {
  renameError.value = null
  const row = target && sidebarRows.value.find((r) => r.kind === target.kind && r.path === target.path)
  // An image's or PDF's label has its extension; the name being renamed doesn't.
  renameDraft.value = !row ? '' : row.kind === 'image' || row.kind === 'pdf' ? nameFromPath(row.path) : row.label
})

function cancelRename() {
  renaming.value = null
}

async function commitRename(fromEnter: boolean) {
  const target = renaming.value
  if (!target || target.kind === 'bookmark-folder' || renameBusy) return
  renameBusy = true
  const error = await renameEntry(target.kind, target.path, renameDraft.value.trim())
  renameBusy = false
  if (error && fromEnter) renameError.value = error
  else renaming.value = null
}

// Import: a markdown file becomes a note of the same name (sanitized, with a
// collision suffix if needed), its content split into blocks by blocksFromMarkdown.
// Several files import one at a time (not in parallel): createNote picks each
// note's name from the current file list, so two files due to collide with the same
// name need to go one after another or they'd both compute the same free name.
const importInput = ref<HTMLInputElement | null>(null)

function startImport() {
  importInput.value?.click()
}

async function onImportChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = '' // so picking the same file(s) again still fires @change
  for (const file of files) {
    const text = await file.text()
    const title = sanitizeName(file.name.replace(/\.(md|markdown)$/i, ''))
    await createNote(title, '', blocksFromMarkdown(text))
  }
}

function collapseAll() {
  collapsedFolders.value = new Set(allFolders.value)
}

function expandAll() {
  collapsedFolders.value = new Set()
}

// The open note's row is only highlighted while the tree is the thing in use: it lights
// up when a note or image row is pressed, and goes out on a press anywhere else in the
// app, or when the window loses focus.
const treeActive = ref(false)

function onWindowMouseDown(event: MouseEvent) {
  const target = event.target as Element | null
  treeActive.value = event.button === 0 && !!target?.closest?.('.file-list li:not(.folder-row)')
}

const onWindowBlur = () => (treeActive.value = false)

// "Locate in browser" (the note settings menu): expands every ancestor folder of
// path, if collapsed, then scrolls its row into view. The row itself is a plain
// DOM lookup rather than a CSS selector built from the path, since a path can
// contain characters that aren't safe to drop straight into one.
function revealRow(path: string) {
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) collapsedFolders.value.delete(parts.slice(0, i).join('/'))
  nextTick(() => {
    const row = Array.from(document.querySelectorAll<HTMLElement>('.file-list li')).find(
      (li) => li.dataset.path === path,
    )
    row?.scrollIntoView({ block: 'center' })
  })
}

let unregisterReveal: () => void

onMounted(() => {
  window.addEventListener('mousedown', onWindowMouseDown)
  window.addEventListener('blur', onWindowBlur)
  unregisterReveal = registerTreeReveal(revealRow)
})

onUnmounted(() => {
  window.removeEventListener('mousedown', onWindowMouseDown)
  window.removeEventListener('blur', onWindowBlur)
  unregisterReveal()
})

function toggleFolder(path: string) {
  if (collapsedFolders.value.has(path)) collapsedFolders.value.delete(path)
  else collapsedFolders.value.add(path)
}

// Dragging a note or folder row in the sidebar onto a folder (or the empty list
// area, for the notebook root) moves it there; a folder takes its contents along.
// The browser's drag image is the ghost.
const draggedPath = ref<string | null>(null)
const draggedKind = ref<'note' | 'image' | 'pdf' | 'folder'>('note')
const dropTarget = ref<string | null>(null) // folder path, '' for root, null for none

// Dropping on a folder row targets that folder; dropping on a note row targets
// the folder that note sits in.
function dropFolderFor(row: SidebarRow): string {
  if (row.kind === 'folder') return row.path
  return row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : ''
}

function onRowDragStart(event: DragEvent, row: SidebarRow) {
  draggedPath.value = row.path
  if (row.kind !== 'folder') draggedNotePath.value = row.path // panes show drop zones
  draggedKind.value = row.kind
  event.dataTransfer?.setData('text/plain', row.path)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onRowDragEnd() {
  draggedNotePath.value = null
  draggedPath.value = null
  dropTarget.value = null
}

function onDropTargetDragOver(event: DragEvent, folder: string) {
  if (!draggedPath.value) return
  // A folder can't be dropped into itself or anything inside it. Swallow the
  // event so the list area behind (the notebook root) doesn't claim it instead.
  if (draggedKind.value === 'folder' && (folder === draggedPath.value || folder.startsWith(`${draggedPath.value}/`))) {
    event.stopPropagation()
    dropTarget.value = null
    return
  }
  event.preventDefault()
  event.stopPropagation() // a folder row wins over the list area behind it
  dropTarget.value = folder
}

function onListDragLeave(event: DragEvent) {
  const list = event.currentTarget as HTMLElement
  if (!list.contains(event.relatedTarget as Node | null)) dropTarget.value = null
}

function onRowDrop(folder: string) {
  const path = draggedPath.value
  const kind = draggedKind.value
  onRowDragEnd()
  if (!path) return
  if (kind === 'folder' && (folder === path || folder.startsWith(`${path}/`))) return
  moveItem(path, folder)
}
</script>

<template>
  <div
    class="sidebar-top scroll-area"
    :class="{ 'drop-root': dropTarget === '' }"
    @dragover="onDropTargetDragOver($event, '')"
    @dragleave="onListDragLeave"
    @drop.prevent="onRowDrop('')"
  >
    <div class="sidebar-actions">
      <button class="sidebar-action" title="New note" aria-label="New note" @click="createNewNote()">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
          <path d="M12 12v6M9 15h6" />
        </svg>
      </button>
      <button class="sidebar-action" title="New folder" aria-label="New folder" @click="createFolder()">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M12 11v6M9 14h6" />
        </svg>
      </button>
      <button class="sidebar-action" title="Import markdown files" aria-label="Import markdown files" @click="startImport">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v12M8 7l4-4 4 4" />
          <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
        </svg>
      </button>
      <input ref="importInput" type="file" accept=".md,.markdown,text/markdown" multiple class="import-input" @change="onImportChosen" />
      <span class="action-break" />
      <button class="sidebar-action" title="Collapse all folders" aria-label="Collapse all folders" @click="collapseAll">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 4l5 5 5-5M7 20l5-5 5 5" />
        </svg>
      </button>
      <button class="sidebar-action" title="Expand all folders" aria-label="Expand all folders" @click="expandAll">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 9l5-5 5 5M7 15l5 5 5-5" />
        </svg>
      </button>
    </div>
    <ul class="file-list">
      <li
        v-for="row in sidebarRows"
        :key="row.kind + ':' + row.path"
        :data-path="row.kind === 'folder' ? undefined : row.path"
        :class="{
          active: treeActive && row.kind !== 'folder' && row.path === selectedFile,
          open: row.kind !== 'folder' && row.path === selectedFile,
          'folder-row': row.kind === 'folder',
          'drop-target': row.kind === 'folder' && dropTarget === row.path,
          dragging: draggedPath === row.path,
        }"
        :style="{ paddingLeft: 0.6 + row.depth * 0.9 + 'rem' }"
        :draggable="!isRenaming(row)"
        @click="row.kind === 'folder' ? toggleFolder(row.path) : selectFile(row.path)"
        @dragstart="onRowDragStart($event, row)"
        @dragend="onRowDragEnd"
        @contextmenu.prevent.stop="emit('row-menu', $event, row)"
        @dragover="onDropTargetDragOver($event, dropFolderFor(row))"
        @drop.prevent.stop="onRowDrop(dropFolderFor(row))"
      >
        <span
          v-for="level in row.depth"
          :key="level"
          class="tree-guide"
          :style="{ left: 0.6 + (level - 1) * 0.9 + 0.45 + 'rem' }"
        />
        <FileIcon :kind="row.kind" />
        <input
          v-if="isRenaming(row)"
          v-rename-focus
          v-model="renameDraft"
          class="rename-input"
          :class="{ invalid: renameError }"
          :title="renameError ?? undefined"
          type="text"
          spellcheck="false"
          @click.stop
          @input="renameError = null"
          @keydown.enter.prevent="commitRename(true)"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename(false)"
        />
        <span v-else class="row-label" :title="row.label">{{ row.label }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.sidebar-top {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.sidebar-top.drop-root {
  box-shadow: inset 0 0 0 1px var(--color-accent);
}

.import-input {
  display: none;
}

.file-list {
  list-style: none;
  padding: 0.5rem;
  margin: 0;
}

.file-list li {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.1rem 0.6rem;
  margin: 0;
  font-size: 0.85rem;
  border-radius: 4px;
  cursor: pointer;
  overflow-wrap: break-word;
}

/* One line per folder level a row sits in, hanging below that folder's icon, so
   a folder's contents read as a distinct, indented group. */
.tree-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-border);
  pointer-events: none;
}

.file-list li:hover {
  background: rgb(var(--tint) / 0.06);
}

.file-list li.open {
  background: rgb(var(--tint) / 0.06);
}

.file-list li.active {
  background: rgb(var(--tint) / 0.14);
}

.rename-input {
  flex: 1;
  min-width: 0;
  padding: 0 0.3rem;
  font: inherit;
  color: var(--color-text-strong);
  background: rgb(var(--tint) / 0.08);
  border: 1px solid var(--color-accent);
  border-radius: 3px;
  outline: none;
}

.rename-input.invalid {
  border-color: #e08080;
}

.row-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-list li.folder-row {
  opacity: 0.85;
  user-select: none;
}

.file-list li.drop-target {
  background: color-mix(in srgb, var(--color-accent) 25%, transparent);
  outline: 1px solid var(--color-accent);
}

.file-list li.dragging {
  opacity: 0.4;
}
</style>
