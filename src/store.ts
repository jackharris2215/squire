import { computed, nextTick, reactive, ref, watch } from 'vue'
import { SERVER_URL, lastSaved, serverWrite, whenWritesDone } from './api'
import { askConfirm } from './dialog'
import { settingsOpen } from './overlay'
import { closeDrawer, isMobile, toggleDrawer } from './mobile'
import { randomUUID } from './uuid'
import {
  breakUndoGroup,
  clearHistories,
  dropHistory,
  initHistory,
  recordChange,
  redo,
  remapHistories,
  undo,
} from './history'
import {
  closePanesShowing,
  focusedPane,
  openPaths,
  remapLayoutPaths,
  restoreLayout,
  stepPane,
  serializeLayout,
  showInFocusedPane,
  showInPane,
  splitPane,
  type Side,
} from './layout'
import {
  DEFAULT_ATTACHMENTS_FOLDER,
  DEFAULT_AUTOSAVE_MS,
  DEFAULT_DAILY_FOLDER,
  DEFAULT_DAILY_FORMAT,
  DEFAULT_WEEKLY_FOLDER,
  DEFAULT_WEEKLY_FORMAT,
  NAME_RE,
  folderOrDefault,
  formatDate,
} from './notebookSettings'
import type { Block, BookmarkFolder, BookmarkItem, Config, FloatingBlock, Note, Variable } from './types'

// Shared state for the notebook: what's on the server, what's loaded, and which
// note is open. Everything else (the sidebar, the editor) reads and changes it.

export const files = ref<string[]>([])
export const folders = ref<string[]>([])
export const collapsedFolders = ref(new Set<string>())
// title is the filename's stem (a note has no separate "title" field; the filename
// is the name) and is kept in sync by every place that creates, renames, or moves a
// note. Built from file paths alone (buildNoteIndex, below) — nothing here needs a
// note's content loaded, so the list is ready before any note is actually fetched.
// Whether one is bookmarked is tracked separately, in config.bookmarkOrder (see
// isBookmarked), for the same reason.
export const noteList = ref<{ title: string; path: string }[]>([])
// Title -> path, for resolving [[links]]. Names are unique across the whole notebook
// (enforced on create and rename), so this is never ambiguous.
export const noteIndex = ref<Record<string, string>>({})

// A note's name: its filename, without the folder or the extension.
export function nameFromPath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
}

// A path's filename, folder stripped but extension kept.
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

export function isImagePath(path: string): boolean {
  return IMAGE_EXT_RE.test(path)
}

export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path)
}

// Every PDF in the notebook, for the sidebar. Like an image, a PDF only ever shows in
// a pane (the browser draws it from the server's file) and has no note content.
export const pdfList = computed(() => files.value.filter(isPdfPath))

// A script is a Python file in the notebook (see the Scripts section below). Like a PDF it is
// listed in the sidebar but is never a note: no note list, links or search.
export function isScriptPath(path: string): boolean {
  return /\.py$/i.test(path)
}

export const scriptList = computed(() => files.value.filter(isScriptPath))

// Name (without ".py"), filename, or full path -> path, for resolving the {{run}} widget
// (markdown.ts). Scripts don't enforce unique names the way notes do, so like imageIndex,
// if two share a name the first one wins for it; the full path always works.
export const scriptIndex = computed(() => {
  const index: Record<string, string> = {}
  for (const path of scriptList.value) {
    index[path] = path
    index[baseName(path)] ??= path
    index[nameFromPath(path)] ??= path
  }
  return index
})

// Every image in the notebook, for the sidebar. Unlike notes, an image's content
// never loads into the client; it's just a path the server can serve, so this
// comes straight from `files` rather than the note-detecting pass in
// buildNoteIndex().
export const imageList = computed(() => files.value.filter(isImagePath))
// Filename (or full path) -> path, for resolving [[img.jpg]] links. If two images
// share a filename the first one wins for the bare name; the full path always works.
// PDFs are linked the same way (by filename), so they're in here too.
export const imageIndex = computed(() => {
  const index: Record<string, string> = {}
  for (const path of [...imageList.value, ...pdfList.value]) {
    index[path] = path
    index[baseName(path)] ??= path
  }
  return index
})

// What a link to this image should say: its filename, or its full path when
// another image has the same filename.
export function imageLinkText(path: string): string {
  const name = baseName(path)
  return imageIndex.value[name] === path ? name : path
}

// What a link to this script (or its {{run}} widget) should say: its filename, or
// its full path when another script has the same filename.
export function scriptLinkText(path: string): string {
  const name = baseName(path)
  return scriptIndex.value[name] === path ? name : path
}

// What a {{run}} button inserted for this script should show as its label: its
// name, special characters (underscores, dashes, etc.) turned into spaces, title-cased.
export function scriptButtonLabel(path: string): string {
  return nameFromPath(path)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}
// Every note loaded so far, by path. Switching to a cached note is instant.
// Reactive, so a pane showing a note by its path updates when the note loads or
// changes; the open note is the same object as its cache entry, so edits stay in sync.
export const noteCache = reactive(new Map<string, Note>())

// The note in the focused pane: what the sidebar highlights and Ctrl+P replaces.
export const selectedFile = computed(() => focusedPane.value.path)
// Notes being fetched because they weren't in the cache yet.
const loadingPaths = reactive(new Set<string>())

export function isLoadingPath(path: string | null) {
  return !!path && loadingPaths.has(path)
}

// What the config is before anything has been loaded or changed.
export function defaultConfig(): Config {
  return {
    sidebarWidth: 260,
    sidebarCollapsed: false,
    lastOpenNote: null,
    bottomPanelHeightPercent: 30,
    bottomPanelCollapsed: false,
    sidebarTab: 'files',
    bottomTab: 'notebook',
    rightPanelWidth: 260,
    rightPanelCollapsed: false,
  }
}

export const config = ref<Config>(defaultConfig())

export function normalizeNote(data: { metadata?: Record<string, unknown>; blocks?: unknown[]; floating?: unknown }): Note {
  const rawBlocks = data.blocks ?? []
  const isFlat = rawBlocks.length > 0 && !Array.isArray(rawBlocks[0])
  const blocks = isFlat ? (rawBlocks as Block[]).map((b) => [b]) : (rawBlocks as Block[][])
  const note: Note = { metadata: data.metadata ?? {}, blocks }
  if (Array.isArray(data.floating) && data.floating.length) note.floating = data.floating as FloatingBlock[]
  return note
}

// --- Loading ---

// Fetches the file and folder lists. Also used to catch up with changes made elsewhere,
// which must not collapse the tree again (loadFiles does that, once).
async function refreshFiles() {
  const [filesRes, foldersRes] = await Promise.all([
    fetch(`${SERVER_URL}/files`),
    fetch(`${SERVER_URL}/folders`),
  ])
  files.value = await filesRes.json()
  // Folders are optional: if this fails, notes still load.
  folders.value = foldersRes.ok ? await foldersRes.json() : []
  buildNoteIndex()
}

