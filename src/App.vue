<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import BlockMenus from './BlockMenus.vue'
import BlockBrowser from './BlockBrowser.vue'
import BookmarkList from './BookmarkList.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import LinksList from './LinksList.vue'
import NoteInfo from './NoteInfo.vue'
import PaneLayout from './PaneLayout.vue'
import RecentNotesList from './RecentNotesList.vue'
import SettingsPage from './SettingsPage.vue'
import { layout } from './layout'
import { startAppearance } from './appearance'
import { settingsOpen } from './overlay'
import FileTree from './FileTree.vue'
import QuickSwitcher from './QuickSwitcher.vue'
import SidebarMenu from './SidebarMenu.vue'
import VariableList from './VariableList.vue'
import VariableMenu from './VariableMenu.vue'
import { convertValue, globalVariables, variableProblem } from './variables'
import { canInsertAtCursor, insertAtCursor } from './insert'
import type { Block, BookmarkFolder, MenuContext, SidebarRow, Variable } from './types'
import { checkSession, needsLogin, outOfDate, reloadPage, setStalenessInterval, startStalenessPolling } from './api'
import LoginScreen from './LoginScreen.vue'
import { closeDrawer, isMobile, mobileDrawer, toggleDrawer } from './mobile'
import { startSwipeGestures, swipeDrawers } from './swipe'
import { DEFAULT_STALENESS_CHECK_SECONDS } from './notebookSettings'
import { startLiveSync } from './sync'
import { config, loadConfig, loadFiles, noteCache, openDailyNote, openWeeklyNote, queueConfigSave, restoreOpenNotes, selectedFile } from './store'

const sidebarRef = ref<HTMLElement | null>(null)

// Shown until the file list and config have both loaded and the last session's
// layout is restored — otherwise the app would flash empty panes and an empty
// sidebar for that stretch. Brief: loadFiles() only fetches the notebook's file list,
// not every note's content (that happens lazily, per note, once it's opened —
// see ensureLoaded() in store.ts, and Editor.vue's own spinner for that).
const loading = ref(true)

// The sidebar's tabs; the open one is remembered in the settings.
const SIDEBAR_TABS = [
  { id: 'files', label: 'Files' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'recent', label: 'Recent Notes' },
] as const

function setSidebarTab(tab: 'files' | 'bookmarks' | 'recent') {
  config.value.sidebarTab = tab
  queueConfigSave()
}

// The right panel's tabs: the block browser, the focused note's outgoing links, and
// a read-only info tab about it.
const RIGHT_PANEL_TABS = [
  { id: 'blocks', label: 'Block browser' },
  { id: 'links', label: 'Links' },
  { id: 'info', label: 'Note info' },
] as const

function setRightPanelTab(tab: 'blocks' | 'links' | 'info') {
  config.value.rightPanelTab = tab
  queueConfigSave()
}

// The bottom panel's tabs: read-only global variables (computed, never stored),
// variables for the whole notebook (kept in the config), and variables for one note
// (kept in the note).
const BOTTOM_TABS = [
  { id: 'global', label: 'Global variables' },
  { id: 'notebook', label: 'Notebook variables' },
  { id: 'note', label: 'Note variables' },
] as const

// The note in the focused pane (null for an image or an empty pane); its variables
// are stored in its metadata, so its autosave and undo history cover them.
const focusedNote = computed(() => (selectedFile.value ? noteCache.get(selectedFile.value) ?? null : null))

// The variables the open tab shows, and where its changes go.
const shownVariables = computed<Variable[]>(() => {
  if (config.value.bottomTab === 'global') return globalVariables.value
  if (config.value.bottomTab === 'note') return (focusedNote.value?.metadata.variables as Variable[] | undefined) ?? []
  return config.value.variables ?? []
})

function setShownVariables(variables: Variable[]) {
  if (config.value.bottomTab === 'global') return // read-only; nothing to write back
  if (config.value.bottomTab === 'note') {
    if (focusedNote.value) focusedNote.value.metadata.variables = variables
  } else {
    config.value.variables = variables
    queueConfigSave()
  }
}

