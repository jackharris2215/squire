import { ref } from 'vue'
import type { Block, FloatingBlock, Note } from './types'

// Undo and redo for a note's blocks, floating blocks and metadata (such as "show title").
// Each note keeps its own history in memory, as snapshots of its blocks: an
// undo swaps an earlier snapshot back in, and autosave then saves it. Because
// it works on whole snapshots, every kind of edit (typing, table changes,
// splitting and moving blocks, block settings) is covered without per-edit code.
//
// Typing is grouped: consecutive text-only edits within GROUP_MS of each other
// count as one step. Anything that changes the structure is a step of its own.

const GROUP_MS = 1000
const MAX_STEPS = 100

interface History {
  undo: string[] // earlier snapshots, oldest first
  redo: string[] // snapshots undone, most recent last
  current: string // the snapshot matching the note as it is now
  key: string // current without block types, to ignore type-only changes
  shape: string // current without text, to tell typing from structural edits
  lastChange: number
  lastWasText: boolean
  breakNext: boolean // the next edit must be a step of its own
}

const histories = new Map<string, History>()

// For the undo and redo buttons of whichever pane shows a note: whether that note
// has anything to undo or redo. `changes` is bumped whenever any history changes,
// so the checks below re-run in the components that call them.
const changes = ref(0)

export function canUndoFor(path: string | null) {
  changes.value // dependency only
  return !!path && (histories.get(path)?.undo.length ?? 0) > 0
}

export function canRedoFor(path: string | null) {
  changes.value
  return !!path && (histories.get(path)?.redo.length ?? 0) > 0
}

type Describe = { full: string; key: string }

function describe(note: Note): Describe {
  const noType = note.blocks.map((row) => row.map(({ type: _type, ...rest }) => rest))
  // A floating block's z (its stacking order) changes on every click, so it isn't a step.
  const floatingNoType = (note.floating ?? []).map(({ type: _type, z: _z, ...rest }) => rest)
  return {
    full: JSON.stringify({ blocks: note.blocks, floating: note.floating ?? [], metadata: note.metadata }),
    key: JSON.stringify({ blocks: noType, floating: floatingNoType, metadata: note.metadata }),
  }
}

function shapeOf(note: Note) {
  const noText = note.blocks.map((row) => row.map(({ type: _type, content: _content, ...rest }) => rest))
  const floatingNoText = (note.floating ?? []).map(({ type: _type, content: _content, z: _z, ...rest }) => rest)
  return JSON.stringify({ blocks: noText, floating: floatingNoText, metadata: note.metadata })
}

function parse(snapshot: string) {
  return JSON.parse(snapshot) as { blocks: Block[][]; floating: FloatingBlock[]; metadata: Record<string, unknown> }
}

function makeHistory(note: Note): History {
  const { full, key } = describe(note)
  return {
    undo: [],
    redo: [],
    current: full,
    key,
    shape: shapeOf(note),
    lastChange: 0,
    lastWasText: false,
    breakNext: false,
  }
}

function syncFlags() {
  changes.value++
}

// Starts tracking a note the first time it's opened; its state then is the baseline.
export function initHistory(path: string, note: Note) {
  if (!histories.has(path)) histories.set(path, makeHistory(note))
  syncFlags()
}

// Forgets everything for one note, or for all (e.g. after a rename rewrote links).
export function dropHistory(path: string) {
  histories.delete(path)
  syncFlags()
}

export function clearHistories() {
  histories.clear()
  syncFlags()
}

// A note moved to another path.
export function remapHistories(remap: (path: string) => string) {
  const entries = [...histories]
  histories.clear()
  for (const [path, history] of entries) histories.set(remap(path), history)
  syncFlags()
}

// Makes the next edit its own step, even if it's just text (used by table
// operations, so they never merge into the typing around them).
export function breakUndoGroup(path: string) {
  const h = histories.get(path)
  if (h) h.breakNext = true
}

// Called after every edit to the open note.
export function recordChange(path: string, note: Note) {
  const h = histories.get(path)
  if (!h) return

  const { full, key } = describe(note)
  if (key === h.key) {
    h.current = full // only block types changed (set on blur); nothing to undo
    return
  }

  const shape = shapeOf(note)
  const textOnly = shape === h.shape
  const now = Date.now()
  const joinsGroup = textOnly && h.lastWasText && !h.breakNext && now - h.lastChange < GROUP_MS
  if (!joinsGroup) {
    h.undo.push(h.current)
    if (h.undo.length > MAX_STEPS) h.undo.shift()
  }

  h.current = full
  h.key = key
  h.shape = shape
  h.lastChange = now
  h.lastWasText = textOnly && !h.breakNext
  h.breakNext = false
  h.redo = []
  syncFlags()
}

// Swaps a snapshot into the note in place, so the note object stays the same.
function restore(note: Note, snapshot: string, h: History) {
  const data = parse(snapshot)
  note.blocks.splice(0, note.blocks.length, ...data.blocks)
  // The field is only present while a block is floating, as in a saved note.
  if (data.floating.length) note.floating = data.floating
  else delete note.floating
  for (const field of Object.keys(note.metadata)) delete note.metadata[field]
  Object.assign(note.metadata, data.metadata)

  // Record the restored state as the current one, so the change watcher sees
  // nothing new to record.
  const { full, key } = describe(note)
  h.current = full
  h.key = key
  h.shape = shapeOf(note)
  h.lastWasText = false
  h.breakNext = false
}

export function undo(path: string, note: Note): boolean {
  const h = histories.get(path)
  const previous = h?.undo.pop()
  if (!h || previous === undefined) return false
  h.redo.push(h.current)
  restore(note, previous, h)
  syncFlags()
  return true
}

export function redo(path: string, note: Note): boolean {
  const h = histories.get(path)
  const next = h?.redo.pop()
  if (!h || next === undefined) return false
  h.undo.push(h.current)
  restore(note, next, h)
  syncFlags()
  return true
}