export async function loadFiles() {
  await refreshFiles()

  // The tree starts fully collapsed. Collapse state isn't saved anywhere, so this
  // only ever runs once, right after the first load.
  collapsedFolders.value = allFolderPaths()
}

// Every folder: the empty ones (folders.value, from the server), plus those that
// only exist as part of a note's or image's path.
export function allFolderPaths(): Set<string> {
  const paths = new Set(folders.value)
  for (const path of [...noteList.value.map((n) => n.path), ...imageList.value, ...pdfList.value, ...scriptList.value]) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) paths.add(parts.slice(0, i).join('/'))
  }
  return paths
}

// Every non-image file in the notebook is a note (the only other kind of file this app
// creates), identified by its path alone — no content fetched, so this is instant
// regardless of how many notes there are or how big they are.
function buildNoteIndex() {
  const index: Record<string, string> = {}
  const list: { title: string; path: string }[] = []
  for (const path of files.value) {
    if (isImagePath(path) || isPdfPath(path) || isScriptPath(path)) continue
    const title = nameFromPath(path)
    index[title] = path
    list.push({ title, path })
  }
  noteIndex.value = index
  noteList.value = list
}

export async function loadConfig() {
  const res = await fetch(`${SERVER_URL}/config`)
  // sidebarWidthPercent is the old, percentage-based width setting; it's dropped.
  const { lastSaved: serverLastSaved, sidebarWidthPercent: _oldWidth, ...settings } = await res.json()
  lastSaved.value = serverLastSaved ?? 0
  config.value = { ...config.value, ...settings }

  // An older config stored bookmarkOrder as plain paths, with no folders; normalize
  // once so the rest of the app can assume today's { kind, ... } shape.
  const order = config.value.bookmarkOrder as unknown
  if (Array.isArray(order) && order.some((item) => typeof item === 'string')) {
    config.value.bookmarkOrder = (order as (string | BookmarkItem)[]).map((item) =>
      typeof item === 'string' ? { kind: 'note', path: item } : item,
    )
  }
}

// --- Saving ---
// Every note that is open somewhere is "tracked": it gets its own autosave timer
// and its own save status. Start with trackNote(path) when a note is shown, and
// release it with untrackNote(path).

type SaveState = 'saved' | 'saving' | 'error'

interface Tracked {
  path: string // re-keyed by remapTracked when the note moves or is renamed
  state: SaveState // for the footer
  editCount: number // so a save finishing can tell whether newer edits wait behind it
  dirty: boolean // edited since the last save was sent
  quiet: boolean // the note is being swapped for the server's copy: that isn't an edit to save
  timer: ReturnType<typeof setTimeout> | undefined
  stop: () => void // ends the watcher on the note
}

const tracked = reactive(new Map<string, Tracked>())

// Whether a note's latest edits are on the server, for its footer.
export function saveStateFor(path: string | null): SaveState {
  return (path && tracked.get(path)?.state) || 'saved'
}

// Starts autosaving a note: any change to it saves it half a second later.
export function trackNote(path: string) {
  const target = noteCache.get(path)
  if (!target || tracked.has(path)) return
  initHistory(path, target)
  tracked.set(path, {
    path,
    state: 'saved',
    editCount: 0,
    dirty: false,
    quiet: false,
    timer: undefined,
    stop: () => {},
  })
  const entry = tracked.get(path)! // the reactive entry
  entry.stop = watch(target, () => onEdited(entry, target), { deep: true })
}

function onEdited(entry: Tracked, target: Note) {
  if (entry.quiet) return
  entry.editCount++
  entry.dirty = true
  entry.state = 'saving'
  recordChange(entry.path, target)
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => saveNoteAt(entry.path), config.value.autosaveDelayMs ?? DEFAULT_AUTOSAVE_MS)
}

// Stops autosaving a note that is no longer open. Anything unsaved is sent first,
// unless `flush` is false (the note is being deleted).
export function untrackNote(path: string, flush = true) {
  const entry = tracked.get(path)
  if (!entry) return
  clearTimeout(entry.timer)
  if (flush && entry.dirty) saveNoteAt(path)
  entry.stop()
  tracked.delete(path)
}

function saveNoteAt(path: string): Promise<unknown> {
  const entry = tracked.get(path)
  const target = noteCache.get(path)
  if (!entry || !target) return whenWritesDone()
  clearTimeout(entry.timer)
  entry.dirty = false
  const editsAtStart = entry.editCount
  const body = JSON.stringify(target, null, 2)
  const failed = () => {
    entry.state = 'error'
    entry.dirty = true
  }
  return serverWrite(`/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body })
    .then(({ ok }) => {
      if (!ok) failed()
      else if (editsAtStart === entry.editCount) entry.state = 'saved'
    })
    .catch(failed)
}

// Sends every unsaved note now, and resolves once the server has taken them.
export function saveAllNotes(): Promise<unknown> {
  const saves = [
    ...[...tracked.values()].filter((e) => e.dirty).map((e) => saveNoteAt(e.path)),
    ...[...scriptCache].filter(([, script]) => script.dirty).map(([path]) => saveScript(path)),
  ]
  return Promise.all(saves).then(() => whenWritesDone())
}

// Drops a note's unsaved edits (used before deleting it, so a late save can't
// bring it back).
function discardPendingSave(path: string) {
  const script = scriptCache.get(path)
  if (script) {
    clearTimeout(scriptTimers.get(path))
    script.dirty = false
  }
  const entry = tracked.get(path)
  if (!entry) return
  clearTimeout(entry.timer)
  entry.dirty = false
}

function remapTracked(remap: (path: string) => string) {
  const entries = [...tracked.values()]
  tracked.clear()
  for (const entry of entries) {
    entry.path = remap(entry.path)
    tracked.set(entry.path, entry)
  }
}

// --- Scripts ---
// A script is a Python file in the notebook that the server can run (POST /run); it uses the
// `squire` library to read and change notes. It is plain text, so it lives here rather than in
// noteCache: scriptCache holds the text of the scripts opened so far, saved a moment after each
// edit like a note, and scriptRuns the last output of each script's run.

export interface ScriptState {
  text: string
  dirty: boolean // edited since the last save was sent
  state: 'saved' | 'saving' | 'error'
}

export interface ScriptRun {
  running: boolean
  output: string
  exitCode: number | null // null while running or when it was stopped for taking too long
  timedOut: boolean
  error: string | null // the run could not be started (or the script not saved)
}

// A script's schedule, stored alongside its code (server/server.py). "repeat" keeps every
// kind's fields at once (not just the active one), so switching the radio doesn't lose what
// was typed into the others.
export interface ScriptScheduleRepeat {
  kind: 'time' | 'month' | 'year'
  hours: number // kind 'time': run again this many hours...
  minutes: number // ...and minutes after the last run
  monthDay: number // kind 'month': which day of the month (1-31, clamped to the shortest)
  yearMonth: number // kind 'year': which month (1-12)...
  yearDay: number // ...and day (1-31, clamped) to run on every year
}

export interface ScriptSchedule {
  enabled: boolean // the "Next run" checkbox
  nextRun: string | null // "YYYY-MM-DDTHH:MM", local time
  repeatEnabled: boolean
  repeat: ScriptScheduleRepeat
}

export function defaultScriptSchedule(): ScriptSchedule {
  return {
    enabled: false,
    nextRun: null,
    repeatEnabled: false,
    repeat: { kind: 'time', hours: 1, minutes: 0, monthDay: 1, yearMonth: 1, yearDay: 1 },
  }
}

// Fetched only when a script's schedule menu is opened (not with every script load, since
// most scripts never have one).
export async function fetchScriptSchedule(path: string): Promise<{ schedule: ScriptSchedule | null; lastRun: string | null } | null> {
  const res = await fetch(`${SERVER_URL}/script-schedule?path=${encodeURIComponent(path)}`)
  return res.ok ? await res.json() : null
}

export function saveScriptSchedule(path: string, schedule: ScriptSchedule): Promise<unknown> {
  return serverWrite(`/script-schedule?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ schedule }),
  })
}