// Right-clicking a variable: copy it, insert it into the block being edited, switch its
// type (the value is converted) or delete it. A global variable can only be copied or
// inserted — there's no type to switch or entry to delete.
function openVariableMenu(event: MouseEvent, index: number, variable: Variable) {
  sidebarMenu.value?.close()
  blockMenus.value?.close()
  const canInsert = canInsertAtCursor() && !variableProblem(shownVariables.value, index)
  variableMenu.value?.open(event, index, variable, canInsert, config.value.bottomTab === 'global')
}

function setVariableType(index: number, type: Variable['type']) {
  setShownVariables(
    shownVariables.value.map((v, i) =>
      i === index ? { ...v, type, value: convertValue(v.value, type) } : v,
    ),
  )
}

function removeVariable(index: number) {
  setShownVariables(shownVariables.value.filter((_, i) => i !== index))
}

function setBottomTab(tab: 'global' | 'notebook' | 'note') {
  config.value.bottomTab = tab
  config.value.bottomPanelCollapsed = false // picking a tab opens a collapsed panel
  queueConfigSave()
}

// The right-click menus: SidebarMenu for the sidebar, BlockMenus for blocks and
// table cells. Opening any one closes the others.
const sidebarMenu = ref<InstanceType<typeof SidebarMenu> | null>(null)
const blockMenus = ref<InstanceType<typeof BlockMenus> | null>(null)
const variableMenu = ref<InstanceType<typeof VariableMenu> | null>(null)

function openContextMenu(event: MouseEvent, row: SidebarRow) {
  blockMenus.value?.close()
  variableMenu.value?.close()
  sidebarMenu.value?.open(event, row)
}

function openBookmarkFolderMenu(event: MouseEvent, folder: BookmarkFolder) {
  blockMenus.value?.close()
  variableMenu.value?.close()
  sidebarMenu.value?.openBookmarkFolder(event, folder)
}

function openBlockMenu(event: MouseEvent, block: Block, ctx: MenuContext) {
  sidebarMenu.value?.close()
  variableMenu.value?.close()
  blockMenus.value?.openBlock(event, block, ctx)
}

function openTableMenu(event: MouseEvent, block: Block, ctx: MenuContext, row: number, col: number) {
  sidebarMenu.value?.close()
  variableMenu.value?.close()
  blockMenus.value?.openTable(event, block, ctx, row, col)
}

function openBlankMenu(event: MouseEvent, path: string) {
  sidebarMenu.value?.close()
  variableMenu.value?.close()
  blockMenus.value?.openBlank(event, path)
}

function closeContextMenu() {
  sidebarMenu.value?.close()
  variableMenu.value?.close()
  blockMenus.value?.close()
}

const quickSwitcher = ref<InstanceType<typeof QuickSwitcher> | null>(null)

// The gear in the left rail swaps the editor for the settings page (the notes stay
// open underneath); pressing it again, its close button, or opening a note brings the
// editor back (selectFile and friends in store.ts also close it).
function toggleSettings() {
  closeDrawer()
  settingsOpen.value = !settingsOpen.value
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeContextMenu()

  // Ctrl+P opens (or closes) the note switcher instead of the browser's print dialog.
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    closeContextMenu()
    quickSwitcher.value?.toggle()
  }
}

const isResizingSidebar = ref(false)

function startSidebarResize() {
  isResizingSidebar.value = true
}

function onSidebarResize(event: MouseEvent) {
  if (!isResizingSidebar.value) return
  if (!sidebarRef.value) return
  // The width is the distance from the sidebar's left edge to the pointer.
  const width = event.clientX - sidebarRef.value.getBoundingClientRect().left
  config.value.sidebarWidth = Math.round(Math.min(Math.max(width, 160), 600))
}

