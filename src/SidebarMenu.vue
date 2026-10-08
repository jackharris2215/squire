<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { BookmarkFolder, SidebarRow } from './types'
import { renaming } from './overlay'
import {
  allFolderPaths,
  copyNote,
  createFolder,
  createNote,
  deleteBookmarkFolder,
  deleteFolder,
  deleteNote,
  isBookmarked,
  moveItem,
  openInSplit,
  nextNewNoteTitle,
  selectFile,
  toggleBookmark,
} from './store'

// The right-click menu on a sidebar row: one version for notes, one for folders (notebook
// folders and bookmark folders share the same look, though a bookmark folder's menu is
// a subset since it isn't a real notebook location). The parent opens and closes it
// (defineExpose below), since clicking elsewhere or opening another menu closes this one.
interface MenuState {
  kind: 'note' | 'folder' | 'image' | 'pdf' | 'bookmark-folder'
  path: string // notebook path; unused for a bookmark folder
  id?: string // bookmark folder id; only set for kind 'bookmark-folder'
  x: number
  y: number
}

const menu = ref<MenuState | null>(null)
const menuEl = ref<HTMLElement | null>(null)

// Once the menu is on screen, measure it and slide it up or left if it runs past
// the window's edge (same approach as BlockMenus.vue's keepOnScreen) — a fixed
// guess at its size doesn't hold up once a note's menu can grow (Move to, say).
async function clampToScreen() {
  await nextTick()
  const el = menuEl.value
  if (!el || !menu.value) return
  const { width, height } = el.getBoundingClientRect()
  menu.value.x = Math.max(8, Math.min(menu.value.x, window.innerWidth - width - 8))
  menu.value.y = Math.max(8, Math.min(menu.value.y, window.innerHeight - height - 8))
}

async function open(event: MouseEvent, row: SidebarRow) {
  menu.value = { kind: row.kind, path: row.path, x: event.clientX, y: event.clientY }
  await clampToScreen()
}

async function openBookmarkFolder(event: MouseEvent, folder: BookmarkFolder) {
  menu.value = { kind: 'bookmark-folder', path: '', id: folder.id, x: event.clientX, y: event.clientY }
  await clampToScreen()
}

function close() {
  menu.value = null
}

defineExpose({ open, openBookmarkFolder, close })

function newNote() {
  if (!menu.value) return
  const folder = menu.value.path
  close()
  createNote(nextNewNoteTitle(), folder)
}

function newFolder() {
  if (!menu.value) return
  const folder = menu.value.path
  close()
  createFolder(folder)
}

function openNote() {
  if (!menu.value) return
  const path = menu.value.path
  close()
  selectFile(path)
}

function openBeside(side: 'right' | 'bottom') {
  if (!menu.value) return
  const path = menu.value.path
  close()
  openInSplit(path, side)
}

const menuIsBookmarked = computed(() => !!menu.value && isBookmarked(menu.value.path))

function bookmark() {
  if (!menu.value) return
  const path = menu.value.path
  close()
  toggleBookmark(path)
}

// Every folder, flat (nested ones aren't shown any differently), alphabetically.
const folderOptions = computed(() => [...allFolderPaths()].sort((a, b) => a.localeCompare(b)))

const submenuOpen = ref(false)
const moveToWrapper = ref<HTMLElement | null>(null)
const submenuEl = ref<HTMLElement | null>(null)
const submenuStyle = ref<{ left: string; right: string; top: string }>({ left: '100%', right: 'auto', top: '0' })