export const scriptCache = reactive(new Map<string, ScriptState>())
export const scriptRuns = reactive(new Map<string, ScriptRun>())
const scriptTimers = new Map<string, ReturnType<typeof setTimeout>>() // pending autosaves

const SCRIPT_TEMPLATE = `# A Squire script: press Run to run it. What it prints shows below.
import squire

for note in squire.notes():
    print(note["name"])
`

async function fetchScriptText(path: string): Promise<string | null> {
  const res = await fetch(`${SERVER_URL}/script?path=${encodeURIComponent(path)}`)
  return res.ok ? await res.text() : null
}

async function ensureScriptLoaded(path: string) {
  if (scriptCache.has(path) || loadingPaths.has(path)) return
  loadingPaths.add(path)
  try {
    const text = await fetchScriptText(path)
    if (text !== null) scriptCache.set(path, { text, dirty: false, state: 'saved' })
  } finally {
    loadingPaths.delete(path)
  }
}

// Fetches a script shown in a pane again after a change made elsewhere. Unlike a note, unsaved
// typing is kept: it saves over the other change a moment later.
async function refreshScript(path: string) {
  const entry = scriptCache.get(path)
  if (!entry || entry.dirty) return
  const text = await fetchScriptText(path)
  if (text !== null && text !== entry.text) entry.text = text
}

export function editScript(path: string, text: string) {
  const entry = scriptCache.get(path)
  if (!entry || text === entry.text) return
  entry.text = text
  entry.dirty = true
  entry.state = 'saving'
  clearTimeout(scriptTimers.get(path))
  scriptTimers.set(path, setTimeout(() => saveScript(path), config.value.autosaveDelayMs ?? DEFAULT_AUTOSAVE_MS))
}

export function saveScript(path: string): Promise<unknown> {
  const entry = scriptCache.get(path)
  clearTimeout(scriptTimers.get(path))
  if (!entry || !entry.dirty) return whenWritesDone()
  entry.dirty = false
  const sent = entry.text
  const failed = () => {
    entry.state = 'error'
    entry.dirty = true
  }
  return serverWrite(`/script?path=${encodeURIComponent(path)}`, { method: 'PUT', body: sent })
    .then(({ ok }) => {
      if (!ok) failed()
      else if (entry.text === sent) entry.state = 'saved'
    })
    .catch(failed)
}

// Forgets everything held for a script that is gone.
function dropScript(path: string) {
  clearTimeout(scriptTimers.get(path))
  scriptTimers.delete(path)
  scriptCache.delete(path)
  scriptRuns.delete(path)
}

// Saves the script, then has the server run it and keeps what it printed.
export async function runScript(path: string) {
  if (scriptRuns.get(path)?.running) return
  await saveScript(path)
  scriptRuns.set(path, { running: true, output: '', exitCode: null, timedOut: false, error: null })
  const run = scriptRuns.get(path)!
  if (scriptCache.get(path)?.dirty) {
    run.error = 'The script could not be saved, so it was not run.'
    run.running = false
    return
  }
  try {
    const res = await fetch(`${SERVER_URL}/run?path=${encodeURIComponent(path)}`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) run.error = data.error ?? `The server answered ${res.status}.`
    else Object.assign(run, { output: data.output, exitCode: data.exitCode, timedOut: data.timedOut })
  } catch {
    run.error = 'Cannot reach the server.'
  }
  run.running = false
}

// A new script in `folder`, opened for editing.
export async function createScript(folder = '') {
  const prefix = folder ? `${folder}/` : ''
  let name = 'New Script'
  for (let n = 1; files.value.includes(`${prefix}${name}.py`); n++) name = `New Script (${n})`
  const path = `${prefix}${name}.py`
  const { ok } = await serverWrite(`/script?path=${encodeURIComponent(path)}`, { method: 'PUT', body: SCRIPT_TEMPLATE })
  if (!ok) return
  files.value.push(path)
  scriptCache.set(path, { text: SCRIPT_TEMPLATE, dirty: false, state: 'saved' })
  if (folder) collapsedFolders.value.delete(folder) // make sure the new script is visible
  selectFile(path)
}

// A script is imported by scripts in its folder, so one called "squire" would hide the library.
export function validateScriptName(input: string, currentName: string | undefined, path: string): string | null {
  const error = validateImageName(input, currentName, path)
  if (error) return error
  if (input.trim().toLowerCase() === 'squire') return '"squire" is the library scripts import; pick another name.'
  return null
}