function stopSidebarResize() {
  if (!isResizingSidebar.value) return
  isResizingSidebar.value = false
  queueConfigSave()
}

function toggleSidebar() {
  if (isMobile.value) return toggleDrawer('left') // a drawer on a phone, not the saved setting
  config.value.sidebarCollapsed = !config.value.sidebarCollapsed
  queueConfigSave()
}

// The right panel's width: dragged from its left edge, like the sidebar's from its right.
const rightPanelRef = ref<HTMLElement | null>(null)
const isResizingRightPanel = ref(false)

function onRightPanelResize(event: MouseEvent) {
  if (!isResizingRightPanel.value || !rightPanelRef.value) return
  const width = rightPanelRef.value.getBoundingClientRect().right - event.clientX
  config.value.rightPanelWidth = Math.round(Math.min(Math.max(width, 160), 600))
}

function stopRightPanelResize() {
  if (!isResizingRightPanel.value) return
  isResizingRightPanel.value = false
  queueConfigSave()
}

const isResizingBottomPanel = ref(false)

function startBottomPanelResize() {
  isResizingBottomPanel.value = true
}

// Dragging the panel's top edge down far enough snaps it shut, and pulling it back up
// far enough snaps it open again. The two distances differ a little (in pixels, the
// panel's height) so it doesn't flicker right at the edge.
const COLLAPSE_BELOW = 60
const EXPAND_ABOVE = 100

function onBottomPanelResize(event: MouseEvent) {
  if (!isResizingBottomPanel.value || !sidebarRef.value) return
  const rect = sidebarRef.value.getBoundingClientRect()
  const height = rect.bottom - event.clientY
  if (height < COLLAPSE_BELOW) config.value.bottomPanelCollapsed = true
  else if (height > EXPAND_ABOVE || !config.value.bottomPanelCollapsed) {
    config.value.bottomPanelCollapsed = false
    config.value.bottomPanelHeightPercent = Math.min(Math.max((height / rect.height) * 100, 15), 70)
  }
}

function stopBottomPanelResize() {
  if (!isResizingBottomPanel.value) return
  isResizingBottomPanel.value = false
  queueConfigSave()
}

onMounted(async () => {
  // With a password set, nothing loads until it has been given (the login screen
  // reloads the page once it has).
  if (!(await checkSession())) {
    loading.value = false
    return
  }
  await Promise.all([loadFiles(), loadConfig()])
  startAppearance()
  startSwipeGestures(swipeDrawers)
  restoreOpenNotes()
  loading.value = false
  startLiveSync()
  startStalenessPolling((config.value.stalenessCheckSeconds ?? DEFAULT_STALENESS_CHECK_SECONDS) * 1000)
  watch(
    () => config.value.stalenessCheckSeconds,
    (seconds) => setStalenessInterval((seconds ?? DEFAULT_STALENESS_CHECK_SECONDS) * 1000),
  )
  window.addEventListener('mousemove', onSidebarResize)
  window.addEventListener('mouseup', stopSidebarResize)
  window.addEventListener('mousemove', onRightPanelResize)
  window.addEventListener('mouseup', stopRightPanelResize)
  window.addEventListener('mousemove', onBottomPanelResize)
  window.addEventListener('mouseup', stopBottomPanelResize)
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('click', closeContextMenu)
  window.addEventListener('contextmenu', closeContextMenu)
})
</script>