// Same idea as the top-level menu's own edge-clamping: once it's rendered, measure
// it and flip it to the other side (or slide it up) if it would run off screen,
// rather than guessing from the trigger's position alone.
async function openSubmenu() {
  submenuOpen.value = true
  await nextTick()
  const wrapper = moveToWrapper.value
  const el = submenuEl.value
  if (!wrapper || !el) return
  const wrapperRect = wrapper.getBoundingClientRect()
  const { width, height } = el.getBoundingClientRect()
  const fitsRight = wrapperRect.right + width <= window.innerWidth - 8
  const available = window.innerHeight - 8 - wrapperRect.top
  submenuStyle.value = {
    left: fitsRight ? '100%' : 'auto',
    right: fitsRight ? 'auto' : '100%',
    top: available < height ? `${available - height}px` : '0',
  }
}

function closeSubmenu() {
  submenuOpen.value = false
}

function moveTo(folder: string) {
  if (!menu.value) return
  const path = menu.value.path
  close()
  moveItem(path, folder)
}

function copy() {
  if (!menu.value) return
  const path = menu.value.path
  close()
  copyNote(path)
}

function remove() {
  if (!menu.value) return
  const { kind, path, id } = menu.value
  close()
  if (kind === 'bookmark-folder') deleteBookmarkFolder(id!)
  else if (kind === 'folder') deleteFolder(path)
  else deleteNote(path)
}

// Closes the menu and turns the row's name into an input (FileTree.vue/BookmarkList.vue
// do the rest).
function rename() {
  if (!menu.value) return
  const { kind, path, id } = menu.value
  close()
  renaming.value = kind === 'bookmark-folder' ? { kind, id: id! } : { kind, path }
}
</script>

<template>
  <div
    v-if="menu"
    ref="menuEl"
    class="context-menu"
    :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
    @click.stop
    @contextmenu.prevent.stop
  >
    <template v-if="menu.kind === 'note'">
      <button class="context-item" @click="openNote">Open</button>
      <button class="context-item" @click="openBeside('right')">Open to the right</button>
      <button class="context-item" @click="openBeside('bottom')">Open below</button>
      <div class="context-separator" />
      <button class="context-item" @click="bookmark">{{ menuIsBookmarked ? 'Remove bookmark' : 'Bookmark' }}</button>
      <button class="context-item" @click="copy">Make a copy</button>
      <button class="context-item" @click="rename">Rename</button>
      <div ref="moveToWrapper" class="context-item-parent" @mouseenter="openSubmenu" @mouseleave="closeSubmenu">
        <button class="context-item submenu-trigger">
          Move to
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <div v-show="submenuOpen" ref="submenuEl" class="context-menu submenu" :style="submenuStyle">
          <button class="context-item" @click="moveTo('')">(root)</button>
          <button v-for="folder in folderOptions" :key="folder" class="context-item" @click="moveTo(folder)">{{ folder }}</button>
        </div>
      </div>
    </template>
    <template v-else-if="menu.kind === 'image' || menu.kind === 'pdf'">
      <button class="context-item" @click="openNote">Open</button>
      <button class="context-item" @click="openBeside('right')">Open to the right</button>
      <button class="context-item" @click="openBeside('bottom')">Open below</button>
      <div class="context-separator" />
      <button class="context-item" @click="rename">Rename</button>
    </template>
    <template v-else-if="menu.kind === 'bookmark-folder'">
      <button class="context-item" @click="rename">Rename</button>
    </template>
    <template v-else>
      <button class="context-item" @click="newNote">New note</button>
      <button class="context-item" @click="newFolder">New folder</button>
      <div class="context-separator" />
      <button class="context-item" @click="rename">Rename</button>
    </template>
    <div class="context-separator" />
    <button class="settings-delete context-delete" @click="remove">Delete</button>
  </div>
</template>

<style scoped>
.context-item-parent {
  position: relative;
}

.submenu-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

/* A second panel, popped out beside "Move to" rather than fixed to the cursor like
   the top-level menu (.context-menu's own position: fixed) — shown on hover (no
   extra click needed) and positioned in script (openSubmenu), which flips it to
   the other side or slides it up if it would otherwise run off screen. */
.submenu {
  position: absolute;
  max-height: 24rem;
  overflow-y: auto;
}
</style>