// Renames a script through the server's /rename (the extension stays). Nothing links to one by
// name, so unlike an image there are no links to rewrite.
async function renameScript(path: string, newName: string): Promise<string | null> {
  if (newName === nameFromPath(path)) return null
  await saveAllNotes() // anything unsaved goes out under the old path first
  const { ok, data } = await serverWrite(`/rename?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    body: JSON.stringify({ name: newName }),
  })
  if (!ok) return data.error
  remapPaths(path, data.path)
  return null
}

// --- Following changes made elsewhere (the API, another window) ---

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  return keysA.every((key) => sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

// Makes `target` (the note the panes are showing) match `fresh`, in place. A block with the
// same id stays the same object, updated, so the editor keeps its place in the blocks that
// didn't change.
function mergeNote(target: Note, fresh: Note) {
  const existing = new Map<string, Block>()
  for (const block of allBlocks(target)) existing.set(block.id, block)
  const reuse = <T extends Block>(next: T): T => {
    const old = existing.get(next.id) as T | undefined
    if (!old) return next
    for (const key of Object.keys(old)) if (!(key in next)) delete (old as unknown as Record<string, unknown>)[key]
    Object.assign(old, next)
    return old
  }
  target.blocks.splice(0, target.blocks.length, ...fresh.blocks.map((row) => row.map((block) => reuse(block))))
  if (fresh.floating?.length) target.floating = fresh.floating.map((block) => reuse(block))
  else delete target.floating
  for (const key of Object.keys(target.metadata)) if (!(key in fresh.metadata)) delete target.metadata[key]
  Object.assign(target.metadata, fresh.metadata)
}

// Fetches a note shown in a pane again and, if the server's copy is different, swaps it in.
// The server's copy wins: edits not saved yet are dropped, and so is the note's undo history.
async function refreshNote(path: string) {
  const res = await fetch(`${SERVER_URL}/file?path=${encodeURIComponent(path)}`)
  if (!res.ok) return
  const fresh = normalizeNote(await res.json())
  const target = noteCache.get(path)
  if (!target || sameJson(JSON.parse(JSON.stringify(target)), fresh)) return
  const entry = tracked.get(path)
  if (entry) entry.quiet = true // the autosave watcher would take the swap for an edit
  mergeNote(target, fresh)
  await nextTick()
  if (entry) {
    entry.quiet = false
    clearTimeout(entry.timer)
    entry.dirty = false
    entry.state = 'saved'
  }
  dropHistory(path)
  initHistory(path, target)
}

// Catches the client up with a change made elsewhere. `notes` are the notes that changed
// (null: unknown, so look at them all), `tree` whether files or folders came, went or moved.
// Notes shown in a pane are fetched again; other cached ones are dropped and load afresh when
// next opened, so nothing stale is ever written back. Our own changes are recognised by
// lastSaved (every write we make updates it) and skipped.
export async function applyServerChange(change: { lastSaved: number; notes: string[] | null; tree: boolean }) {
  await whenWritesDone()
  if (change.lastSaved <= lastSaved.value) return
  try {
    if (change.tree || change.notes === null) {
      await refreshFiles()
      for (const path of new Set([...openPaths(), ...noteCache.keys()])) {
        if (!files.value.includes(path)) forgetNote(path) // moved, renamed or deleted elsewhere
      }
    }
    const shown = new Set(openPaths())
    for (const path of change.notes ?? [...noteCache.keys()]) {
      if (scriptCache.has(path)) {
        if (shown.has(path)) await refreshScript(path)
        else if (!scriptCache.get(path)!.dirty) dropScript(path) // loads afresh when next opened
        continue
      }
      if (!noteCache.has(path)) continue
      if (shown.has(path)) await refreshNote(path)
      else noteCache.delete(path)
    }
    lastSaved.value = Math.max(lastSaved.value, change.lastSaved)
  } catch {
    // The server couldn't be reached; the next event or check tries again.
  }
}

let configSaveTimeout: ReturnType<typeof setTimeout> | undefined

function saveConfig() {
  const body = JSON.stringify(config.value, null, 2)
  fetch(`${SERVER_URL}/config`, { method: 'PUT', body })
}

// Swaps in a whole new config and saves it at once (not after the usual short delay), for
// import and reset. Returns false if the server refused it.
export async function replaceConfig(next: Config): Promise<boolean> {
  clearTimeout(configSaveTimeout)
  config.value = next
  try {
    const res = await fetch(`${SERVER_URL}/config`, { method: 'PUT', body: JSON.stringify(next, null, 2) })
    return res.ok
  } catch {
    return false
  }
}

export function toggleRightPanel() {
  if (isMobile.value) return toggleDrawer('right') // a drawer on a phone, not the saved setting
  config.value.rightPanelCollapsed = !config.value.rightPanelCollapsed
  queueConfigSave()
}

export function queueConfigSave() {
  clearTimeout(configSaveTimeout)
  configSaveTimeout = setTimeout(saveConfig, 500)
}

// --- Opening and closing notes ---

// Notes shown in a pane are tracked for autosave; ones no longer shown in any pane
// are released (which saves what is unsaved). Runs again when a fetched note
// arrives in the cache.
watch(
  () => [...new Set(openPaths())].filter((path) => noteCache.has(path)),
  (now, before = []) => {
    for (const path of before) if (!now.includes(path)) untrackNote(path)
    for (const path of now) trackNote(path)
  },
  { immediate: true },
)

// The next time the app starts it opens the note that was in focus.
watch(selectedFile, (path) => {
  config.value.lastOpenNote = path
  queueConfigSave()
})

// How many notes the Recent Notes tab remembers.
const RECENT_NOTES_LIMIT = 30

// Every note visited goes to the front of the Recent Notes list (not an image: there's
// nothing to show for one there beyond what the file tree already does).
watch(selectedFile, (path) => {
  if (!path || isImagePath(path) || isPdfPath(path) || isScriptPath(path)) return
  const existing = config.value.recentNotes ?? []
  config.value.recentNotes = [path, ...existing.filter((p) => p !== path)].slice(0, RECENT_NOTES_LIMIT)
  queueConfigSave()
})

// The panes and their notes are saved with the config and come back after a reload.
watch(
  () => JSON.stringify(serializeLayout()),
  (json) => {
    config.value.layout = JSON.parse(json)
    queueConfigSave()
  },
)

// Brings back the saved layout (or, for a config from before split view, the note
// that was open). Call once the file list and config have loaded. Restoring the
// layout itself is just rebuilding the pane tree with the saved paths; each pane's
// own note is then fetched like any other (not awaited here — isLoadingPath drives
// its spinner while that's in flight).
export function restoreOpenNotes() {
  const saved = config.value.layout
  const last = config.value.lastOpenNote
  if (saved) {
    restoreLayout(saved, (path) => files.value.includes(path))
    for (const path of openPaths()) ensureLoaded(path)
  } else if (last && files.value.includes(last)) {
    selectFile(last)
  }
}

// Fetches a note's content the first time it's actually opened — not before, so
// opening the app doesn't mean fetching every note in the notebook. A no-op once it's
// cached, and for an image: its bytes never enter the cache, the img tag fetches
// them directly.
async function ensureLoaded(path: string) {
  if (isScriptPath(path)) return ensureScriptLoaded(path)
  if (isImagePath(path) || isPdfPath(path) || noteCache.has(path) || loadingPaths.has(path)) return
  loadingPaths.add(path)
  try {
    const res = await fetch(`${SERVER_URL}/file?path=${encodeURIComponent(path)}`)
    noteCache.set(path, normalizeNote(await res.json()))
  } finally {
    loadingPaths.delete(path)
  }
}

// Opens a note in the focused pane.
export async function selectFile(path: string) {
  settingsOpen.value = false // opening a note leaves the settings page
  closeDrawer() // and, on a phone, the drawer it was picked from
  showInFocusedPane(path)
  await ensureLoaded(path)
}

// A pane's back and forward buttons.
export async function paneBack(paneId: string) {
  const path = stepPane(paneId, 'back')
  if (path) await ensureLoaded(path)
}

export async function paneForward(paneId: string) {
  const path = stepPane(paneId, 'forward')
  if (path) await ensureLoaded(path)
}

// Opens a note in a specific pane (and focuses it).
export async function openInPane(paneId: string, path: string) {
  settingsOpen.value = false
  closeDrawer()
  showInPane(paneId, path)
  await ensureLoaded(path)
}

// Opens a note in a new pane beside `paneId` (the focused pane by default).
export async function openInSplit(path: string, side: Side, paneId = focusedPane.value.id) {
  settingsOpen.value = false
  closeDrawer()
  splitPane(paneId, side, path)
  await ensureLoaded(path)
}

// --- Notes and folders: create, rename, move, delete ---
// Each change goes to the server first; the local state is only updated once the
// server accepts it.

export function nextNewNoteTitle() {
  const base = 'New Note'
  if (!(base in noteIndex.value)) return base

  let n = 1
  while (`${base} (${n})` in noteIndex.value) n++
  return `${base} (${n})`
}

// Strips characters a note's name can't have (see NAME_RE above) out of a title that
// came from outside the app, like an imported file's name, collapsing whatever's
// left into single spaces.
export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 _()-]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned || 'Untitled'
}

// Picks a name that isn't already taken in `folder`, adding " (1)", " (2)", etc.
// if it is — the same thing a human would do, and cheap since the full file list
// is already cached.
function freeName(name: string, prefix: string): string {
  if (!files.value.includes(`${prefix}${name}.json`)) return name
  let n = 1
  while (files.value.includes(`${prefix}${name} (${n}).json`)) n++
  return `${name} (${n})`
}

// `blocks`/`metadata`/`floating` let a caller (the markdown importer, a template) start the
// note with content already in it; a plain new note leaves it empty, same as before. The
// title is always the new note's own filename, never anything from the template — a note has
// no separate title field to carry over.
export async function createNote(
  title: string,
  folder = '',
  blocks: Block[][] = [],
  metadata: Note['metadata'] = {},
  floating?: Note['floating'],
) {
  const prefix = folder ? `${folder}/` : ''
  const name = freeName(title, prefix)
  const filename = `${prefix}${name}.json`

  const newNote: Note = { metadata: { ...metadata }, blocks }
  if (floating?.length) newNote.floating = floating
  const { ok } = await serverWrite(`/file?path=${encodeURIComponent(filename)}`, {
    method: 'PUT',
    body: JSON.stringify(newNote, null, 2),
  })
  if (!ok) return
  files.value.push(filename)
  noteCache.set(filename, newNote)
  noteList.value.push({ title: name, path: filename })
  noteIndex.value[name] = filename
  if (folder) collapsedFolders.value.delete(folder) // make sure the new note is visible
  selectFile(filename)
}

// A template's content (by title, like a [[link]]), for openDailyNote/openWeeklyNote below.
// null if there's no note by that name (nothing to start from, so a plain blank note).
async function templateContent(title: string): Promise<Pick<Note, 'blocks' | 'metadata' | 'floating'> | null> {
  const path = noteIndex.value[title]
  if (!path) return null
  await ensureLoaded(path)
  const template = noteCache.get(path)
  if (!template) return null
  return JSON.parse(JSON.stringify({ blocks: template.blocks, metadata: template.metadata, floating: template.floating }))
}

// Sets (or adds) a date variable named "Today" in `metadata`, replacing one of any type
// already there by that name — a template's own placeholder "Today", say.
function withTodayVariable(metadata: Note['metadata'], dateIso: string): Note['metadata'] {
  const variables = Array.isArray(metadata.variables) ? [...(metadata.variables as Variable[])] : []
  const today: Variable = { name: 'Today', type: 'date', value: dateIso }
  const existing = variables.findIndex((v) => v.name === 'Today')
  if (existing === -1) variables.push(today)
  else variables[existing] = today
  return { ...metadata, variables }
}

// Opens today's daily note, made first if it doesn't exist (the folder is made along
// with it, by the server). Its folder, name format and template are settings
// (notebookSettings.ts); it always gets a "Today" date variable set to its own date.
export async function openDailyNote() {
  const folder = folderOrDefault(config.value.dailyNoteFolder, DEFAULT_DAILY_FOLDER)
  const title = sanitizeName(formatDate(config.value.dailyNoteFormat ?? DEFAULT_DAILY_FORMAT))
  const template = config.value.dailyTemplateEnabled && config.value.dailyTemplate ? config.value.dailyTemplate : null
  await openDatedNote(folder, title, template, formatDate('yyyy-MM-dd'))
}

// Opens this week's weekly note, the same way; its format's yyyy is the week's year, and
// which day weeks start on is a setting.
export async function openWeeklyNote() {
  const folder = folderOrDefault(config.value.weeklyNoteFolder, DEFAULT_WEEKLY_FOLDER)
  const title = sanitizeName(
    formatDate(config.value.weeklyNoteFormat ?? DEFAULT_WEEKLY_FORMAT, new Date(), true, config.value.firstDayOfWeek),
  )
  const template = config.value.weeklyTemplateEnabled && config.value.weeklyTemplate ? config.value.weeklyTemplate : null
  await openDatedNote(folder, title, template)
}

// `todayDate` ("YYYY-MM-DD"), only set for a daily note, adds its "Today" variable.
async function openDatedNote(folder: string, title: string, templateTitle: string | null, todayDate: string | null = null) {
  const path = `${folder ? `${folder}/` : ''}${title}.json`
  if (files.value.includes(path)) return selectFile(path)
  if (folder && !folders.value.includes(folder)) folders.value.push(folder)
  const content = templateTitle ? await templateContent(templateTitle) : null
  const metadata = todayDate ? withTodayVariable(content?.metadata ?? {}, todayDate) : content?.metadata ?? {}
  await createNote(title, folder, content?.blocks ?? [], metadata, content?.floating)
}

// A new note goes in the folder from the settings (the top level unless set).
export function createNewNote() {
  const folder = config.value.newNoteFolder ?? ''
  if (folder && !folders.value.includes(folder)) folders.value.push(folder)
  createNote(nextNewNoteTitle(), folder)
}

export async function copyNote(path: string) {
  await ensureLoaded(path) // the source might not be open anywhere yet
  const source = noteCache.get(path)
  if (!source) return

  const sourceTitle = nameFromPath(path)
  const folderPrefix = path.slice(0, path.lastIndexOf('/') + 1)
  const title = freeName(`${sourceTitle} (copy)`, folderPrefix)
  const newPath = `${folderPrefix}${title}.json`

  const copy: Note = JSON.parse(JSON.stringify(source))
  const { ok } = await serverWrite(`/file?path=${encodeURIComponent(newPath)}`, {
    method: 'PUT',
    body: JSON.stringify(copy, null, 2),
  })
  if (!ok) return
  files.value.push(newPath)
  noteCache.set(newPath, copy)
  noteList.value.push({ title, path: newPath })
  noteIndex.value[title] = newPath
}

export function validateTitle(input: string, currentTitle: string | undefined): string | null {
  const trimmed = input.trim()
  if (!trimmed) return 'Name cannot be empty.'
  if (!NAME_RE.test(trimmed)) return 'Only letters, numbers, spaces, -, _ and () are allowed.'
  if (trimmed !== currentTitle && trimmed in noteIndex.value) {
    return 'A note with that name already exists.'
  }
  return null
}

// Same shape as validateTitle, but an image's name only needs to be unique
// alongside its own extension (two images can't collide; an image and a note can
// never collide, their extensions always differ) and isn't tracked in noteIndex.
export function validateImageName(input: string, currentName: string | undefined, path: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return 'Name cannot be empty.'
  if (!NAME_RE.test(trimmed)) return 'Only letters, numbers, spaces, -, _ and () are allowed.'
  if (trimmed === currentName) return null
  const ext = path.slice(path.lastIndexOf('.'))
  const folderPrefix = path.slice(0, path.lastIndexOf('/') + 1)
  if (files.value.includes(`${folderPrefix}${trimmed}${ext}`)) {
    return 'A file with that name already exists.'
  }
  return null
}

// Renames a note (open or not) through the server's /rename, which renames the
// file and rewrites [[old]] links elsewhere in the notebook. Returns an error
// message, or null on success.
export async function renameNote(path: string, newTitle: string): Promise<string | null> {
  if (!files.value.includes(path)) return 'Note not found.'
  const previousTitle = nameFromPath(path)
  if (newTitle === previousTitle) return null

  await saveAllNotes()
  const { ok, data } = await serverWrite(`/rename?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    body: JSON.stringify({ name: newTitle }),
  })
  if (!ok) return data.error

  const newPath = data.path as string
  remapPaths(path, newPath)

  if (noteIndex.value[previousTitle] === newPath) delete noteIndex.value[previousTitle]
  noteIndex.value[newTitle] = newPath
  const listed = noteList.value.find((n) => n.path === newPath)
  if (listed) listed.title = newTitle

  mirrorLinkRewrite([[`[[${previousTitle}]]`, `[[${newTitle}]]`]])
  return null
}