<template>
  <div
    class="layout"
    :class="{ resizing: isResizingSidebar || isResizingRightPanel, 'resizing-row': isResizingBottomPanel }"
  >
    <nav class="icon-rail" :class="{ 'mobile-open': mobileDrawer === 'left' }">
      <button class="icon-button" title="Toggle sidebar" aria-label="Toggle sidebar" @click="toggleSidebar">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      </button>
      <button class="icon-button" title="Find a note (Ctrl+P)" aria-label="Find a note" @click="quickSwitcher?.toggle()">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
      </button>
      <button class="icon-button" title="Reload notebook" aria-label="Reload notebook" @click="reloadPage">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
      </button>
      <div class="rail-break" />
      <button class="icon-button" title="Today's daily note" aria-label="Today's daily note" @click="openDailyNote">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
      </button>
      <button class="icon-button" title="This week's weekly note" aria-label="This week's weekly note" @click="openWeeklyNote">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
          <path d="M7 15h10" />
        </svg>
      </button>
      <button
        class="icon-button rail-bottom"
        :class="{ active: settingsOpen }"
        title="Settings"
        aria-label="Settings"
        @click="toggleSettings"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </nav>
    <aside
      ref="sidebarRef"
      class="sidebar"
      :class="{ collapsed: config.sidebarCollapsed, 'mobile-open': mobileDrawer === 'left' }"
      :style="{ width: config.sidebarCollapsed ? '0' : config.sidebarWidth + 'px' }"
    >
      <div class="sidebar-tabs" role="tablist">
        <button
          v-for="tab in SIDEBAR_TABS"
          :key="tab.id"
          class="sidebar-tab"
          :class="{ active: config.sidebarTab === tab.id }"
          role="tab"
          :aria-selected="config.sidebarTab === tab.id"
          :title="tab.label"
          :aria-label="tab.label"
          @click="setSidebarTab(tab.id)"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path v-if="tab.id === 'files'" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <path v-else-if="tab.id === 'bookmarks'" d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            <template v-else>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l4 2" />
            </template>
          </svg>
        </button>
      </div>
      <FileTree v-if="config.sidebarTab === 'files'" @row-menu="openContextMenu" />
      <BookmarkList
        v-else-if="config.sidebarTab === 'bookmarks'"
        @row-menu="openContextMenu"
        @folder-menu="openBookmarkFolderMenu"
      />
      <RecentNotesList v-else @row-menu="openContextMenu" />
      <div class="sidebar-split-handle" @mousedown="startBottomPanelResize" />
      <div
        class="sidebar-bottom"
        :class="{ collapsed: config.bottomPanelCollapsed }"
        :style="config.bottomPanelCollapsed ? {} : { height: config.bottomPanelHeightPercent + '%' }"
      >
        <div class="sidebar-bottom-header">
          <div class="bottom-tabs" role="tablist">
            <button
              v-for="tab in BOTTOM_TABS"
              :key="tab.id"
              class="sidebar-tab"
              :class="{ active: config.bottomTab === tab.id }"
              role="tab"
              :aria-selected="config.bottomTab === tab.id"
              :title="tab.label"
              :aria-label="tab.label"
              @click="setBottomTab(tab.id)"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <template v-if="tab.id === 'global'">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
                </template>
                <template v-else-if="tab.id === 'notebook'">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" />
                  <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
                </template>
                <template v-else>
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5" />
                </template>
              </svg>
            </button>
          </div>
        </div>
        <div v-if="!config.bottomPanelCollapsed" class="sidebar-bottom-content scroll-area">
          <p class="variables-title">
            {{ config.bottomTab === 'global' ? 'Global variables' : config.bottomTab === 'note' ? 'Note variables' : 'Notebook variables' }}
          </p>
          <p v-if="config.bottomTab === 'note' && !focusedNote" class="variables-hint">Open a note to see its variables.</p>
          <VariableList
            v-else
            :variables="shownVariables"
            :readonly="config.bottomTab === 'global'"
            @change="setShownVariables"
            @menu="openVariableMenu"
          />
        </div>
      </div>
      <div class="sidebar-handle" @mousedown="startSidebarResize" />
    </aside>
    <SidebarMenu ref="sidebarMenu" />
    <VariableMenu ref="variableMenu" @set-type="setVariableType" @remove="removeVariable" @insert="insertAtCursor" />
    <ConfirmDialog />
    <QuickSwitcher ref="quickSwitcher" />
    <BlockMenus ref="blockMenus" />
    <LoginScreen v-if="needsLogin" />
    <div v-if="loading" class="loading-overlay">
      <div class="loading-spinner" />
    </div>
    <div v-if="outOfDate" class="reload-overlay">
      <div class="reload-dialog">
        <p>The notebook was last updated at {{ new Date(outOfDate).toLocaleString() }}, after you last loaded it.</p>
        <p>Reload to continue. Edits you haven't saved are lost.</p>
        <button class="reload-button" @click="reloadPage">Reload</button>
      </div>
    </div>
    <SettingsPage v-if="settingsOpen" />
    <div v-if="mobileDrawer" class="drawer-backdrop" @click="closeDrawer" />
    <PaneLayout v-show="!settingsOpen" :node="layout" @block-menu="openBlockMenu" @table-menu="openTableMenu" @blank-menu="openBlankMenu" />
    <aside
      ref="rightPanelRef"
      class="right-panel"
      :class="{ collapsed: config.rightPanelCollapsed, 'mobile-open': mobileDrawer === 'right' }"
      :style="{ width: config.rightPanelCollapsed ? '0' : config.rightPanelWidth + 'px' }"
    >
      <div class="right-panel-handle" @mousedown="isResizingRightPanel = true" />
      <div class="sidebar-tabs" role="tablist">
        <button
          v-for="tab in RIGHT_PANEL_TABS"
          :key="tab.id"
          class="sidebar-tab"
          :class="{ active: (config.rightPanelTab ?? 'blocks') === tab.id }"
          role="tab"
          :aria-selected="(config.rightPanelTab ?? 'blocks') === tab.id"
          :title="tab.label"
          :aria-label="tab.label"
          @click="setRightPanelTab(tab.id)"
        >
          <svg v-if="tab.id === 'blocks'" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          <svg v-else-if="tab.id === 'links'" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 15l6-6" />
            <path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1" />
            <path d="M13 18l-1 1a4 4 0 0 1-6-6l1-1" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8h.01M11 12h1v5h1" />
          </svg>
        </button>
      </div>
      <BlockBrowser v-if="(config.rightPanelTab ?? 'blocks') === 'blocks'" />
      <LinksList v-else-if="config.rightPanelTab === 'links'" />
      <NoteInfo v-else />
    </aside>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.layout.resizing {
  user-select: none;
  cursor: col-resize;
}

