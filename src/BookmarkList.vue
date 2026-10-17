<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { BookmarkFolder, SidebarRow } from './types'
import { draggedNotePath } from './dragNote'
import { renaming } from './overlay'
import {
  addBookmarkFolder,
  config,
  fileBookmark,
  noteList,
  renameBookmarkFolder,
  reorderBookmarkFolder,
  selectedFile,
  selectFile,
  setBookmarkFolderCollapsed,
  type BookmarkBeforeRef,
} from './store'
import FileIcon from './FileIcon.vue'

// The sidebar's Bookmarks tab: bookmarked notes, optionally grouped into
// organizational folders (config.bookmarkOrder — see types.ts; these aren't real
// notebook folders, just a way to arrange bookmarks, and start expanded). Dragging a
// row reorders it, moves it into or out of a folder, or opens it in a pane if
// dropped outside this list (draggedNotePath, same as the file tree). Right-clicking
// a note row is reported to the parent like in the file tree; a folder row's menu is
// its own event (it isn't a SidebarRow — a bookmark folder has no notebook path) but
// opens the same shared SidebarMenu, with a Rename/Delete subset of its options.
const emit = defineEmits<{
  'row-menu': [event: MouseEvent, row: SidebarRow]
  'folder-menu': [event: MouseEvent, folder: BookmarkFolder]
}>()

type FlatRow = { type: 'folder'; folder: BookmarkFolder } | { type: 'note'; path: string; title: string; folderId: string | null }

// The order (store.ts) flattened for rendering: a folder's notes follow it
// immediately, indented, unless it's collapsed. A bookmarked path with no matching
// note (deleted since) is just skipped.
const flatRows = computed<FlatRow[]>(() => {
  const byPath = new Map(noteList.value.map((n) => [n.path, n]))
  const rows: FlatRow[] = []
  for (const item of config.value.bookmarkOrder ?? []) {
    if (item.kind === 'note') {
      const entry = byPath.get(item.path)
      if (entry) rows.push({ type: 'note', path: entry.path, title: entry.title, folderId: null })
      continue
    }
    rows.push({ type: 'folder', folder: item })
    if (!item.collapsed) {
      for (const path of item.notes) {
        const entry = byPath.get(path)
        if (entry) rows.push({ type: 'note', path: entry.path, title: entry.title, folderId: item.id })
      }
    }
  }
  return rows
})

function addFolder() {
  addBookmarkFolder()
}

function toggleFolderCollapsed(folder: BookmarkFolder) {
  setBookmarkFolderCollapsed(folder.id, !folder.collapsed)
}

function collapseAllFolders() {
  for (const item of config.value.bookmarkOrder ?? []) if (item.kind === 'folder') setBookmarkFolderCollapsed(item.id, true)
}

function expandAllFolders() {
  for (const item of config.value.bookmarkOrder ?? []) if (item.kind === 'folder') setBookmarkFolderCollapsed(item.id, false)
}

// --- Renaming a folder: "Rename" in its right-click menu (SidebarMenu.vue), same as
// the file tree. renaming (overlay.ts) is shared across both; this just reacts to it. ---

const renamingFolderId = ref<string | null>(null)
const renameDraft = ref('')

watch(renaming, (target) => {
  const id = target?.kind === 'bookmark-folder' ? target.id : null
  renamingFolderId.value = id
  const folder = id && (config.value.bookmarkOrder ?? []).find((item) => item.kind === 'folder' && item.id === id)
  renameDraft.value = folder ? (folder as BookmarkFolder).name : ''
})

function commitRenameFolder() {
  if (renamingFolderId.value) renameBookmarkFolder(renamingFolderId.value, renameDraft.value)
  renamingFolderId.value = null
  renaming.value = null
}

function cancelRenameFolder() {
  renamingFolderId.value = null
  renaming.value = null
}

// --- Dragging rows ---
// A note's drag can land anywhere (reorder in place, move into or out of a folder);
// a folder's can only reorder among the other top-level items, since folders don't
// nest. Both share one gap list, indexed into flatRows.

type Dragged = { type: 'note'; path: string } | { type: 'folder'; id: string }

const dragged = ref<Dragged | null>(null)
const gap = ref<number | null>(null) // a gap index into flatRows, or null (no valid target under the cursor)
const hoveredFolderId = ref<string | null>(null) // dropping directly on a (possibly collapsed) folder's header
const listRef = ref<HTMLElement | null>(null)