// The server rewrote links in files on disk; mirror that in the cached copies so
// a later save doesn't write the old links back. The cache hands out reactive
// notes, so open editors update. The rewrite changed text in other notes, so their
// earlier snapshots would put the old link back; every note's history starts fresh.
function mirrorLinkRewrite(replacements: [string, string][]) {
  for (const cachedNote of noteCache.values()) {
    for (const block of allBlocks(cachedNote)) {
      for (const [from, to] of replacements) block.content = block.content.replaceAll(from, to)
    }
  }
  clearHistories()
  for (const openPath of tracked.keys()) initHistory(openPath, noteCache.get(openPath)!)
}

// Renames an image through the server's /rename, same endpoint as renameNote.
// Links to an image say its full filename (or its notebook path), so those are what
// get rewritten, in the same forms the server rewrites.
export async function renameImage(path: string, newName: string): Promise<string | null> {
  const previousName = nameFromPath(path)
  if (newName === previousName) return null

  const { ok, data } = await serverWrite(`/rename?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    body: JSON.stringify({ name: newName }),
  })
  if (!ok) return data.error
  const newPath = data.path as string
  remapPaths(path, newPath)
  mirrorLinkRewrite([
    [`[[${baseName(path)}]]`, `[[${baseName(newPath)}]]`],
    [`[[${path}]]`, `[[${newPath}]]`],
    // an embed with a width, ![[img.jpg|400]]
    [`[[${baseName(path)}|`, `[[${baseName(newPath)}|`],
    [`[[${path}|`, `[[${newPath}|`],
  ])
  return null
}

const PASTED_IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
}

// Saves a pasted image into the attachments folder (created if it's missing) as
// "Pasted image <date-time>.<ext>". Returns its path, or null if it can't be saved.
export async function addImage(file: File): Promise<string | null> {
  const ext = PASTED_IMAGE_EXT[file.type]
  if (!ext) return null
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const folder = folderOrDefault(config.value.attachmentsFolder, DEFAULT_ATTACHMENTS_FOLDER)
  const prefix = folder ? `${folder}/` : ''
  let path = `${prefix}Pasted image ${stamp}.${ext}`
  for (let n = 2; files.value.includes(path); n++) path = `${prefix}Pasted image ${stamp} ${n}.${ext}`

  const { ok } = await serverWrite(`/image?path=${encodeURIComponent(path)}`, { method: 'PUT', body: file })
  if (!ok) return null
  files.value.push(path)
  if (folder && !folders.value.includes(folder)) folders.value.push(folder)
  return path
}

// Renames a note, image or folder from the sidebar, checking the new name first.
// Returns an error message, or null once it is renamed (or the name is unchanged).
export async function renameEntry(kind: 'note' | 'image' | 'pdf' | 'script' | 'folder', path: string, name: string): Promise<string | null> {
  const isFile = kind === 'image' || kind === 'pdf' || kind === 'script' // renamed with its extension kept, like an image
  const current =
    kind === 'folder' ? path.slice(path.lastIndexOf('/') + 1)
    : isFile ? nameFromPath(path)
    : noteList.value.find((n) => n.path === path)?.title ?? ''
  if (name === current) return null

  if (kind === 'folder') {
    if (!name) return 'Name cannot be empty.'
    if (name.includes('/') || name.includes('\\')) return 'Name cannot contain slashes.'
    if (folders.value.includes(path.slice(0, path.lastIndexOf('/') + 1) + name)) {
      return 'A folder with that name already exists.'
    }
    return renameFolder(path, name)
  }
  const error =
    kind === 'script' ? validateScriptName(name, current, path)
    : isFile ? validateImageName(name, current, path)
    : validateTitle(name, current)
  if (error) return error
  if (kind === 'script') return renameScript(path, name)
  return isFile ? renameImage(path, name) : renameNote(path, name)
}

// Deleting only moves things to the trash, and asking first is a setting.
function confirmDelete(options: Parameters<typeof askConfirm>[0]) {
  return config.value.confirmDelete === false ? Promise.resolve(true) : askConfirm(options)
}

export async function deleteNote(path: string | null = selectedFile.value) {
  if (!path) return
  const title = noteList.value.find((n) => n.path === path)?.title ?? path
  const confirmed = await confirmDelete({
    title: 'Delete note',
    message: `Move "${title}" to the trash? You can recover it from the .trash folder in your notebook.`,
  })
  if (!confirmed) return

  discardPendingSave(path)
  const { ok } = await serverWrite(`/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
  if (ok) forgetNote(path)
}

// Drops a note from the sidebar and cache, closing it if it's open.
function forgetNote(path: string) {
  const title = noteList.value.find((n) => n.path === path)?.title
  files.value = files.value.filter((f) => f !== path)
  noteCache.delete(path)
  dropScript(path)
  noteList.value = noteList.value.filter((n) => n.path !== path)
  dropHistory(path)
  if (title !== undefined && noteIndex.value[title] === path) delete noteIndex.value[title]
  untrackNote(path, false)
  closePanesShowing(path)
  if (config.value.lastOpenNote === path) {
    config.value.lastOpenNote = null
    queueConfigSave()
  }
}

// Whether a note is bookmarked — kept in config.bookmarkOrder rather than the note's
// own metadata, so the sidebar and the Bookmarks tab can know without loading it.
// Checks both unfiled items and every organizational folder's notes.
export function isBookmarked(path: string): boolean {
  return (config.value.bookmarkOrder ?? []).some(
    (item) => (item.kind === 'note' && item.path === path) || (item.kind === 'folder' && item.notes.includes(path)),
  )
}

// Flips a note's bookmark, from the sidebar menu or the settings menu's checkbox.
// Just a config change — no note content involved, so it works whether or not the
// note is even loaded yet. Unbookmarking removes it from wherever it is (unfiled or
// in a folder); bookmarking always adds it unfiled, at the end.
export function toggleBookmark(path: string) {
  const order = config.value.bookmarkOrder ?? []
  if (isBookmarked(path)) {
    config.value.bookmarkOrder = order
      .filter((item) => !(item.kind === 'note' && item.path === path))
      .map((item) => (item.kind === 'folder' ? { ...item, notes: item.notes.filter((p) => p !== path) } : item))
  } else {
    config.value.bookmarkOrder = [...order, { kind: 'note', path }]
  }
  queueConfigSave()
}

// Picks a name for a new bookmark folder that isn't already used by one, adding
// " (1)", " (2)", etc. — same idea as freeName for a notebook folder.
function freeBookmarkFolderName(base: string): string {
  const names = new Set((config.value.bookmarkOrder ?? []).filter((item) => item.kind === 'folder').map((item) => item.name))
  if (!names.has(base)) return base
  let n = 1
  while (names.has(`${base} (${n})`)) n++
  return `${base} (${n})`
}

// Adds a new, empty, expanded organizational folder to the Bookmarks tab and
// returns its id, so the caller can start renaming it right away.
export function addBookmarkFolder(): string {
  const id = `bookmark-folder-${randomUUID()}`
  const folder: BookmarkFolder = { kind: 'folder', id, name: freeBookmarkFolderName('New Folder'), notes: [] }
  config.value.bookmarkOrder = [...(config.value.bookmarkOrder ?? []), folder]
  queueConfigSave()
  return id
}

export function renameBookmarkFolder(id: string, name: string) {
  const order = config.value.bookmarkOrder
  const folder = order?.find((item) => item.kind === 'folder' && item.id === id)
  if (!folder || folder.kind !== 'folder') return
  const trimmed = name.trim()
  if (trimmed) folder.name = trimmed
  queueConfigSave()
}

export function setBookmarkFolderCollapsed(id: string, collapsed: boolean) {
  const folder = config.value.bookmarkOrder?.find((item) => item.kind === 'folder' && item.id === id)
  if (!folder || folder.kind !== 'folder') return
  folder.collapsed = collapsed
  queueConfigSave()
}

// Removes an organizational folder without un-bookmarking its notes: they go back
// to being unfiled, in its place.
export function deleteBookmarkFolder(id: string) {
  const order = config.value.bookmarkOrder ?? []
  const index = order.findIndex((item) => item.kind === 'folder' && item.id === id)
  if (index === -1) return
  const folder = order[index] as BookmarkFolder
  const unfiled: BookmarkItem[] = folder.notes.map((path) => ({ kind: 'note', path }))
  config.value.bookmarkOrder = [...order.slice(0, index), ...unfiled, ...order.slice(index + 1)]
  queueConfigSave()
}

// What a note or folder being relocated should land before — looked up by identity
// (a path or a folder id) rather than a plain index, so the dragged item's own
// removal from its old spot can never throw off where "before" actually points.
export type BookmarkBeforeRef = { kind: 'note'; path: string } | { kind: 'folder'; id: string } | null

function spliceBefore<T extends BookmarkItem>(items: T[], before: BookmarkBeforeRef, item: T) {
  const index = before
    ? items.findIndex((i) => (before.kind === 'folder' ? i.kind === 'folder' && i.id === before.id : i.kind === 'note' && i.path === before.path))
    : -1
  items.splice(index === -1 ? items.length : index, 0, item)
}

// Moves a bookmarked note to a folder (folderId) or back to unfiled (folderId:
// null), wherever it currently is — used when a drag relocates it rather than just
// reordering it in place. `before` is within the target: another note's path if
// filing into a folder, a note's path or a folder's id if landing at the top level.
export function fileBookmark(path: string, folderId: string | null, before: BookmarkBeforeRef) {
  const order = (config.value.bookmarkOrder ?? []).map((item) =>
    item.kind === 'folder' ? { ...item, notes: item.notes.filter((p) => p !== path) } : item,
  )
  const withoutNote = order.filter((item) => !(item.kind === 'note' && item.path === path))
  if (folderId === null) {
    spliceBefore(withoutNote, before, { kind: 'note', path })
  } else {
    const folder = withoutNote.find((item) => item.kind === 'folder' && item.id === folderId)
    if (folder && folder.kind === 'folder') {
      const beforeIndex = before?.kind === 'note' ? folder.notes.indexOf(before.path) : -1
      folder.notes.splice(beforeIndex === -1 ? folder.notes.length : beforeIndex, 0, path)
    }
  }
  config.value.bookmarkOrder = withoutNote
  queueConfigSave()
}

// Reorders a folder among the other top-level items (folders can't nest, so this
// is the only kind of move a dragged folder ever makes). An unfiled note moving
// within the top level goes through fileBookmark instead (folderId: null), which
// already handles landing back where it started the same way.
export function reorderBookmarkFolder(folderId: string, before: BookmarkBeforeRef) {
  const order = config.value.bookmarkOrder ?? []
  const item = order.find((i) => i.kind === 'folder' && i.id === folderId)
  if (!item) return
  const without = order.filter((i) => i !== item)
  spliceBefore(without, before, item)
  config.value.bookmarkOrder = without
  queueConfigSave()
}

export async function createFolder(parent = '') {
  const prefix = parent ? `${parent}/` : ''
  const base = 'New Folder'
  let path = `${prefix}${base}`
  for (let n = 1; folders.value.includes(path); n++) path = `${prefix}${base} (${n})`

  const { ok } = await serverWrite(`/folder?path=${encodeURIComponent(path)}`, { method: 'POST' })
  if (!ok) return
  folders.value.push(path)
  collapsedFolders.value.delete(parent) // make sure the new folder is visible
}

export async function renameFolder(path: string, name: string): Promise<string | null> {
  if (name === path.slice(path.lastIndexOf('/') + 1)) return null

  // Anything still unsaved goes out under the old path first.
  await saveAllNotes()
  const { ok, data } = await serverWrite(
    `/folder-rename?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
    { method: 'POST' },
  )
  if (!ok) return data.error
  remapPaths(path, data.path)
  return null
}

export async function deleteFolder(path: string) {
  const inside = noteList.value.filter((n) => n.path.startsWith(`${path}/`))
  const name = path.slice(path.lastIndexOf('/') + 1)
  const contents = inside.length ? ` and the ${inside.length} note${inside.length === 1 ? '' : 's'} in it` : ''
  const confirmed = await confirmDelete({
    title: 'Delete folder',
    message: `Move the folder "${name}"${contents} to the trash? You can recover them from the .trash folder in your notebook.`,
  })
  if (!confirmed) return

  for (const openPath of tracked.keys()) {
    if (openPath.startsWith(`${path}/`)) discardPendingSave(openPath)
  }
  for (const scriptPath of scriptCache.keys()) {
    if (scriptPath.startsWith(`${path}/`)) discardPendingSave(scriptPath)
  }
  const { ok } = await serverWrite(`/folder?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
  if (!ok) return

  for (const entry of inside) forgetNote(entry.path)
  for (const scriptPath of scriptList.value.filter((p) => p.startsWith(`${path}/`))) forgetNote(scriptPath)
  folders.value = folders.value.filter((f) => f !== path && !f.startsWith(`${path}/`))
}

// Moves a note or folder (with its contents) into `folder` ('' is the root).
export async function moveItem(path: string, folder: string) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const newPath = folder ? `${folder}/${name}` : name
  if (newPath === path) return

  // Edits still waiting to save go out under the old path first.
  await saveAllNotes()

  const { ok, data } = await serverWrite(
    `/move?path=${encodeURIComponent(path)}&to=${encodeURIComponent(folder)}`,
    { method: 'POST' },
  )
  if (!ok) return console.error(`Move of ${path} refused: ${data.error}`)
  remapPaths(path, data.path)
  collapsedFolders.value.delete(folder) // show where it landed
}

// Re-keys everything the client tracks by path after a file or folder moved or
// was renamed on the server; for a folder, everything under it moves too.
function remapPaths(from: string, to: string) {
  const remap = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p)
  files.value = files.value.map(remap)
  folders.value = folders.value.map(remap)
  for (const entry of noteList.value) entry.path = remap(entry.path)
  for (const title of Object.keys(noteIndex.value)) noteIndex.value[title] = remap(noteIndex.value[title]!)

  const cached = [...noteCache]
  noteCache.clear()
  for (const [key, value] of cached) noteCache.set(remap(key), value)
  collapsedFolders.value = new Set([...collapsedFolders.value].map(remap))
  for (const cache of [scriptCache, scriptRuns] as Map<string, unknown>[]) {
    const entries = [...cache]
    cache.clear()
    for (const [key, value] of entries) cache.set(remap(key), value)
  }

  remapLayoutPaths(remap)
  remapTracked(remap)
  remapHistories(remap)
  const lastOpen = config.value.lastOpenNote
  if (lastOpen && remap(lastOpen) !== lastOpen) {
    config.value.lastOpenNote = remap(lastOpen)
    queueConfigSave()
  }
  if (config.value.recentNotes?.some((p) => remap(p) !== p)) {
    config.value.recentNotes = config.value.recentNotes.map(remap)
    queueConfigSave()
  }
  if (config.value.bookmarkOrder) {
    let changed = false
    const remapped = config.value.bookmarkOrder.map((item): BookmarkItem => {
      if (item.kind === 'note') {
        const path = remap(item.path)
        if (path !== item.path) changed = true
        return { ...item, path }
      }
      const notes = item.notes.map(remap)
      if (notes.some((p, i) => p !== item.notes[i])) changed = true
      return { ...item, notes }
    })
    if (changed) {
      config.value.bookmarkOrder = remapped
      queueConfigSave()
    }
  }
}

// --- Blocks of a note ---

// Where a block sits in a note: its row and its column within that row.
export function findBlockPosition(
  target: Note | null | undefined,
  blockId: string,
): { rowIndex: number; colIndex: number } | null {
  if (!target) return null
  for (let rowIndex = 0; rowIndex < target.blocks.length; rowIndex++) {
    const colIndex = target.blocks[rowIndex]!.findIndex((b) => b.id === blockId)
    if (colIndex !== -1) return { rowIndex, colIndex }
  }
  return null
}

// Every block of a note, the hooked ones in document order, then the floating ones.
export function allBlocks(target: Note | null | undefined): Block[] {
  return target ? [...target.blocks.flat(), ...(target.floating ?? [])] : []
}

// A block by id, hooked or floating.
export function findAnyBlock(target: Note | null | undefined, blockId: string): Block | undefined {
  const pos = findBlockPosition(target, blockId)
  return pos ? target!.blocks[pos.rowIndex]![pos.colIndex] : target?.floating?.find((b) => b.id === blockId)
}

// Takes a block out of the note's flow and floats it at the given place (see
// FloatingBlock in types.ts), in front of the others.
export function unhookBlock(path: string, blockId: string, place: { x: number; y: number; width: number }) {
  const target = noteCache.get(path)
  const pos = findBlockPosition(target, blockId)
  if (!target || !pos) return
  const row = target.blocks[pos.rowIndex]!
  const block = row.splice(pos.colIndex, 1)[0]!
  if (row.length === 0) target.blocks.splice(pos.rowIndex, 1)
  const floating = (target.floating ??= [])
  floating.push({ ...block, ...place, z: Math.max(0, ...floating.map((b) => b.z)) + 1 })
}

// Puts a floating block back in the flow, in its own row: at rowIndex, or the end of the note.
export function hookBlock(path: string, blockId: string, rowIndex?: number) {
  const target = noteCache.get(path)
  const index = target?.floating?.findIndex((b) => b.id === blockId) ?? -1
  if (!target?.floating || index === -1) return
  const { x: _x, y: _y, width: _width, z: _z, ...block } = target.floating.splice(index, 1)[0]!
  if (!target.floating.length) delete target.floating // the field exists only while a block floats
  target.blocks.splice(rowIndex ?? target.blocks.length, 0, [block])
}

// Moves a block into a row of its own at rowIndex (an index into the note's rows as they
// are now): a floating block is hooked there, a hooked one is reordered.
export function placeBlock(path: string, blockId: string, rowIndex: number) {
  const target = noteCache.get(path)
  const pos = findBlockPosition(target, blockId)
  if (!target || !pos) return hookBlock(path, blockId, rowIndex)
  const row = target.blocks[pos.rowIndex]!
  const block = row.splice(pos.colIndex, 1)[0]!
  let at = rowIndex
  if (row.length === 0) {
    target.blocks.splice(pos.rowIndex, 1)
    if (pos.rowIndex < at) at-- // the emptied row was above the place, so it moved up
  }
  target.blocks.splice(at, 0, [block])
}

// --- Undo and redo for a note's blocks, by path ---

export function undoEdit(path: string) {
  const target = noteCache.get(path)
  if (target) undo(path, target)
}

export function redoEdit(path: string) {
  const target = noteCache.get(path)
  if (target) redo(path, target)
}

// See history.ts: makes the next edit its own undo step.
export function breakUndoStep(path: string) {
  breakUndoGroup(path)
}