.layout.resizing-row {
  user-select: none;
  cursor: row-resize;
}

.icon-rail {
  flex-shrink: 0;
  width: 2.25rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--color-rail);
  border-right: 1px solid var(--color-border);
}

/* The right panel: the sidebar's counterpart, with its resize handle on the left edge. */
.right-panel {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-panel);
  border-left: 1px solid var(--color-border);
}

.right-panel.collapsed {
  border-left: none;
}

.right-panel-handle {
  position: absolute;
  top: 0;
  left: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 1;
}

.right-panel-handle:hover {
  background: var(--color-border-hover);
}

.right-panel.collapsed .right-panel-handle {
  display: none;
}

/* A thin line between groups of rail buttons. */
.rail-break {
  width: 60%;
  height: 1px;
  margin: 0.3rem 0;
  background: rgb(var(--tint) / 0.1);
}

/* The settings gear sits at the very bottom of the rail, lit while the page is open. */
.icon-rail .rail-bottom {
  margin-top: auto;
}

.icon-rail .rail-bottom.active {
  color: var(--color-accent);
}

/* Buttons fill the rail's width and are as tall as the bars beside them. */
.icon-rail .icon-button {
  width: 100%;
  height: var(--bar-height);
}

.sidebar {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-panel);
  border-right: 1px solid var(--color-border);
}

.sidebar.collapsed {
  border-right: none;
}

.sidebar-handle {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 1;
}

.sidebar-handle:hover {
  background: var(--color-border-hover);
}

.sidebar.collapsed .sidebar-handle {
  display: none;
}