function onNoteDragStart(event: DragEvent, path: string) {
  dragged.value = { type: 'note', path }
  draggedNotePath.value = path
  event.dataTransfer?.setData('text/plain', path)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onFolderDragStart(event: DragEvent, id: string) {
  dragged.value = { type: 'folder', id }
  event.dataTransfer?.setData('text/plain', id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragEnd() {
  dragged.value = null
  draggedNotePath.value = null
  gap.value = null
  hoveredFolderId.value = null
}

// The gap nearest the pointer: before the first row whose middle is below it.
function gapAt(clientY: number): number {
  const rows = [...(listRef.value?.querySelectorAll('li.bookmark-row') ?? [])]
  const index = rows.findIndex((row) => clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2)
  return index === -1 ? rows.length : index
}

// A folder can't land inside another folder's children (no nesting): snap forward
// past whatever folder's region the raw gap would otherwise land inside.
function nearestTopLevelGap(index: number): number {
  let i = index
  // A gap right after a folder's header is "inside" that folder too (the first-child
  // position), so a folder being dragged has to skip past it as well, not just past
  // the folder's notes — otherwise it could land nested one level in.
  while (i > 0 && i < flatRows.value.length) {
    const before = flatRows.value[i - 1]!
    if (before.type === 'note' && before.folderId === null) return i
    i++
  }
  return Math.min(i, flatRows.value.length)
}

// Which container (a folder's id, or null for unfiled/top-level) gap `at` sits in —
// the same container as the row just above it, since a gap right after a folder's
// header or one of its notes means "still inside that folder."
function containerAt(at: number): string | null {
  const row = flatRows.value[at - 1]
  if (!row) return null
  return row.type === 'folder' ? row.folder.id : row.folderId
}

// What to insert before, inside that container: the row at `at`, if it's actually
// still part of the same container (otherwise we've reached that container's own
// end, so append there instead of spilling into whatever comes after it).
function beforeRefAt(at: number, folderId: string | null): BookmarkBeforeRef {
  const row = flatRows.value[at]
  if (!row) return null
  if (folderId === null) {
    if (row.type === 'folder') return { kind: 'folder', id: row.folder.id }
    return row.folderId === null ? { kind: 'note', path: row.path } : null
  }
  return row.type === 'note' && row.folderId === folderId ? { kind: 'note', path: row.path } : null
}

// A gap right beside the dragged row (or, for a folder, right before/after its
// whole block of children) would change nothing.
function isNoOp(at: number): boolean {
  const d = dragged.value
  if (!d) return false
  if (d.type === 'note') {
    const index = flatRows.value.findIndex((r) => r.type === 'note' && r.path === d.path)
    return at === index || at === index + 1
  }
  const start = flatRows.value.findIndex((r) => r.type === 'folder' && r.folder.id === d.id)
  let end = start + 1
  while (flatRows.value[end]?.type === 'note' && (flatRows.value[end] as { folderId: string | null }).folderId === d.id) end++
  return at === start || at === end
}

function onListDragOver(event: DragEvent) {
  if (!dragged.value) return
  event.preventDefault()
  hoveredFolderId.value = null
  const raw = gapAt(event.clientY)
  const at = dragged.value.type === 'folder' ? nearestTopLevelGap(raw) : raw
  gap.value = isNoOp(at) ? null : at
}

function onListDragLeave(event: DragEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
    gap.value = null
    hoveredFolderId.value = null
  }
}

function onListDrop() {
  const d = dragged.value
  const at = gap.value
  onDragEnd()
  if (!d || at === null) return
  if (d.type === 'folder') reorderBookmarkFolder(d.id, beforeRefAt(at, null))
  else {
    const folderId = containerAt(at)
    fileBookmark(d.path, folderId, beforeRefAt(at, folderId))
  }
}

// Dropping directly on a folder's header (rather than a gap) files a note into it
// as its last child — the only way to file into a collapsed folder, which has no
// gaps of its own to drop into.
function onFolderHeaderDragOver(event: DragEvent) {
  if (dragged.value?.type !== 'note') return
  event.preventDefault()
  event.stopPropagation()
  gap.value = null
}

function onFolderHeaderDragEnter(folder: BookmarkFolder) {
  if (dragged.value?.type === 'note') hoveredFolderId.value = folder.id
}

function onFolderHeaderDrop(event: DragEvent, folder: BookmarkFolder) {
  event.stopPropagation()
  const d = dragged.value
  onDragEnd()
  if (d?.type === 'note') fileBookmark(d.path, folder.id, null)
}

function menuRow(path: string, title: string): SidebarRow {
  return { kind: 'note', path, label: title, depth: 0 }
}

// Focuses and selects the rename input once, when it first appears — a mounted-only
// directive (like FileTree.vue's vRenameFocus), not a function :ref, since a function
// :ref re-runs on every re-render (every keystroke, as renameDraft changes), which
// would re-select the whole input after each character typed.
const vRenameFocus = {
  mounted(el: HTMLInputElement) {
    el.focus()
    el.select()
  },
}
</script>

<template>
  <div class="bookmarks">
    <div class="sidebar-actions">
      <button class="sidebar-action" title="Add folder" aria-label="Add folder" @click="addFolder">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M12 11v6M9 14h6" />
        </svg>
      </button>
      <span class="action-break" />
      <button class="sidebar-action" title="Collapse all folders" aria-label="Collapse all folders" @click="collapseAllFolders">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 4l5 5 5-5M7 20l5-5 5 5" />
        </svg>
      </button>
      <button class="sidebar-action" title="Expand all folders" aria-label="Expand all folders" @click="expandAllFolders">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 9l5-5 5 5M7 15l5 5 5-5" />
        </svg>
      </button>
    </div>
    <div class="bookmarks-list scroll-area">
      <p v-if="flatRows.length === 0" class="bookmarks-empty">
        No bookmarked notes yet. Open a note's settings (the gear) and tick Bookmark.
      </p>
      <ul
        v-else
        ref="listRef"
        class="bookmark-list"
        @dragover="onListDragOver"
        @dragleave="onListDragLeave"
        @drop.prevent="onListDrop"
      >
        <template v-for="(row, i) in flatRows" :key="row.type === 'folder' ? 'f:' + row.folder.id : 'n:' + row.path">
          <li class="bookmark-gap" :class="{ active: gap === i }" />
          <li
            v-if="row.type === 'folder'"
            class="bookmark-row folder-row"
            :class="{ hovered: hoveredFolderId === row.folder.id, dragging: dragged?.type === 'folder' && dragged.id === row.folder.id }"
            :style="{ paddingLeft: '0.6rem' }"
            :draggable="renamingFolderId !== row.folder.id"
            @dragstart="onFolderDragStart($event, row.folder.id)"
            @dragend="onDragEnd"
            @dragover="onFolderHeaderDragOver"
            @dragenter="onFolderHeaderDragEnter(row.folder)"
            @drop.prevent="onFolderHeaderDrop($event, row.folder)"
            @click="toggleFolderCollapsed(row.folder)"
            @contextmenu.prevent.stop="emit('folder-menu', $event, row.folder)"
          >
            <FileIcon kind="folder" />
            <input
              v-if="renamingFolderId === row.folder.id"
              v-rename-focus
              v-model="renameDraft"
              class="rename-input"
              type="text"
              spellcheck="false"
              @click.stop
              @keydown.enter.prevent="commitRenameFolder"
              @keydown.esc.prevent="cancelRenameFolder"
              @blur="commitRenameFolder"
            />
            <span v-else class="row-label" :title="row.folder.name">{{ row.folder.name }}</span>
          </li>
          <li
            v-else
            class="bookmark-row"
            :class="{ active: row.path === selectedFile, dragging: dragged?.type === 'note' && dragged.path === row.path }"
            :style="{ paddingLeft: (row.folderId ? 1.5 : 0.6) + 'rem' }"
            draggable="true"
            @dragstart="onNoteDragStart($event, row.path)"
            @dragend="onDragEnd"
            @click="selectFile(row.path)"
            @contextmenu.prevent.stop="emit('row-menu', $event, menuRow(row.path, row.title))"
          >
            <span v-if="row.folderId" class="tree-guide" style="left: 1.05rem" />
            <FileIcon kind="note" />
            <span class="row-label" :title="row.title">{{ row.title }}</span>
          </li>
        </template>
        <li class="bookmark-gap" :class="{ active: gap === flatRows.length }" />
      </ul>
    </div>
  </div>
</template>

<style scoped>
.bookmarks {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.bookmarks-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.bookmarks-empty {
  padding: 0.75rem;
  font-size: 0.8rem;
  color: var(--color-text);
  opacity: 0.6;
}

.bookmark-list {
  list-style: none;
  padding: 0.5rem;
  margin: 0;
}

.bookmark-row {
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

/* The line hanging below a folder's icon, under its nested notes — matches
   FileTree.vue's .tree-guide exactly, so a bookmark folder's contents read the
   same way a notebook folder's do. */
.tree-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-border);
  pointer-events: none;
}

.bookmark-row:hover {
  background: rgb(var(--tint) / 0.06);
}

.bookmark-row.active {
  background: rgb(var(--tint) / 0.14);
}

.bookmark-row.dragging {
  opacity: 0.4;
}

.folder-row {
  opacity: 0.85;
  user-select: none;
}

.folder-row.hovered {
  outline: 1px dashed var(--color-accent);
  outline-offset: -1px;
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

.row-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Where a dragged row would land; lights up between rows. */
.bookmark-gap {
  height: 6px;
  margin: -3px 0;
  border-radius: 3px;
}

.bookmark-gap.active {
  background: var(--color-accent);
}
</style>
