<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import TableBlock from './TableBlock.vue'
import RightPanelToggle from './RightPanelToggle.vue'
import LinkSuggest from './LinkSuggest.vue'
import { caretPosition } from './caret'
import { randomUUID } from './uuid'
import { findNotes } from './noteSearch'
import { switcherOpen } from './overlay'
import { isPureChecklist, isPureBulletList } from './list'
import { isPureTable } from './table'
import { renderBlock } from './markdown'
import { handleWidgetEvent } from './variables'
import { registerBlockActions } from './blockActions'
import { draggedNotePath } from './dragNote'
import { registerInserter } from './insert'
import { revealInTree } from './locate'
import { FORMATS, toggleWrap } from './format'
import type { Block, FloatingBlock, MenuContext, Note } from './types'
import { blockStyle } from './blocks'
import { canRedoFor, canUndoFor } from './history'
import { SERVER_URL } from './api'
import {
  addImage,
  allBlocks,
  baseName,
  config,
  createNewNote,
  createNote,
  deleteNote,
  findAnyBlock,
  findBlockPosition as findPosition,
  imageLinkText,
  isBookmarked,
  isImagePath,
  isPdfPath,
  nameFromPath,
  noteCache,
  redoEdit,
  renameEntry,
  unhookBlock,
  placeBlock,
  saveStateFor,
  selectFile,
  toggleBookmark,
  undoEdit,
  validateTitle,
} from './store'

// The right side of the app: the note's header (title, ⋮ menu, close) and the
// editor itself, made of blocks. Right-clicks on a block or a table cell are
// reported to the parent, which owns the menus.
const props = defineProps<{
  path: string | null // the note this pane shows (null: nothing open)
  loading: boolean // the note is still being fetched
  focused: boolean // the pane keyboard shortcuts act on; the others ignore the keyboard
  canBack: boolean // this pane has an earlier note to go back to
  canForward: boolean
  rightPanelButton: boolean // this pane is the top-right one, so its header has the right panel's button
}>()

const emit = defineEmits<{
  'block-menu': [event: MouseEvent, block: Block, ctx: MenuContext]
  'table-menu': [event: MouseEvent, block: Block, ctx: MenuContext, row: number, col: number]
  'blank-menu': [event: MouseEvent, path: string]
  back: []
  forward: []
  close: []
}>()

// Everything below is about this pane's own note and state: the note comes from the
// cache by path (the same reactive object the store saves), and the blocks picked
// with Ctrl+click belong to this pane alone.
const note = computed<Note | null>(() => (props.path ? (noteCache.get(props.path) ?? null) : null))
// A pane showing an image instead of a note: no blocks, no cache entry, just the
// file served straight from the notebook and centered.
const isImage = computed(() => props.path !== null && isImagePath(props.path))
const imageUrl = computed(() => (props.path ? `${SERVER_URL}/file?path=${encodeURIComponent(props.path)}` : ''))
// A pane showing a PDF: the browser's own viewer in a frame, fed the same served file.
const isPdf = computed(() => props.path !== null && isPdfPath(props.path))
// A note's title is its filename (there's no separate title field); derived from
// the path, not the note content, so it stays correct even before the note loads.
const currentTitle = computed(() => (props.path ? nameFromPath(props.path) : ''))
// The header shows an image's full filename (extension and all), a note's title
// without it.
// A very simple image viewer: the wheel zooms about the middle of the image and
// dragging pans it. Nothing is saved; it starts over whenever another file is shown.
const imageZoom = ref(1)
const imagePan = ref({ x: 0, y: 0 })
const imageSize = ref<{ w: number; h: number } | null>(null) // the image's own pixels, for the footer

function resetImageView() {
  imageZoom.value = 1
  imagePan.value = { x: 0, y: 0 }
}

watch(() => props.path, () => {
  resetImageView()
  imageSize.value = null
})

function onImageWheel(event: WheelEvent) {
  const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
  imageZoom.value = Math.min(Math.max(imageZoom.value * factor, 0.1), 20)
}