.sidebar-tabs {
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  height: var(--bar-height);
  border-bottom: 1px solid rgb(var(--tint) / 0.08);
}

.sidebar-tab {
  display: flex;
  align-items: center;
  padding: 0 0.75rem;
  color: var(--color-text);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  opacity: 0.6;
}

.sidebar-tab:hover {
  opacity: 1;
}

.sidebar-tab.active {
  opacity: 1;
  border-bottom-color: var(--color-accent);
}

.sidebar-split-handle {
  flex-shrink: 0;
  height: 4px;
  cursor: row-resize;
}

.sidebar-split-handle:hover {
  background: var(--color-border-hover);
}

.sidebar-bottom {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-top: 1px solid rgb(var(--tint) / 0.08);
}

.sidebar-bottom.collapsed {
  height: auto;
}

/* The same bar as the tabs above (same height, tabs flush with its edges). */
.sidebar-bottom-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  height: var(--bar-height);
  font-size: 0.75rem;
  color: var(--color-text);
  border-bottom: 1px solid rgb(var(--tint) / 0.08);
}

.sidebar-bottom.collapsed .sidebar-bottom-header {
  border-bottom: none;
}

.bottom-tabs {
  display: flex;
  align-self: stretch;
}

.sidebar-bottom-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0.6rem 0.75rem;
}

.variables-hint {
  font-size: 0.8rem;
  color: var(--color-text);
  opacity: 0.6;
}

.variables-title {
  margin-bottom: 0.6rem;
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--color-text);
}

.loading-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-background);
}

.loading-spinner {
  width: 2.5rem;
  height: 2.5rem;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.reload-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
}

.reload-dialog {
  max-width: 24rem;
  padding: 1.5rem 2rem;
  text-align: center;
  color: var(--color-text-strong);
  background: var(--color-background-mute);
  border: 1px solid rgb(var(--tint) / 0.08);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.reload-dialog p {
  margin-bottom: 0.75rem;
}

.reload-button {
  font: inherit;
  color: var(--color-on-accent);
  background: var(--color-accent);
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1.5rem;
  cursor: pointer;
}

.reload-button:hover {
  background: var(--color-accent-hover);
}

/* Small screens: the sidebar and the right panel are drawers over the note (which one is
   open is mobile.ts's, not the saved collapsed setting), with a dim backdrop that closes
   them. The widths are the drawers' own, not the saved ones. */
@media (max-width: 700px) {
  .icon-rail,
  .sidebar,
  .right-panel {
    position: fixed;
    top: 0;
    bottom: 0;
    z-index: 19; /* over the note, under the menus */
    width: min(85vw, 20rem) !important;
    visibility: hidden;
    transition:
      transform 0.2s ease,
      visibility 0.2s;
  }

  /* The icon rail is part of the left drawer: out of the way until it opens, then it
     and the sidebar come out together, the sidebar after the rail. */
  .icon-rail {
    left: 0;
    width: 2.25rem !important;
    transform: translateX(-100%);
  }

  .sidebar {
    left: 2.25rem;
    width: min(calc(100vw - 5rem), 20rem) !important; /* leaves a strip of the note to tap */
    transform: translateX(calc(-100% - 2.25rem));
  }

  .right-panel {
    right: 0;
    transform: translateX(100%);
  }

  .icon-rail.mobile-open,
  .sidebar.mobile-open,
  .right-panel.mobile-open {
    visibility: visible;
    transform: none;
  }

  .sidebar.mobile-open,
  .right-panel.mobile-open {
    box-shadow: 0 0 24px rgba(0, 0, 0, 0.4);
  }

  .sidebar.collapsed,
  .right-panel.collapsed {
    border: none; /* the saved collapsed state doesn't apply here */
  }

  .sidebar-handle,
  .right-panel-handle {
    display: none;
  }

  .drawer-backdrop {
    position: fixed;
    inset: 0;
    z-index: 18;
    background: rgba(0, 0, 0, 0.4);
  }
}
</style>