function onImagePointerDown(event: PointerEvent) {
  // A pointermove still reaches this element while a note is being dragged over it
  // (pane-to-pane or from the sidebar) — pointer events and HTML5 drag-and-drop are
  // separate streams, so the drag doesn't preempt them. Panning should only start
  // from an actual click on the image, not a drag passing over it.
  if (draggedNotePath.value) return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onImagePointerMove(event: PointerEvent) {
  if (!event.buttons || draggedNotePath.value) return
  imagePan.value = { x: imagePan.value.x + event.movementX, y: imagePan.value.y + event.movementY }
}

const headerLabel = computed(() => (props.path ? (isImage.value || isPdf.value ? baseName(props.path) : currentTitle.value) : ''))
const selectedBlockIds = ref<string[]>([])
const saveState = computed(() => saveStateFor(props.path))
const canUndo = computed(() => canUndoFor(props.path))
const canRedo = computed(() => canRedoFor(props.path))

function findBlockPosition(blockId: string) {
  return findPosition(note.value, blockId)
}

// Tells a block or table menu which note and selection it was opened from.
function menuContext(): MenuContext {
  return {
    path: props.path!,
    selectedIds: [...selectedBlockIds.value],
    clearSelection: () => (selectedBlockIds.value = []),
    unhook: unhookBlocks,
  }
}

// Floats these blocks where they are on screen now: x from the middle of the note,
// y from its top. Every block is measured before the first one moves, since moving
// one shifts the rest.
function unhookBlocks(blockIds: string[]) {
  const noteEl = noteRef.value
  if (!noteEl || !props.path) return
  const noteRect = noteEl.getBoundingClientRect()
  const places = blockIds.flatMap((id) => {
    const el = blocksContainerRef.value?.querySelector<HTMLElement>(`.block[data-block-id="${id}"]`)
    if (!el) return []
    const rect = el.getBoundingClientRect()
    return [{
      id,
      x: Math.round(rect.left - (noteRect.left + noteRect.width / 2)),
      y: Math.round(rect.top - noteRect.top),
      width: Math.round(rect.width),
    }]
  })
  for (const { id, ...place } of places) unhookBlock(props.path, id, place)
}


const editingBlockId = ref<string | null>(null)
const textareaRefs = new Map<string, HTMLTextAreaElement>()
const showNoteMenu = ref(false)
const noteMenuRef = ref<HTMLElement | null>(null)

// The note's width: S is the narrowest. Stored in the note's metadata, and only written
// once changed; until then the default width from the settings applies (small if unset).
const WIDTHS = [
  { value: 'small', label: 'S', title: 'Small' },
  { value: 'medium', label: 'M', title: 'Medium' },
  { value: 'large', label: 'L', title: 'Large' },
] as const

const noteWidth = computed(() => note.value?.metadata.width ?? config.value.defaultNoteWidth ?? 'small')

function setNoteWidth(width: (typeof WIDTHS)[number]['value']) {
  if (note.value) note.value.metadata.width = width
}

// Where the note's column sits in the pane. Stored in the note's metadata, and only written
// once changed; until then it is centered.
const ALIGNS = [
  { value: 'left', label: 'L', title: 'Left' },
  { value: 'center', label: 'C', title: 'Center' },
  { value: 'right', label: 'R', title: 'Right' },
] as const

const notePosition = computed<(typeof ALIGNS)[number]['value']>(
  () => (note.value?.metadata.position as (typeof ALIGNS)[number]['value'] | undefined) ?? 'center',
)

function setNotePosition(position: (typeof ALIGNS)[number]['value']) {
  if (note.value) note.value.metadata.position = position
}

const bookmarked = computed({
  get: () => !!props.path && isBookmarked(props.path),
  set: () => {
    if (props.path) toggleBookmark(props.path)
  },
})

const showTitle = computed({
  get: () => {
    const own = note.value?.metadata.showTitle
    return typeof own === 'boolean' ? own : config.value.showTitleByDefault !== false
  },
  set: (value: boolean) => {
    if (note.value) note.value.metadata.showTitle = value
  },
})

// The note's text size, as a percentage of the normal size (100 is the default and
// isn't written). Drives --note-font-scale, which the note's own font-size is built from.
const FONT_SIZE_DEFAULT = 100

const fontSize = computed({
  get: () => (note.value?.metadata.fontSize as number | undefined) ?? FONT_SIZE_DEFAULT,
  set: (value: number) => {
    if (!note.value) return
    if (value === FONT_SIZE_DEFAULT) delete note.value.metadata.fontSize
    else note.value.metadata.fontSize = value
  },
})

function resetFontSize() {
  if (note.value) delete note.value.metadata.fontSize
}

// "Locate in browser": switches the sidebar to the file tree (expanding it if it's
// collapsed), then has it scroll to this note, expanding whichever of its ancestor
// folders are collapsed.
function locateInBrowser() {
  if (!props.path) return
  showNoteMenu.value = false
  config.value.sidebarTab = 'files'
  config.value.sidebarCollapsed = false
  nextTick(() => revealInTree(props.path!))
}

// Dragging the header title re-uses the sidebar's drag-a-note-in mechanism
// (draggedNotePath, handled by PaneLayout.vue): every pane shows the same drop
// zones, and dropping one opens the note there. The pane closes immediately on
// drag start, the same as its own close button, so the gap closes right away
// instead of waiting for the drop — dropped nowhere, the note just stays closed.
const dragGhostRef = ref<HTMLElement | null>(null)

function onHeaderDragStart(event: DragEvent) {
  if (!props.path) return
  draggedNotePath.value = props.path
  event.dataTransfer?.setData('text/plain', props.path)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  if (dragGhostRef.value) event.dataTransfer?.setDragImage(dragGhostRef.value, 14, 14)

  // Added directly rather than through Vue's own @dragend: closing the pane below
  // removes this element from the document, and Vue strips its own template
  // listeners as part of that. A plain listener added straight on the node still
  // fires when the browser dispatches dragend to it later, detached or not.
  const headerEl = event.currentTarget as HTMLElement
  headerEl.addEventListener('dragend', clearDraggedNote, { once: true })

  // Deferred a tick: closing synchronously here, before the browser has finished
  // setting up the native drag from this same dragstart, can make it cancel the
  // drag outright (it looked like nothing was being dragged at all). A pane only
  // ever has one note to drag at a time, so there's nothing to lose by waiting.
  setTimeout(() => emit('close'))
}

function clearDraggedNote() {
  draggedNotePath.value = null
}

// Renaming from the settings menu: "Rename" turns the title in the header into an input.
// Enter or leaving the box renames the note, if the new name is valid (Enter with a bad
// name keeps the box open and shows why; leaving with one puts the old name back);
// Escape puts the old name back.
const renamingTitle = ref(false)
const titleDraft = ref('')
const titleError = ref<string | null>(null)
let titleBusy = false

const vTitleFocus = {
  mounted(el: HTMLInputElement) {
    el.focus()
    el.select()
  },
}

function startTitleRename() {
  showNoteMenu.value = false
  titleDraft.value = currentTitle.value
  titleError.value = null
  renamingTitle.value = true
}

async function commitTitleRename(fromEnter: boolean) {
  if (!renamingTitle.value || titleBusy || !props.path) return
  titleBusy = true
  const error = await renameEntry('note', props.path, titleDraft.value.trim())
  titleBusy = false
  if (error && fromEnter) titleError.value = error
  else renamingTitle.value = false
}

watch(note, () => {
  renamingTitle.value = false
  showNoteMenu.value = false
  closeSuggest()
  selectedBlockIds.value = []
})

// Each time the settings menu opens, its created and saved times are fetched.
watch(showNoteMenu, (open) => {
  if (!open || !note.value) return
  loadNoteTimes()
})

// When the file was created and last saved, from the server's file times, shown at
// the bottom of the settings menu. Fetched each time the menu opens.
const noteTimes = ref<{ created: number; modified: number } | null>(null)

async function loadNoteTimes() {
  const path = props.path
  noteTimes.value = null
  if (!path) return
  try {
    const res = await fetch(`${SERVER_URL}/file-info?path=${encodeURIComponent(path)}`)
    if (res.ok && props.path === path) noteTimes.value = await res.json()
  } catch {
    // Server unreachable: the dates just stay blank.
  }
}

function formatTime(ms: number | undefined) {
  return ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'
}

// Footer: the open note's word count and whether its latest edits are saved.
const SAVE_LABELS = { saved: 'Saved', saving: 'Saving…', error: 'Not saved' }

const wordCount = computed(() => {
  if (!note.value) return 0
  let count = 0
  for (const block of allBlocks(note.value)) {
    // Words are runs of letters and digits; this skips markdown symbols like
    // table pipes and dividers, and entities such as &#124;.
    const text = block.content.replace(/&#?\w+;/g, ' ')
    count += text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0
  }
  return count
})

// Close the ⋮ menu when clicking anywhere outside it.
function onWindowClick(event: MouseEvent) {
  if (!showNoteMenu.value) return
  if (noteMenuRef.value && !noteMenuRef.value.contains(event.target as Node)) {
    showNoteMenu.value = false
  }
}

// Flips the [ ]/[x] of the nth checkbox item (in document order) in a block's
// markdown.
function toggleChecklistItem(block: Block, index: number) {
  let i = -1
  block.content = block.content
    .split('\n')
    .map((line) => {
      if (!LIST_ITEM_RE.checklist.test(line)) return line
      i++
      if (i !== index) return line
      return line.replace(/\[[ xX]\]/, (checkbox) => (checkbox === '[ ]' ? '[x]' : '[ ]'))
    })
    .join('\n')
}

function onBlockClick(event: MouseEvent, block: Block) {
  const target = event.target as HTMLElement
  if (target.closest('.block-indicator, .floating-grip, .floating-resize')) return
  // A table handles its own clicks (editing a cell, following a link in one)
  // entirely itself; it never falls through to opening the block's raw markdown.
  if (target.closest('.table-block')) return

  if (ctrlHeld.value) return toggleBlockSelected(block)
  selectedBlockIds.value = []

  // A widget in the text (a {{input, variable}}) handles its own click.
  if (handleWidgetEvent(event, props.path)) return

  const checkbox = target.closest('.block-checkbox') as HTMLElement | null
  if (checkbox) return toggleChecklistItem(block, Number(checkbox.dataset.index))

  const link = target.closest('.note-link') as HTMLElement | null
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
  // A plain markdown link (an external URL, not a [[wikilink]]): the browser opens
  // it (in a new tab — see markdown.ts's link renderer) rather than starting to
  // edit the block.
  if (target.closest('a')) return
  startEditing(block.id)
}

function setTextareaRef(id: string, el: Element | null) {
  if (el) textareaRefs.set(id, el as HTMLTextAreaElement)
  else textareaRefs.delete(id)
}

// --- [[ autocomplete: typing [[ lists notes at the cursor, filtered as you type.
// Picking one only inserts "Title]]" as text; how links render and open is
// renderBlock and onBlockClick above, untouched. ---

interface Suggest {
  blockId: string
  start: number // index just after the [[
  query: string
  left: number
  top?: number
  bottom?: number
}

const LIST_HEIGHT = 230 // the list's max height, to decide whether it fits below
const suggest = ref<Suggest | null>(null)
const suggestSelected = ref(0)

// Images and PDFs can each be left out of the list (settings).
const suggestResults = computed(() => {
  if (!suggest.value) return []
  const images = config.value.linkSuggestImages !== false
  const pdfs = config.value.linkSuggestPdfs !== false
  return findNotes(suggest.value.query).filter(
    (n) => n.path !== props.path && (images || !isImagePath(n.path)) && (pdfs || !isPdfPath(n.path)),
  )
})

watch(
  () => suggest.value?.query,
  () => (suggestSelected.value = 0),
)

function closeSuggest() {
  suggest.value = null
}

// Looks at the text just before the cursor. Typing may open the list; moving the
// cursor (arrows, clicks) only updates or closes one that is already open, so
// walking through an existing link doesn't pop it up.
// Plain :value + @input instead of v-model: v-model defers updating the block's content
// until compositionend, to avoid committing partial IME text — but mobile keyboards wrap
// ordinary typing in composition sessions too (for autocorrect), which only end at a space,
// enter or backspace, so autosave (it watches the note for changes) would otherwise stall
// mid-word on a phone.
function onBlockInput(block: Block, event: Event) {
  const el = event.target as HTMLTextAreaElement
  block.content = el.value
  updateSuggest(block, el, true)
}

function updateSuggest(block: Block, el: HTMLTextAreaElement, canOpen: boolean) {
  if (!canOpen && suggest.value?.blockId !== block.id) return
  const typed = el.selectionStart === el.selectionEnd && /\[\[([^[\]\n]*)$/.exec(el.value.slice(0, el.selectionStart))
  if (!typed) return closeSuggest()

  const query = typed[1]!
  const start = el.selectionStart - query.length
  const caret = caretPosition(el, start)
  const left = Math.max(8, Math.min(caret.left, window.innerWidth - 360))
  const below = caret.top + caret.lineHeight + 4
  const fitsBelow = below + LIST_HEIGHT < window.innerHeight || caret.top < LIST_HEIGHT
  suggest.value = {
    blockId: block.id,
    start,
    query,
    left,
    ...(fitsBelow ? { top: below } : { bottom: window.innerHeight - caret.top + 4 }),
  }
}

// The list is fixed on screen, so follow the cursor when the editor scrolls.
function onEditorScroll() {
  const open = suggest.value
  const el = open && textareaRefs.get(open.blockId)
  const block = open && findAnyBlock(note.value, open.blockId)
  if (el && block) updateSuggest(block, el, false)
}

function acceptSuggestion(entry: { title: string; path: string }) {
  const open = suggest.value
  const el = open && textareaRefs.get(open.blockId)
  const block = open && findAnyBlock(note.value, open.blockId)
  if (!open || !el || !block) return

  // If a closing ]] is already right after the cursor, reuse it.
  const after = el.value.slice(el.selectionStart)
  const rest = after.startsWith(']]') ? after.slice(2) : after
  const inserted = `${isImagePath(entry.path) || isPdfPath(entry.path) ? imageLinkText(entry.path) : entry.title}]]`
  block.content = el.value.slice(0, open.start) + inserted + rest
  const caretAt = open.start + inserted.length
  closeSuggest()
  nextTick(() => el.setSelectionRange(caretAt, caretAt))
}

// Keys while the list is showing. Returns true if the key was used.
function handleSuggestKey(event: KeyboardEvent): boolean {
  if (!suggest.value) return false
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSuggest()
    return true
  }

  const count = suggestResults.value.length
  if (count === 0 || event.ctrlKey || event.altKey || event.metaKey) return false
  if (event.key === 'ArrowDown') suggestSelected.value = Math.min(suggestSelected.value + 1, count - 1)
  else if (event.key === 'ArrowUp') suggestSelected.value = Math.max(suggestSelected.value - 1, 0)
  else if (event.key === 'Enter' || event.key === 'Tab') acceptSuggestion(suggestResults.value[suggestSelected.value]!)
  else return false
  event.preventDefault()
  return true
}

// Pasting an image saves it into the notebook and puts an ![[embed]] of it at the
// cursor. Pasting anything else is left to the browser.
async function onBlockPaste(event: ClipboardEvent, block: Block) {
  const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
  if (!file) return
  event.preventDefault()
  const el = event.target as HTMLTextAreaElement
  const { selectionStart, selectionEnd } = el
  const path = await addImage(file)
  if (!path) return
  const embed = `![[${imageLinkText(path)}]]`
  block.content = block.content.slice(0, selectionStart) + embed + block.content.slice(selectionEnd)
  const caretAt = selectionStart + embed.length
  nextTick(() => el.setSelectionRange(caretAt, caretAt))
}

function onBlockKeyup(event: KeyboardEvent, block: Block) {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    updateSuggest(block, event.target as HTMLTextAreaElement, false)
  }
}

// Puts text at the cursor of the block being edited (replacing any selection), for the
// variable menu. The block keeps the focus; `select` picks part of the text afterwards.
function insertAtCursor(text: string, select?: [number, number]) {
  const id = editingBlockId.value
  const el = id && textareaRefs.get(id)
  const block = id && findAnyBlock(note.value, id)
  if (!el || !block) return
  const start = el.selectionStart
  block.content = el.value.slice(0, start) + text + el.value.slice(el.selectionEnd)
  const [from, to] = select ? [start + select[0], start + select[1]] : [start + text.length, start + text.length]
  nextTick(() => {
    el.focus()
    el.setSelectionRange(from, to)
  })
}

const unregisterInserter = registerInserter({
  isFocused: () => props.focused,
  canInsert: () => !!editingBlockId.value && textareaRefs.has(editingBlockId.value),
  insert: insertAtCursor,
})

// For the block browser: select a block, scroll to it, and bring a floating one to the front.
function revealBlockHere(blockId: string) {
  if (!findAnyBlock(note.value, blockId)) return
  if (isFloating(blockId)) bringToFront([blockId])
  selectedBlockIds.value = [blockId]
  nextTick(() =>
    blocksContainerRef.value
      ?.querySelector(`.block[data-block-id="${blockId}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
  )
}

const unregisterBlockActions = registerBlockActions({
  isFocused: () => props.focused && !!note.value,
  reveal: revealBlockHere,
  unhook: (blockIds) => unhookBlocks(blockIds),
})

function startEditing(blockId: string) {
  editingBlockId.value = blockId
  nextTick(() => textareaRefs.get(blockId)?.focus())
}

function appendBlock() {
  if (!note.value || ctrlHeld.value) return
  selectedBlockIds.value = []
  const newBlock: Block = { id: `block-${randomUUID()}`, type: 'text', content: '' }
  note.value.blocks.push([newBlock])
  startEditing(newBlock.id)
}

function removeBlock(blockId: string): Block | null {
  if (!note.value) return null
  const pos = findBlockPosition(blockId)
  if (!pos) {
    const floating = note.value.floating
    const index = floating?.findIndex((b) => b.id === blockId) ?? -1
    if (!floating || index === -1) return null
    const [removed] = floating.splice(index, 1)
    if (!floating.length) delete note.value.floating // the field exists only while a block floats
    return removed ?? null
  }
  const row = note.value.blocks[pos.rowIndex]!
  const removed = row.splice(pos.colIndex, 1)[0] ?? null
  if (row.length === 0) note.value.blocks.splice(pos.rowIndex, 1)
  return removed
}

function flattenBlocks(): Block[] {
  if (!note.value) return []
  return note.value.blocks.flat()
}

// A text block that is exactly one markdown table is shown as an editable table.
function isTableBlock(block: Block): boolean {
  return (block.type === 'text' || block.type === 'table') && isPureTable(block.content)
}

// A block's type is detected from its content, the same as a table: typing
// "- [ ] " or "- " and nothing else in the block turns it into that kind of list.
const AUTO_TYPES = ['text', 'table', 'checklist', 'bulletlist']

function detectBlockType(content: string): string {
  if (isPureTable(content)) return 'table'
  if (isPureChecklist(content)) return 'checklist'
  if (isPureBulletList(content)) return 'bulletlist'
  return 'text'
}

function stopEditing(block: Block) {
  closeSuggest()
  if (editingBlockId.value === block.id) editingBlockId.value = null
  if (AUTO_TYPES.includes(block.type)) block.type = detectBlockType(block.content)
  if (!block.content.trim()) removeBlock(block.id)
}

// Continuing a list: the prefix a new item starts with, and how to recognize one
// already on a line. Checked against the line itself, not the block's stored
// type, since that's only set on blur (stopEditing) and a block being typed into
// for the first time is still 'text'.
const LIST_PREFIXES = { checklist: '- [ ] ', bulletlist: '- ' } as const
const LIST_ITEM_RE = { checklist: /^-\s\[[ xX]\]\s?/, bulletlist: /^-\s?/ } as const

// A bullet or checklist line, "-" or "*", for Tab/Enter indent handling below.
// (handleListEnter above only recognizes "-", since that's the only prefix this
// app inserts; this also covers "*" since a pasted or hand-typed list may use it.)
const BULLET_LINE_RE = /^[-*]\s/

function insertBlockAfter(pos: { rowIndex: number }, content: string): Block {
  const newBlock: Block = { id: `block-${randomUUID()}`, type: 'text', content }
  note.value!.blocks.splice(pos.rowIndex + 1, 0, [newBlock])
  return newBlock
}

// In a checklist/bullet-list block, Enter adds another item instead of splitting
// into a new block, the way it does inside a table's cells. Enter on an item left
// empty drops it and splits normally, so the list doesn't trap you. Returns true if
// it handled the key.
function handleListEnter(block: Block, textarea: HTMLTextAreaElement): boolean {
  if (!note.value) return false
  const pos = findBlockPosition(block.id) // none for a floating block

  const splitPoint = textarea.selectionStart
  const lineStart = block.content.lastIndexOf('\n', splitPoint - 1) + 1
  const lineEnd = block.content.indexOf('\n', splitPoint)
  const line = block.content.slice(lineStart, lineEnd === -1 ? block.content.length : lineEnd)
  // An indented item (handleListTab's doing) continues at the same indent.
  const indent = /^ */.exec(line)![0]
  const content = line.slice(indent.length)
  const kind = LIST_ITEM_RE.checklist.test(content) ? 'checklist' : LIST_ITEM_RE.bulletlist.test(content) ? 'bulletlist' : null
  if (!kind) return false
  const match = LIST_ITEM_RE[kind].exec(content)!

  if (!content.slice(match[0].length).trim()) {
    const after = block.content.slice(lineEnd === -1 ? block.content.length : lineEnd)
    block.content = block.content.slice(0, lineStart).replace(/\n$/, '')
    if (!pos) {
      // Floating: the empty item is dropped and editing ends, there's nowhere to split to.
      stopEditing(block)
      return true
    }
    const newBlock = insertBlockAfter(pos, after)
    stopEditing(block)
    startEditing(newBlock.id)
    return true
  }

  const prefix = indent + LIST_PREFIXES[kind]
  block.content = block.content.slice(0, splitPoint) + '\n' + prefix + block.content.slice(splitPoint)
  block.type = kind
  const caret = splitPoint + 1 + prefix.length
  nextTick(() => textarea.setSelectionRange(caret, caret))
  return true
}

// Tab on a bullet/checklist line indents it two spaces (nesting it under the item
// above), wherever the caret is on the line. Returns true if it handled the key.
function handleListTab(block: Block, textarea: HTMLTextAreaElement): boolean {
  if (textarea.selectionStart !== textarea.selectionEnd) return false
  const pos = textarea.selectionStart
  const lineStart = block.content.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = block.content.indexOf('\n', pos)
  const line = block.content.slice(lineStart, lineEnd === -1 ? block.content.length : lineEnd)
  if (!BULLET_LINE_RE.test(line.replace(/^ */, ''))) return false

  block.content = block.content.slice(0, lineStart) + '  ' + block.content.slice(lineStart)
  const caret = pos + 2
  nextTick(() => textarea.setSelectionRange(caret, caret))
  return true
}

// The reverse of handleListTab: Shift+Tab on an indented bullet/checklist line
// removes two spaces of its indent, wherever the caret is on the line. Does
// nothing if there's no indent to remove. Returns true if it handled the key.
function handleListShiftTab(block: Block, textarea: HTMLTextAreaElement): boolean {
  if (textarea.selectionStart !== textarea.selectionEnd) return false
  const pos = textarea.selectionStart
  const lineStart = block.content.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = block.content.indexOf('\n', pos)
  const line = block.content.slice(lineStart, lineEnd === -1 ? block.content.length : lineEnd)
  const indent = /^ */.exec(line)![0].length
  if (indent < 2 || !BULLET_LINE_RE.test(line.slice(indent))) return false

  block.content = block.content.slice(0, lineStart) + block.content.slice(lineStart + 2)
  const caret = Math.max(lineStart, pos - 2)
  nextTick(() => textarea.setSelectionRange(caret, caret))
  return true
}

// Ctrl+B / Ctrl+I / Ctrl+E / Ctrl+Shift+X wrap the selection in bold, italic, code or
// strikethrough markers (or take them off again); see format.ts.
function formatSelection(event: KeyboardEvent, block: Block): boolean {
  if (!event.ctrlKey || event.altKey || event.metaKey) return false
  const key = event.key.toLowerCase()
  const format = FORMATS.find((f) => f.key === key && f.shift === event.shiftKey)
  if (!format) return false

  event.preventDefault()
  const el = event.target as HTMLTextAreaElement
  const result = toggleWrap(el.value, el.selectionStart, el.selectionEnd, format.marker)
  block.content = result.text
  nextTick(() => el.setSelectionRange(result.start, result.end))
  return true
}

// Auto-pairing brackets (a setting): typing an opening one adds its closing one after it
// (around the selection, if there is one) when what follows is a space, the end of the
// text or a closer; typing a closer that is already next steps over it. Typing [ twice
// therefore makes [[]], and the link list opens in the middle of it. Returns true if it
// handled the key.
const BRACKET_PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

function handleAutoPair(event: KeyboardEvent, block: Block): boolean {
  if (config.value.autoPairBrackets === false) return false
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return false
  const el = event.target as HTMLTextAreaElement
  const { selectionStart: start, selectionEnd: end } = el
  const next = el.value[end] ?? ''

  const closer = BRACKET_PAIRS[event.key]
  if (closer) {
    if (start === end && next && !/\s/.test(next) && !Object.values(BRACKET_PAIRS).includes(next)) return false
    event.preventDefault()
    block.content = el.value.slice(0, start) + event.key + el.value.slice(start, end) + closer + el.value.slice(end)
    // Around a selection it stays selected; otherwise the caret goes between the pair.
    nextTick(() => {
      el.setSelectionRange(start + 1, start === end ? start + 1 : end + 1)
      updateSuggest(block, el, true)
    })
    return true
  }

  if (start === end && Object.values(BRACKET_PAIRS).includes(event.key) && next === event.key) {
    event.preventDefault()
    el.setSelectionRange(start + 1, start + 1)
    return true
  }
  return false
}

// Backspace between an empty pair removes both halves. Returns true if it did.
function handleAutoPairBackspace(event: KeyboardEvent, block: Block): boolean {
  if (config.value.autoPairBrackets === false) return false
  const el = event.target as HTMLTextAreaElement
  const { selectionStart: pos, selectionEnd: end } = el
  if (pos !== end || pos === 0 || BRACKET_PAIRS[el.value[pos - 1] ?? ''] !== el.value[pos]) return false
  event.preventDefault()
  block.content = el.value.slice(0, pos - 1) + el.value.slice(pos + 1)
  nextTick(() => {
    el.setSelectionRange(pos - 1, pos - 1)
    updateSuggest(block, el, false)
  })
  return true
}

function onBlockKeydown(event: KeyboardEvent, block: Block) {
  if (handleSuggestKey(event) || formatSelection(event, block) || handleAutoPair(event, block)) return

  if (event.key === 'Escape') {
    event.preventDefault()
    ;(event.target as HTMLTextAreaElement).blur()
    return
  }

  if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey) {
    const textarea = event.target as HTMLTextAreaElement
    const handled = event.shiftKey ? handleListShiftTab(block, textarea) : handleListTab(block, textarea)
    if (handled) event.preventDefault()
    return
  }

  if (event.key === 'Enter') {
    // Enter does the main thing and Shift+Enter the other (a setting): splitting the block
    // or adding a new line. Adding one is the browser's own doing, so it is left alone,
    // except that Enter in a list still continues it.
    const splits = (config.value.enterBehavior !== 'newline') !== event.shiftKey
    const textarea = event.target as HTMLTextAreaElement
    if (!splits) {
      if (!event.shiftKey && note.value && handleListEnter(block, textarea)) event.preventDefault()
      return
    }
    event.preventDefault()
    if (!note.value) return
    if (!event.shiftKey && handleListEnter(block, textarea)) return

    const pos = findBlockPosition(block.id)
    if (!pos) {
      // A floating block doesn't split: Enter is a new line, like Shift+Enter.
      const { selectionStart, selectionEnd } = textarea
      block.content = block.content.slice(0, selectionStart) + '\n' + block.content.slice(selectionEnd)
      nextTick(() => textarea.setSelectionRange(selectionStart + 1, selectionStart + 1))
      return
    }
    const splitPoint = textarea.selectionStart
    const after = block.content.slice(splitPoint)
    const newBlock = insertBlockAfter(pos, after)
    block.content = block.content.slice(0, splitPoint)
    stopEditing(block)
    startEditing(newBlock.id)
    return
  }

  if (event.key === 'Backspace') {
    if (handleAutoPairBackspace(event, block)) return
    onBlockBackspace(event, block)
    return
  }

}

function onBlockBackspace(event: KeyboardEvent, block: Block) {
  if (!note.value) return
  const textarea = event.target as HTMLTextAreaElement

  // A floating block has no block before it to join; Backspace in an empty one deletes it.
  if (!findBlockPosition(block.id)) {
    if (!block.content.trim()) {
      event.preventDefault()
      removeBlock(block.id)
      editingBlockId.value = null
    }
    return
  }

  const flat = flattenBlocks()
  const flatIndex = flat.findIndex((b) => b.id === block.id)
  const previousBlock = flat[flatIndex - 1]

  if (!block.content.trim()) {
    if (!previousBlock) return
    event.preventDefault()
    removeBlock(block.id)
    startEditing(previousBlock.id)
    nextTick(() => {
      const el = textareaRefs.get(previousBlock.id)
      if (el) el.selectionStart = el.selectionEnd = el.value.length
    })
    return
  }

  if (textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
    if (!previousBlock) return
    event.preventDefault()

    const mergePoint = previousBlock.content.length
    previousBlock.content += block.content
    removeBlock(block.id)
    startEditing(previousBlock.id)
    nextTick(() => {
      const el = textareaRefs.get(previousBlock.id)
      if (el) el.selectionStart = el.selectionEnd = mergePoint
    })
  }
}

// Two separate Ctrl systems, depending on whether a block is being edited:
//  - Editing: Ctrl+Up/Down moves the editing to the block above or below. Nothing else
//    changes.
//  - Not editing: holding Ctrl outlines every block, makes each one draggable as a
//    whole, and lets clicks and a dragged box select several (selectedBlockIds). The
//    selection outlives the release, so the right-click menu can still apply its
//    settings to all of it; it is cleared by the next Ctrl press, a plain click,
//    Escape, or switching notes.
// ctrlHeld is the second one, worked out from whether Ctrl is down.
const ctrlKeyDown = ref(false) // physically down, whichever pane has the focus
const ctrlHeld = computed(
  () => ctrlKeyDown.value && props.focused && !!note.value && !editingBlockId.value && !switcherOpen.value,
)

// Each new Ctrl press starts a fresh selection.
watch(ctrlHeld, (held) => {
  if (held) selectedBlockIds.value = []
})

// Ctrl+Up/Down while editing: carry on editing the block above or below.
function moveEditingBlock(by: -1 | 1) {
  const flat = allBlocks(note.value)
  const index = flat.findIndex((b) => b.id === editingBlockId.value)
  const target = flat[index + by]
  if (index === -1 || !target) return
  stopEditing(flat[index]!) // an empty block is dropped here
  startEditing(target.id)
  nextTick(() => {
    const el = textareaRefs.get(target.id)
    if (el) el.selectionStart = el.selectionEnd = el.value.length
  })
}

// A click while Ctrl is held picks the block (a second click lets it go again).
// A selection is all hooked blocks or all floating ones, whichever was picked first, so
// that what the menu and a drag do to it is the same for every block in it.
function toggleBlockSelected(block: Block) {
  const ids = selectedBlockIds.value
  if (ids.includes(block.id)) selectedBlockIds.value = ids.filter((id) => id !== block.id)
  else if (!ids.length || isFloating(ids[0]!) === isFloating(block.id)) selectedBlockIds.value = [...ids, block.id]
}

function isFloating(blockId: string) {
  return !!note.value?.floating?.some((b) => b.id === blockId)
}

// The selection box, in window coordinates, while one is being dragged.
const marquee = ref<{ x: number; y: number; w: number; h: number } | null>(null)

// In a Ctrl session a drag that starts on a block moves it (the whole selection, if
// it's one of the selected). A drag that starts anywhere else draws a box and
// selects every block it touches, added to what was already selected.
function onEditorMouseDown(event: MouseEvent) {
  const editor = editorRef.value
  if (event.button !== 0 || !editor || !note.value) return
  if (!ctrlHeld.value) return
  if (event.clientX >= editor.getBoundingClientRect().left + editor.clientWidth) return // the scrollbar
  if ((event.target as HTMLElement).closest('.block')) return // blocks drag natively
  event.preventDefault() // no text selection

  const startX = event.clientX
  const startY = event.clientY
  const startScroll = editor.scrollTop
  const base = selectedBlockIds.value
  let dragging = false

  const onMove = (e: MouseEvent) => {
    if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return
    dragging = true

    // The box's start stays fixed in the note if the editor scrolls meanwhile.
    const anchorY = startY + startScroll - editor.scrollTop
    const left = Math.min(startX, e.clientX)
    const right = Math.max(startX, e.clientX)
    const top = Math.min(anchorY, e.clientY)
    const bottom = Math.max(anchorY, e.clientY)
    marquee.value = { x: left, y: top, w: right - left, h: bottom - top }

    const hits = [...(blocksContainerRef.value?.querySelectorAll<HTMLElement>('.block') ?? [])]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.left < right && r.right > left && r.top < bottom && r.bottom > top
      })
      .map((el) => el.dataset.blockId!)
    // Only the kind already selected (or, for a first pick, that of the first block hit).
    const floatingKind = isFloating(base[0] ?? hits[0] ?? '')
    selectedBlockIds.value = [...new Set([...base, ...hits.filter((id) => isFloating(id) === floatingKind)])]
  }

  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    marquee.value = null
    if (dragging) swallowNextClick()
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// The click that follows a drag must not also toggle or open a block.
function swallowNextClick() {
  const swallow = (e: Event) => e.stopPropagation()
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, true), 0)
}

// --- Floating blocks: moving, resizing, stacking. A drag only shifts the block's element
// while it lasts; the note changes once, on release, so a drag is a single undo step. ---

const MIN_FLOATING_WIDTH = 120

function floatingEl(blockId: string) {
  return blocksContainerRef.value?.querySelector<HTMLElement>(`.block.floating[data-block-id="${blockId}"]`) ?? null
}

// Where a floating block may be: x (from the middle of the note) from the editor's left
// edge to its right edge, so it can't be lost off the side.
function floatingBounds() {
  const editor = editorRef.value
  const noteEl = noteRef.value
  if (!editor || !noteEl) return null
  const noteRect = noteEl.getBoundingClientRect()
  const centre = noteRect.left + noteRect.width / 2
  const editorLeft = editor.getBoundingClientRect().left
  return { left: editorLeft + 8 - centre, right: editorLeft + editor.clientWidth - 8 - centre }
}

// Puts these floating blocks in front of all the others, keeping their order.
function bringToFront(blockIds: string[]) {
  const floating = note.value?.floating
  if (!floating) return
  const moving = floating.filter((b) => blockIds.includes(b.id)).sort((a, b) => a.z - b.z)
  const top = Math.max(0, ...floating.filter((b) => !blockIds.includes(b.id)).map((b) => b.z))
  moving.forEach((b, i) => (b.z = top + 1 + i))
}

// Any press on a floating block: while Ctrl is held the whole block is the handle (so a
// plain click still selects it); otherwise it just comes to the front.
function onFloatingMouseDown(event: MouseEvent, block: FloatingBlock) {
  if (event.button !== 0) return
  if (ctrlHeld.value) {
    event.preventDefault() // no text selection
    startFloatingDrag(event, block)
  } else {
    bringToFront([block.id])
  }
}

// Drags a floating block, or all the selected ones if it is one of them, staying inside
// the editor (and not above the top of the note).
// The gap a dragged floating block would be hooked into if let go now, or null while it is
// outside the middle of the note (where it just stays floating). Drawn like a reorder gap.
const floatHookGap = ref<number | null>(null)

function floatHookGapAt(clientX: number, clientY: number): number | null {
  const noteEl = noteRef.value
  const container = blocksContainerRef.value
  if (!noteEl || !container) return null
  const noteRect = noteEl.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  const insideX = clientX > noteRect.left + EDGE_ZONE_PX && clientX < noteRect.right - EDGE_ZONE_PX
  const insideY = clientY >= containerRect.top && clientY <= containerRect.bottom
  return insideX && insideY ? closestGapIndex(clientY) : null
}

function startFloatingDrag(event: MouseEvent, block: FloatingBlock) {
  const editor = editorRef.value
  const floating = note.value?.floating
  const bounds = floatingBounds()
  if (event.button !== 0 || !editor || !floating || !bounds) return

  const ids = selectedBlockIds.value.includes(block.id) ? selectedBlockIds.value : [block.id]
  const moving = floating.filter((b) => ids.includes(b.id))
  const els = moving.map((b) => floatingEl(b.id))
  const minDx = Math.max(...moving.map((b) => bounds.left - b.x))
  const maxDx = Math.min(...moving.map((b) => bounds.right - b.width - b.x))
  const minDy = Math.max(...moving.map((b) => -b.y))
  const startX = event.clientX
  const startY = event.clientY
  const startScroll = editor.scrollTop
  let dx = 0
  let dy = 0
  let dragging = false

  const onMove = (e: MouseEvent) => {
    if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return
    if (!dragging) {
      dragging = true
      bringToFront(moving.map((b) => b.id))
    }
    dx = Math.round(Math.max(minDx, Math.min(e.clientX - startX, maxDx)))
    // The block stays under the mouse if the editor scrolls meanwhile.
    dy = Math.round(Math.max(minDy, e.clientY - startY + editor.scrollTop - startScroll))
    for (const el of els) if (el) el.style.transform = `translate(${dx}px, ${dy}px)`
    floatHookGap.value = floatHookGapAt(e.clientX, e.clientY)
  }

  const onUp = (e: MouseEvent) => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    floatHookGap.value = null
    if (!dragging) return
    // Let go over the middle of the note: hook the block(s) back in at the nearest gap,
    // top to bottom as they were, each in a row of its own.
    const gap = floatHookGapAt(e.clientX, e.clientY)
    if (gap !== null && props.path) {
      for (const el of els) if (el) el.style.transform = ''
      const path = props.path
      moving
        .slice()
        .sort((a, b) => a.y - b.y)
        .forEach((b, i) => placeBlock(path, b.id, gap + i))
      swallowNextClick()
      return
    }
    for (const b of moving) {
      b.x += dx
      b.y += dy
    }
    for (const el of els) if (el) el.style.transform = ''
    swallowNextClick()
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// Drags the right edge of a floating block to change its width.
function startFloatingResize(event: MouseEvent, block: FloatingBlock) {
  const bounds = floatingBounds()
  const el = floatingEl(block.id)
  if (event.button !== 0 || !bounds || !el) return

  const startX = event.clientX
  const maxWidth = Math.max(MIN_FLOATING_WIDTH, bounds.right - block.x)
  let width = block.width

  const onMove = (e: MouseEvent) => {
    width = Math.round(Math.min(maxWidth, Math.max(MIN_FLOATING_WIDTH, block.width + e.clientX - startX)))
    el.style.width = width + 'px'
  }

  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    if (width !== block.width) block.width = width
    swallowNextClick()
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// Right-clicking the block being edited leaves the browser's own menu alone (so
// spellcheck, cut/copy/paste still work); only a block that's just rendered, not
// being typed into, gets our menu. Right-clicking outside the selection starts it
// over with just that block.
function onBlockContextMenu(event: MouseEvent, block: Block) {
  if (editingBlockId.value === block.id) return
  event.preventDefault()
  event.stopPropagation()
  if (!selectedBlockIds.value.includes(block.id)) selectedBlockIds.value = []
  emit('block-menu', event, block, menuContext())
}

// Right-clicking the blank area below the last block offers the same inserts a
// click there would let you type manually, as a menu instead.
function onBlankContextMenu(event: MouseEvent) {
  if (!props.path) return
  emit('blank-menu', event, props.path)
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Control') ctrlKeyDown.value = true
  if (!props.focused || switcherOpen.value) return // the switcher uses the arrow keys
  if (event.key === 'Escape' && selectedBlockIds.value.length) selectedBlockIds.value = []

  if (event.ctrlKey && editingBlockId.value && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault()
    moveEditingBlock(event.key === 'ArrowUp' ? -1 : 1)
    return
  }

  // Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes. This replaces the browser's own
  // text undo inside blocks; other text fields (the title box, rename inputs)
  // keep theirs.
  const key = event.key.toLowerCase()
  if (!(event.ctrlKey || event.metaKey) || event.altKey || (key !== 'z' && key !== 'y')) return
  const target = event.target as HTMLElement
  if (!note.value || (target.closest('input, textarea') && !target.closest('.block'))) return
  event.preventDefault()
  if (key === 'y' || event.shiftKey) redo()
  else undo()
}

function undo() {
  if (props.path) undoEdit(props.path)
  dropMissingEditingBlock()
}

function redo() {
  if (props.path) redoEdit(props.path)
  dropMissingEditingBlock()
}

// An undo can remove the block being edited.
function dropMissingEditingBlock() {
  if (editingBlockId.value && !findAnyBlock(note.value, editingBlockId.value)) editingBlockId.value = null
}

// The browser turns Ctrl+wheel into page zoom, which would swallow scrolling in
// Ctrl mode. Scroll the editor ourselves instead.
const editorRef = ref<HTMLElement | null>(null)

function onWindowWheel(event: WheelEvent) {
  const editor = editorRef.value
  if (!event.ctrlKey || !editor || !editor.contains(event.target as Node)) return
  event.preventDefault()
  editor.scrollBy({ top: event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY })
}

function onWindowKeyup(event: KeyboardEvent) {
  if (event.key === 'Control') ctrlKeyDown.value = false
}

function onWindowBlur() {
  ctrlKeyDown.value = false
}

const draggedBlockId = ref<string | null>(null)
const hoveredGapIndex = ref<number | null>(null)
const dragMode = ref<'vertical' | 'horizontal' | 'float'>('vertical')
const dragSide = ref<'left' | 'right' | null>(null)
const hoveredRowIndex = ref<number | null>(null)
const blocksContainerRef = ref<HTMLElement | null>(null)
const noteRef = ref<HTMLElement | null>(null)

// The band around each edge of the note, in px, that counts as "near the edge"
// for forming a column: reaches a bit inside the note as well as just past it.
// Beyond that, outside the note, is the float (unhook) zone instead.
const EDGE_ZONE_PX = 32

// The cursor's last position while dragging a block, since the drop handler isn't
// wired with the DragEvent itself.
const dragX = ref(0)
const dragY = ref(0)

// The margin strip highlighted while hovering the float zone: from the editor's
// edge to the note's edge, on whichever side the cursor is on.
const floatZoneRect = ref<{ left: number; top: number; width: number; height: number } | null>(null)

function onGripDragStart(event: DragEvent, block: Block) {
  draggedBlockId.value = block.id
  event.dataTransfer?.setData('text/plain', block.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'

  const blockEl = (event.currentTarget as HTMLElement).closest('.block') as HTMLElement | null
  if (blockEl) event.dataTransfer?.setDragImage(blockEl, 20, 20)
}

function closestGapIndex(clientY: number): number {
  if (!blocksContainerRef.value || !note.value) return 0
  const rowEls = Array.from(blocksContainerRef.value.querySelectorAll('.block-row')) as HTMLElement[]

  for (let i = 0; i < rowEls.length; i++) {
    const rect = rowEls[i]!.getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) return i
  }
  return note.value.blocks.length
}

function closestRowIndex(clientY: number): number | null {
  if (!blocksContainerRef.value || !note.value || note.value.blocks.length === 0) return null
  const rowEls = Array.from(blocksContainerRef.value.querySelectorAll('.block-row')) as HTMLElement[]

  for (let i = 0; i < rowEls.length; i++) {
    const rect = rowEls[i]!.getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) return i
  }
  return rowEls.length - 1
}

function onBlocksDragOver(event: DragEvent) {
  if (!draggedBlockId.value || !noteRef.value) return
  dragX.value = event.clientX
  dragY.value = event.clientY
  const noteRect = noteRef.value.getBoundingClientRect()

  // Positive while inside the note, negative past that edge.
  const fromLeft = event.clientX - noteRect.left
  const fromRight = noteRect.right - event.clientX

  if (fromLeft < -EDGE_ZONE_PX || fromRight < -EDGE_ZONE_PX) {
    dragMode.value = 'float'
    dragSide.value = fromLeft < fromRight ? 'left' : 'right'
    hoveredRowIndex.value = null
    hoveredGapIndex.value = null

    const editorRect = editorRef.value!.getBoundingClientRect()
    floatZoneRect.value =
      dragSide.value === 'left'
        ? { left: editorRect.left, top: editorRect.top, width: noteRect.left - editorRect.left, height: editorRect.height }
        : { left: noteRect.right, top: editorRect.top, width: editorRect.right - noteRect.right, height: editorRect.height }
  } else if (fromLeft < EDGE_ZONE_PX || fromRight < EDGE_ZONE_PX) {
    dragMode.value = 'horizontal'
    dragSide.value = fromLeft < fromRight ? 'left' : 'right'
    const rowIndex = closestRowIndex(event.clientY)
    const draggedPos = findBlockPosition(draggedBlockId.value)
    hoveredRowIndex.value = draggedPos && draggedPos.rowIndex === rowIndex ? null : rowIndex
    hoveredGapIndex.value = null
    floatZoneRect.value = null
  } else {
    dragMode.value = 'vertical'
    dragSide.value = null
    hoveredRowIndex.value = null
    hoveredGapIndex.value = closestGapIndex(event.clientY)
    floatZoneRect.value = null
  }
}

// The blocks a drag carries: all the Ctrl+clicked blocks if the dragged one is among
// them (in their order in the note), otherwise just the dragged block.
function draggedBlockIds(): string[] {
  const id = draggedBlockId.value!
  if (selectedBlockIds.value.length > 1 && selectedBlockIds.value.includes(id)) {
    return flattenBlocks()
      .filter((b) => selectedBlockIds.value.includes(b.id))
      .map((b) => b.id)
  }
  return [id]
}

// Unhooks the dragged block(s) into the float zone: measures every dragged block's
// rect before any of them move (same approach as unhookBlocks, above), then shifts
// them all by one delta so the dragged block's grab point (20px in from its
// top-left, matching the drag-ghost offset set in onGripDragStart) lands under the
// cursor. A multi-block drag keeps the group's layout, just shifted as one.
function onFloatDrop() {
  if (!note.value || !props.path || !noteRef.value || !draggedBlockId.value) return
  const noteRect = noteRef.value.getBoundingClientRect()
  const draggedEl = blocksContainerRef.value?.querySelector<HTMLElement>(
    `.block[data-block-id="${draggedBlockId.value}"]`,
  )
  if (!draggedEl) return onDragEnd()
  const draggedRect = draggedEl.getBoundingClientRect()
  const deltaX = dragX.value - 20 - draggedRect.left
  const deltaY = dragY.value - 20 - draggedRect.top

  const places = draggedBlockIds().flatMap((id) => {
    const el = blocksContainerRef.value?.querySelector<HTMLElement>(`.block[data-block-id="${id}"]`)
    if (!el) return []
    const rect = el.getBoundingClientRect()
    return [{
      id,
      x: Math.round(rect.left + deltaX - (noteRect.left + noteRect.width / 2)),
      y: Math.round(rect.top + deltaY - noteRect.top),
      width: Math.round(rect.width),
    }]
  })
  for (const { id, ...place } of places) unhookBlock(props.path, id, place)
  onDragEnd()
}

function onBlocksDrop() {
  if (!note.value || !draggedBlockId.value) return
  if (dragMode.value === 'float') return onFloatDrop()
  const ids = draggedBlockIds()
  if (!ids.every((id) => findBlockPosition(id))) return onDragEnd()

  if (dragMode.value === 'horizontal') {
    if (hoveredRowIndex.value === null) return onDragEnd()

    // Dropping onto a row made only of the dragged blocks would leave nowhere to go.
    const targetRow = note.value.blocks[hoveredRowIndex.value]
    if (!targetRow || targetRow.every((b) => ids.includes(b.id))) return onDragEnd()

    const moved = ids.map((id) => removeBlock(id)!)
    if (dragSide.value === 'left') targetRow.unshift(...moved)
    else targetRow.push(...moved)
  } else {
    const gapIndex = hoveredGapIndex.value ?? closestGapIndex(0)
    // Rows above the gap that empty out shift the gap up by one each.
    const rowsRemovedAbove = note.value.blocks
      .slice(0, gapIndex)
      .filter((row) => row.every((b) => ids.includes(b.id))).length

    const moved = ids.map((id) => removeBlock(id)!)
    note.value.blocks.splice(gapIndex - rowsRemovedAbove, 0, ...moved.map((b) => [b]))
  }

  onDragEnd()
}

function onDragEnd() {
  draggedBlockId.value = null
  hoveredGapIndex.value = null
  hoveredRowIndex.value = null
  dragSide.value = null
  dragMode.value = 'vertical'
  floatZoneRect.value = null
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('keyup', onWindowKeyup)
  window.addEventListener('wheel', onWindowWheel, { passive: false })
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('click', onWindowClick)
})

// Panes come and go, so none may leave its window listeners behind.
onUnmounted(() => {
  unregisterInserter()
  unregisterBlockActions()
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('keyup', onWindowKeyup)
  window.removeEventListener('wheel', onWindowWheel)
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('click', onWindowClick)
})
</script>

<template>
  <div class="content-column">
    <header class="app-header">
      <div v-if="note" ref="noteMenuRef">
        <button class="icon-button" title="Note settings" aria-label="Note settings" @click="showNoteMenu = !showNoteMenu">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <div v-if="showNoteMenu" class="note-menu">
          <label class="settings-row">
            <input type="checkbox" class="checkbox" v-model="bookmarked" />
            Bookmark
          </label>
          <label class="settings-row">
            <input type="checkbox" class="checkbox" v-model="showTitle" />
            Show title
          </label>
          <div class="context-separator" />
          <div class="settings-group">
            <label class="settings-label">Width</label>
            <div class="segmented">
              <button
                v-for="w in WIDTHS"
                :key="w.value"
                class="segment"
                :class="{ active: noteWidth === w.value }"
                :title="w.title"
                :aria-label="`${w.title} width`"
                @click="setNoteWidth(w.value)"
              >
                {{ w.label }}
              </button>
            </div>
          </div>
          <div class="settings-group">
            <label class="settings-label">Position</label>
            <div class="segmented">
              <button
                v-for="p in ALIGNS"
                :key="p.value"
                class="segment"
                :class="{ active: notePosition === p.value }"
                :title="p.title"
                :aria-label="`${p.title} position`"
                @click="setNotePosition(p.value)"
              >
                {{ p.label }}
              </button>
            </div>
          </div>
          <div class="settings-group">
            <label class="settings-label">Text size</label>
            <div class="font-size-row">
              <input
                type="range"
                class="font-size-slider"
                min="70"
                max="160"
                step="5"
                :value="fontSize"
                @input="fontSize = Number(($event.target as HTMLInputElement).value)"
              />
              <span class="font-size-value">{{ fontSize }}%</span>
              <button
                class="icon-button"
                title="Reset to default"
                aria-label="Reset text size to default"
                :disabled="fontSize === FONT_SIZE_DEFAULT"
                @click="resetFontSize"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                </svg>
              </button>
            </div>
          </div>
          <div class="context-separator" />
          <button class="context-item" @click="locateInBrowser">Locate in browser</button>
          <button class="context-item" @click="startTitleRename">Rename</button>
          <button class="settings-delete" @click="deleteNote(props.path)">Delete Note</button>
          <div class="note-times">
            <div><span>Created</span>{{ formatTime(noteTimes?.created) }}</div>
            <div><span>Last saved</span>{{ formatTime(noteTimes?.modified) }}</div>
          </div>
        </div>
      </div>
      <div v-if="note" class="header-history">
        <button class="icon-button" title="Undo (Ctrl+Z)" aria-label="Undo" :disabled="!canUndo" @mousedown.prevent @click="undo">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 14L4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </svg>
        </button>
        <button class="icon-button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" :disabled="!canRedo" @mousedown.prevent @click="redo">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 14l5-5-5-5" />
            <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
          </svg>
        </button>
      </div>
      <input
        v-if="renamingTitle"
        v-title-focus
        v-model="titleDraft"
        class="app-header-title title-input"
        :class="{ invalid: titleError }"
        :title="titleError ?? undefined"
        type="text"
        spellcheck="false"
        @input="titleError = null"
        @keydown.enter.prevent="commitTitleRename(true)"
        @keydown.esc.prevent="renamingTitle = false"
        @blur="commitTitleRename(false)"
      />
      <span
        v-else
        class="app-header-title"
        :class="{ draggable: props.path }"
        :draggable="!!props.path"
        @dragstart="onHeaderDragStart"
      >{{ headerLabel }}</span>
      <!-- Off-screen; only ever used as the drag image set in onHeaderDragStart,
           since the plain header title (opacity 0.6, no background) makes a weak
           default drag ghost. -->
      <span ref="dragGhostRef" class="drag-ghost" aria-hidden="true">{{ headerLabel }}</span>
      <div class="header-right">
        <div class="header-history">
          <button class="icon-button" title="Back" aria-label="Back" :disabled="!canBack" @click="emit('back')">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <button class="icon-button" title="Forward" aria-label="Forward" :disabled="!canForward" @click="emit('forward')">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </div>
        <div v-if="note || isImage || isPdf" class="header-actions">
          <button class="icon-button" @click="emit('close')">✕</button>
        </div>
        <template v-if="rightPanelButton">
          <span class="header-break" />
          <RightPanelToggle />
        </template>
      </div>
    </header>
    <main
      ref="editorRef"
      class="editor scroll-area"
      :class="{ 'is-image': isImage || isPdf }"
      @dragover.prevent="onBlocksDragOver"
      @drop.prevent="onBlocksDrop"
      @scroll.passive="onEditorScroll"
      @mousedown="onEditorMouseDown"
    >
      <div
        v-if="dragMode === 'float' && floatZoneRect"
        class="float-drop-zone"
        :style="{
          left: floatZoneRect.left + 'px',
          top: floatZoneRect.top + 'px',
          width: floatZoneRect.width + 'px',
          height: floatZoneRect.height + 'px',
        }"
      />
      <div
        ref="noteRef"
        class="note"
        :class="[`width-${noteWidth}`, `position-${notePosition}`, { 'is-image': isImage || isPdf }]"
        :style="{ '--note-font-scale': fontSize / 100 }"
      >
        <template v-if="note">
          <h1 v-if="showTitle" class="note-title">{{ currentTitle }}</h1>
          <div ref="blocksContainerRef" class="blocks-container" :class="{ dragging: draggedBlockId, 'ctrl-mode': ctrlHeld }">
            <template v-for="(row, rowIndex) in note.blocks" :key="row[0]!.id">
              <div
                class="block-gap"
                :class="{ active: (draggedBlockId && dragMode === 'vertical' && hoveredGapIndex === rowIndex) || floatHookGap === rowIndex }"
              />
              <div
                class="block-row"
                :class="{
                  'drop-left':
                    draggedBlockId && dragMode === 'horizontal' && hoveredRowIndex === rowIndex && dragSide === 'left',
                  'drop-right':
                    draggedBlockId && dragMode === 'horizontal' && hoveredRowIndex === rowIndex && dragSide === 'right',
                }"
              >
                <div
                  v-for="block in row"
                  :key="block.id"
                  class="block"
                  :data-block-id="block.id"
                  :class="{
                    selected: selectedBlockIds.includes(block.id),
                  }"
                  :style="blockStyle(block)"
                  :draggable="ctrlHeld"
                  @dragstart="ctrlHeld && onGripDragStart($event, block)"
                  @dragend="onDragEnd"
                  @click="onBlockClick($event, block)"
                  @contextmenu="onBlockContextMenu($event, block)"
                >
                  <div
                    class="block-indicator"
                    draggable="true"
                    @dragstart="onGripDragStart($event, block)"
                    @dragend="onDragEnd"
                  >
                    <span class="indicator-line" />
                    <span class="indicator-grip" />
                    <span class="indicator-line" />
                  </div>
                  <textarea
                    v-if="editingBlockId === block.id"
                    :ref="(el) => setTextareaRef(block.id, el as Element | null)"
                    :value="block.content"
                    class="block-input"
                    @blur="stopEditing(block)"
                    @paste="onBlockPaste($event, block)"
                    @input="onBlockInput(block, $event)"
                    @click="updateSuggest(block, $event.target as HTMLTextAreaElement, false)"
                    @keydown="onBlockKeydown($event, block)"
                    @keyup="onBlockKeyup($event, block)"
                  />
                  <TableBlock
                    v-else-if="isTableBlock(block)"
                    :model-value="block.content"
                    :align="block.align"
                    :note-path="path"
                    @menu="(event, row, col) => emit('table-menu', event, block, menuContext(), row, col)"
                    @update:model-value="block.content = $event"
                  />
                  <div
                    v-else
                    v-html="renderBlock(block.content, path)"
                    @change="handleWidgetEvent($event, path)"
                  />
                </div>
              </div>
            </template>
            <div
              class="block-gap"
              :class="{ active: (draggedBlockId && dragMode === 'vertical' && hoveredGapIndex === note.blocks.length) || floatHookGap === note.blocks.length }"
            />
            <!-- Unhooked blocks, placed freely: x from the middle of the note, y from its top. -->
            <div v-if="note.floating?.length" class="floating-layer">
              <div
                v-for="block in note.floating"
                :key="block.id"
                class="block floating"
                :data-block-id="block.id"
                :class="{ selected: selectedBlockIds.includes(block.id) }"
                :style="{
                  ...blockStyle(block),
                  left: `calc(50% + ${block.x}px)`,
                  top: block.y + 'px',
                  width: block.width + 'px',
                  zIndex: block.z,
                }"
                @mousedown="onFloatingMouseDown($event, block)"
                @click="onBlockClick($event, block)"
                @contextmenu="onBlockContextMenu($event, block)"
              >
                <div class="floating-grip" @mousedown.prevent.stop="startFloatingDrag($event, block)" />
                <div class="floating-resize" @mousedown.prevent.stop="startFloatingResize($event, block)" />
                <textarea
                  v-if="editingBlockId === block.id"
                  :ref="(el) => setTextareaRef(block.id, el as Element | null)"
                  :value="block.content"
                  class="block-input"
                  @blur="stopEditing(block)"
                  @paste="onBlockPaste($event, block)"
                  @input="onBlockInput(block, $event)"
                  @click="updateSuggest(block, $event.target as HTMLTextAreaElement, false)"
                  @keydown="onBlockKeydown($event, block)"
                  @keyup="onBlockKeyup($event, block)"
                />
                <TableBlock
                  v-else-if="isTableBlock(block)"
                  :model-value="block.content"
                  :align="block.align"
                  :note-path="path"
                  @menu="(event, row, col) => emit('table-menu', event, block, menuContext(), row, col)"
                  @update:model-value="block.content = $event"
                />
                <div
                  v-else
                  v-html="renderBlock(block.content, path)"
                  @change="handleWidgetEvent($event, path)"
                />
              </div>
            </div>
          </div>
          <div class="note-blank-area" @click="appendBlock" @contextmenu.prevent.stop="onBlankContextMenu" />
        </template>
        <div
          v-else-if="isImage"
          class="image-preview"
          @wheel.prevent="onImageWheel"
          @pointerdown="onImagePointerDown"
          @pointermove="onImagePointerMove"
          @dblclick="resetImageView"
        >
          <img
            :src="imageUrl"
            :alt="headerLabel"
            draggable="false"
            @load="imageSize = { w: ($event.target as HTMLImageElement).naturalWidth, h: ($event.target as HTMLImageElement).naturalHeight }"
            :style="{ transform: `translate(${imagePan.x}px, ${imagePan.y}px) scale(${imageZoom})` }"
          />
        </div>
        <iframe v-else-if="isPdf" :key="props.path ?? ''" class="pdf-preview" :src="imageUrl" :title="headerLabel" />
        <div v-else-if="loading" class="empty-state">
          <div class="spinner" />
        </div>
        <div v-else class="empty-state">
          <button class="new-note-button" @click="createNewNote()">+ New Note</button>
        </div>
      </div>
    </main>
    <div
      v-if="marquee"
      class="marquee"
      :style="{ left: marquee.x + 'px', top: marquee.y + 'px', width: marquee.w + 'px', height: marquee.h + 'px' }"
    />
    <LinkSuggest
      v-if="suggest && suggestResults.length"
      :items="suggestResults"
      :selected="suggestSelected"
      :position="{ left: suggest.left, top: suggest.top, bottom: suggest.bottom }"
      @hover="suggestSelected = $event"
      @pick="acceptSuggestion"
    />
    <footer v-if="note" class="note-footer">
      <span>{{ wordCount }} {{ wordCount === 1 ? 'word' : 'words' }}</span>
      <span class="save-status" :class="saveState">{{ SAVE_LABELS[saveState] }}</span>
    </footer>
    <footer v-else-if="isImage && imageSize" class="note-footer">
      <span>{{ imageSize.w }} × {{ imageSize.h }}</span>
    </footer>
  </div>
</template>

<style scoped>
.settings-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: var(--color-text);
  cursor: pointer;
}

.checkbox {
  appearance: none;
  flex-shrink: 0;
  width: 0.9rem;
  height: 0.9rem;
  border: 1px solid var(--color-border-hover);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  position: relative;
}

.checkbox:hover {
  border-color: var(--color-accent);
}

.checkbox:checked {
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.content-column {
  position: relative; /* the footer floats over its bottom-right corner */
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-header {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  min-height: var(--bar-height);
  font-size: 0.75rem;
  color: var(--color-text);
  background: var(--color-background-mute);
  padding: 0.4rem 0.75rem;
}

.app-header-title {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  opacity: 0.6;
}

.app-header-title.draggable {
  cursor: grab;
}

.drag-ghost {
  position: fixed;
  top: -1000px;
  left: -1000px;
  padding: 0.35rem 0.7rem;
  font-size: 0.85rem;
  color: var(--color-text-strong);
  background: var(--color-background-mute);
  border: 1px solid var(--color-accent);
  border-radius: 5px;
  white-space: nowrap;
}

.note-menu .settings-row {
  margin-bottom: 0.5rem;
}

.note-menu .settings-group {
  margin-bottom: 0.4rem;
}

.note-menu .settings-delete {
  margin-top: 0.4rem;
}

.font-size-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.font-size-slider {
  flex: 1;
  min-width: 0;
  accent-color: var(--color-accent);
}

.font-size-value {
  font-size: 0.75rem;
  color: var(--color-text);
  opacity: 0.8;
  width: 2.6rem;
  text-align: right;
}

.font-size-row .icon-button:disabled {
  opacity: 0.35;
  cursor: default;
}

/* The header's title turned into the rename box. */
.title-input {
  width: 14rem;
  max-width: 40%;
  padding: 0.1rem 0.4rem;
  font: inherit;
  text-align: center;
  color: var(--color-text-strong);
  background: rgb(var(--tint) / 0.08);
  border: 1px solid var(--color-accent);
  border-radius: 3px;
  outline: none;
  opacity: 1;
}

.title-input.invalid {
  border-color: #e08080;
}

/* Below a break under Delete Note. */
.note-times {
  margin-top: 0.75rem;
  padding-top: 0.6rem;
  border-top: 1px solid rgb(var(--tint) / 0.08);
  font-size: 0.7rem;
  color: var(--color-text);
}

.note-times div {
  display: flex;
  flex-direction: column;
  margin-top: 0.3rem;
}

.note-times span {
  opacity: 0.55;
}

.header-history {
  display: flex;
}

.header-right {
  display: flex;
  margin-left: auto;
}

/* A thin line between groups of header buttons. */
.header-break {
  align-self: center;
  width: 1px;
  height: 1.1rem;
  margin: 0 0.35rem;
  background: var(--color-border-hover);
}

.app-header .icon-button {
  font-size: 0.95rem;
}

/* Hangs from the header's top-left corner, as if the header itself opened up:
   flush against it, square except for the bottom-right corner. */
.note-menu {
  position: absolute;
  top: 100%;
  left: 0;
  width: 220px;
  background: var(--color-background-mute);
  border: 1px solid rgb(var(--tint) / 0.08);
  border-top: none;
  border-left: none;
  border-radius: 0 0 6px 0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  padding: 0.6rem 0.75rem;
  z-index: 10;
}

/* Bottom-right corner, only as wide as its contents; the save status is last. */
.note-footer {
  position: absolute;
  right: 0;
  bottom: 0;
  display: flex;
  gap: 1rem;
  padding: 0.2rem 0.75rem;
  font-size: 0.7rem;
  color: var(--color-text);
  background: var(--color-background-mute);
  border-top-left-radius: 6px;
  pointer-events: none;
}

.note-footer span {
  opacity: 0.7;
}

.note-footer .save-status.error {
  color: #e08080;
  opacity: 1;
}

.editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable both-edges; /* room for the scrollbar is always kept, so it appearing doesn't shift the note */
  padding: 2rem 1rem;
}

/* Less room around the note on a small screen. */
@media (max-width: 700px) {
  .editor {
    padding: 1.25rem 0.5rem;
  }
}

/* An image has no note padding to match, so the editor's own padding just cuts
   it off short of the pane's edge; let it fill the pane instead. */
.editor.is-image {
  padding: 0;
}

.note {
  position: relative; /* the floating blocks are placed against it */
  display: flex;
  flex-direction: column;
  flex: 1;
  max-width: 720px; /* small */
  width: 100%;
  margin: 0 auto;
  font-size: calc(1.1em * var(--note-font-scale, 1));
  color: var(--color-text-strong);
}

.note.width-medium {
  max-width: 1000px;
}

/* Position hooks the column to a side of the pane instead of centering it. */
.note.position-left {
  margin-left: 0;
  margin-right: auto;
}

.note.position-right {
  margin-left: auto;
  margin-right: 0;
}

/* Large fills the pane, leaving only the editor's own side padding as margin. */
.note.width-large {
  max-width: none;
}

/* An image ignores the width setting (there's no note to carry one): it just
   fills the pane and centers whatever doesn't need the full space. */
.note.is-image {
  max-width: none;
  margin: 0 auto;
}

.image-preview {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  overflow: hidden;
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.pdf-preview {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: none;
}

/* While a note is being dragged over the pane the drop overlay should get the
   pointer, not the frame's own document. */
.pdf-preview {
  pointer-events: v-bind("draggedNotePath ? 'none' : 'auto'");
}

.image-preview img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.spinner {
  width: 2rem;
  height: 2rem;
  border: 3px solid rgb(var(--tint) / 0.15);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.new-note-button {
  font: inherit;
  font-size: 0.95rem;
  color: var(--color-on-accent);
  background: var(--color-accent);
  border: none;
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  cursor: pointer;
  transition: background 0.15s;
}

.new-note-button:hover {
  background: var(--color-accent-hover);
}

.note-blank-area {
  flex: 1;
  min-height: 200px;
  cursor: text;
}

.block-gap {
  height: 6px;
  margin: -3px 0;
  border-radius: 3px;
}

.block-gap.active {
  background: var(--color-accent);
}

.block-row {
  position: relative;
  display: flex;
  gap: 1rem;
}

.block-row .block {
  flex: 1;
  min-width: 0;
}

.block-row.drop-left::before,
.block-row.drop-right::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 4px;
  border-radius: 2px;
  background: var(--color-accent);
}

.block-row.drop-left::before {
  left: -0.6rem;
}

.block-row.drop-right::after {
  right: -0.6rem;
}

/* The margin strip outside the note, highlighted while a dragged block hovers far
   enough past the edge to unhook instead of forming a column. */
.float-drop-zone {
  position: fixed;
  background: color-mix(in srgb, var(--color-accent) 22%, transparent);
  border: 2px solid var(--color-accent);
  pointer-events: none;
  z-index: 30;
}

/* A zero-height strip across the top of the note; each floating block is positioned
   inside it (so the editor scrolls to reach one placed below the text). */
.floating-layer {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 0;
}

.block.floating {
  position: absolute;
  margin: 0;
  padding: 0.4rem 0.6rem;
  background: var(--color-background-soft);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
}

/* A small tab on top of a floating block to drag it by, and a strip along its right edge
   to resize it. In Ctrl mode the whole block is the handle instead. */
.floating-grip {
  position: absolute;
  top: -11px;
  left: 50%;
  width: 36px;
  height: 10px;
  margin-left: -18px;
  border-radius: 5px 5px 0 0;
  background: var(--color-border-hover);
  cursor: grab;
  opacity: 0;
  transition: opacity 0.15s;
}

.block.floating:hover .floating-grip {
  opacity: 0.7;
}

.floating-grip:hover {
  opacity: 1;
}

.blocks-container.ctrl-mode .floating-grip {
  display: none;
}

.floating-resize {
  position: absolute;
  top: 0;
  right: -4px;
  bottom: 0;
  width: 8px;
  cursor: ew-resize;
}

.note-title {
  margin-bottom: 1.5rem;
  padding-left: 1rem;
  color: var(--color-heading);
}

.block {
  position: relative;
  min-height: 1.6em;
  margin-bottom: 0.75rem;
  padding: 0.2rem 0.5rem 0.2rem 1rem;
  border-radius: 4px;
  outline: 1px solid transparent;
  transition: outline-color 0.1s;
}

/* Holding Ctrl (not editing): every block gets a thin green border, and the whole
   block is its own drag handle. */
.blocks-container.ctrl-mode .block {
  outline-color: var(--color-accent);
}

.blocks-container.ctrl-mode .block {
  cursor: grab;
}

.marquee {
  position: fixed;
  z-index: 50;
  pointer-events: none;
  border: 1px solid var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 15%, transparent);
}

/* Blocks picked with Ctrl+click: bold outline and a light tint (an inset shadow,
   so the block's own background color still shows). */
.blocks-container .block.selected {
  outline: 3px solid var(--color-accent);
  box-shadow: inset 0 0 0 999px color-mix(in srgb, var(--color-accent) 12%, transparent);
}

/* Let the block itself receive the mouse, so a drag can start anywhere on it. */
.blocks-container.ctrl-mode .block :deep(*) {
  pointer-events: none;
}

.block-indicator {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -0.8rem;
  width: 0.7rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  opacity: 0;
  cursor: grab;
  transition: opacity 0.15s;
}

.block:hover .block-indicator,
.blocks-container.dragging .block-indicator {
  opacity: 0.45;
}

.block-indicator:hover {
  opacity: 1;
}

.indicator-line {
  flex: 1;
  width: 2px;
  background: var(--color-border-hover);
  border-radius: 1px;
}

.indicator-grip {
  position: relative;
  flex-shrink: 0;
  width: 6px;
  height: 14px;
}

.indicator-grip::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  width: 2px;
  height: 2px;
  margin-top: -1px;
  border-radius: 50%;
  background: var(--color-text-strong);
  box-shadow:
    0 -5px 0 var(--color-text-strong),
    0 5px 0 var(--color-text-strong),
    4px -5px 0 var(--color-text-strong),
    4px 0 0 var(--color-text-strong),
    4px 5px 0 var(--color-text-strong);
}

.block-input {
  display: block;
  width: 100%;
  font: inherit;
  line-height: inherit;
  color: inherit;
  text-align: inherit;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  padding: 0;
  field-sizing: content;
}

.block :deep(> *:first-child) {
  margin-top: 0;
}

.block :deep(> *:last-child) {
  margin-bottom: 0;
}

.block :deep(blockquote) {
  margin: 0;
  padding-left: 0.75rem;
  border-left: 3px solid var(--color-border-hover);
  color: var(--color-text-strong);
  opacity: 0.8;
  font-style: italic;
}

.block :deep(strong) {
  font-weight: 700;
}

.block :deep(h1),
.block :deep(h2),
.block :deep(h3) {
  font-weight: 700;
}

/* A fenced code block: its own scroll area so a long line doesn't widen the note,
   and inline code gets just enough of the same look to read as code. */
.block :deep(pre) {
  margin: 0;
  padding: 0.6rem 0.75rem;
  overflow-x: auto;
  background: rgb(var(--tint) / 0.05);
  border: 1px solid var(--color-border-hover);
  border-radius: 6px;
}

.block :deep(pre code) {
  padding: 0;
  background: none;
  border-radius: 0;
  white-space: pre;
}

.block :deep(code) {
  padding: 0.1rem 0.3rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85em;
  background: rgb(var(--tint) / 0.08);
  border-radius: 4px;
}

/* Rendered markdown tables. The editable grid (.table-block) styles itself. */
.block :deep(table:not(.table-block)) {
  border-collapse: collapse;
}

.block :deep(table:not(.table-block) th),
.block :deep(table:not(.table-block) td) {
  padding: 0.3rem 0.75rem;
  border: 1px solid var(--color-border-hover);
  text-align: left;
}

.block :deep(table:not(.table-block) th) {
  font-weight: 700;
  background: rgb(var(--tint) / 0.05);
}

.block :deep(hr) {
  margin: 1rem 0;
  border: none;
  border-top: 1px solid var(--color-border);
}

.block :deep(a) {
  color: var(--color-accent);
  text-decoration: underline;
}

.block :deep(.note-link) {
  color: var(--color-accent);
  text-decoration: none;
}

/* The value of a {{variable}}. One that doesn't exist is faded like a missing link. */
.block :deep(.variable-widget) {
  padding: 0 0.3em;
  background: color-mix(in srgb, var(--color-accent) 15%, transparent);
  border-radius: 3px;
}

/* The input widget: the same box as a variable's value, but inline. */
.block :deep(.widget-input) {
  font: inherit;
  color: inherit;
  padding: 0 0.3em;
  background: rgb(var(--tint) / 0.06);
  border: 1px solid var(--color-border-hover);
  border-radius: 3px;
  outline: none;
  appearance: textfield;
}

.block :deep(.widget-input:focus) {
  border-color: var(--color-accent);
}

.block :deep(.widget-bool) {
  cursor: pointer;
}

.block :deep(.widget-input::-webkit-inner-spin-button),
.block :deep(.widget-input::-webkit-outer-spin-button) {
  appearance: none;
}

.block :deep(.variable-widget.missing) {
  opacity: 0.55;
}

/* A link to something that doesn't exist yet is faded until hovered. */
.block :deep(.note-link.missing) {
  opacity: 0.55;
  transition: opacity 0.15s;
}

.block :deep(.note-link.missing:hover) {
  opacity: 1;
}

/* The user agent's default list indent (around 40px) is too wide here, and it
   stacks with every level of nesting; trim it down for all lists and levels. A
   checklist item's checkbox then takes the bullet's place instead of sitting next
   to one, so its own list also drops the bullet (list-style: none, below). */
.block :deep(ul),
.block :deep(ol) {
  padding-left: 0.9em;
}

.block :deep(li.checklist-item) {
  list-style: none;
}

.block :deep(.block-checkbox) {
  appearance: none;
  width: 0.9rem;
  height: 0.9rem;
  margin: 0 0.4rem 0 0;
  vertical-align: -1px;
  border: 1px solid var(--color-border-hover);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
}

.block :deep(.block-checkbox:hover) {
  border-color: var(--color-accent);
}

.block :deep(.block-checkbox:checked) {
  background: var(--color-accent);
  border-color: var(--color-accent);
}

/* The checkbox widget is its own little box rather than a real checkbox, sized in em
   so it grows with the text around it: bigger in a heading than in a paragraph. */
.block :deep(.widget-counter) {
  display: inline-flex;
  align-items: stretch;
  vertical-align: baseline;
  border: 1px solid var(--color-border-hover);
  border-radius: 0.3em;
  overflow: hidden;
  user-select: none;
}

.block :deep(.counter-value) {
  padding: 0 0.45em;
  border-left: 1px solid var(--color-border-hover);
  border-right: 1px solid var(--color-border-hover);
}

.block :deep(.counter-button) {
  position: relative;
  width: 1.4em;
  cursor: pointer;
}

/* The - is one bar and the + is two, centered in the button. */
.block :deep(.counter-button::before),
.block :deep(.counter-button::after) {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  background: currentColor;
  transform: translate(-50%, -50%);
}

.block :deep(.counter-button::before) {
  width: 0.55em;
  height: max(1.5px, 0.1em);
}

.block :deep(.counter-button::after) {
  width: max(1.5px, 0.1em);
  height: 0.55em;
}

.block :deep(.counter-button[data-action='minus']::after) {
  display: none;
}

.block :deep(.counter-button:hover) {
  color: var(--color-accent);
  background: rgb(var(--tint) / 0.08);
}

.block :deep(.widget-slider) {
  width: 8em;
  vertical-align: middle;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.block :deep(.widget-checkboxes) {
  white-space: nowrap;
}

.block :deep(.widget-checkbox) {
  display: inline-block;
  box-sizing: border-box;
  width: 0.9em;
  height: 0.9em;
  margin: 0 0.15em;
  vertical-align: -0.1em;
  border: 1px solid var(--color-border-hover);
  border-radius: 0.2em;
  cursor: pointer;
}

.block :deep(.widget-checkbox:hover) {
  border-color: var(--color-accent);
}

.block :deep(.widget-checkbox.checked) {
  background: var(--color-accent);
  border-color: var(--color-accent);
}
</style>
