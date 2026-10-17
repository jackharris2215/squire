import { computed, ref, toRaw } from 'vue'

// How the main area is divided into panes. The layout is a tree: a pane shows one
// note (or nothing), and a split lays its children out in a row (side by side) or a
// column (stacked), each taking a share of the space. This file only holds that
// state and the changes to it; store.ts connects it to notes, and PaneLayout.vue
// draws it.

export interface Pane {
  kind: 'pane'
  id: string
  path: string | null // the note shown, null for an empty pane
  // The notes this pane showed before and after the current one, for its back and
  // forward buttons. Kept in memory only, not saved with the layout.
  back: string[]
  forward: string[]
}

export interface Split {
  kind: 'split'
  id: string
  direction: 'row' | 'column'
  children: LayoutNode[]
  sizes: number[] // each child's share of the space; they add up to 1
}

export type LayoutNode = Pane | Split

// Which side of a pane a new pane is placed on.
export type Side = 'left' | 'right' | 'top' | 'bottom'

let idCounter = 0

function makePane(path: string | null): Pane {
  return { kind: 'pane', id: `pane-${++idCounter}`, path, back: [], forward: [] }
}

export const layout = ref<LayoutNode>(makePane(null))

// The pane that keyboard shortcuts, the sidebar and Ctrl+P act on.
export const focusedPaneId = ref(layout.value.id)

export function panes(node: LayoutNode = layout.value): Pane[] {
  return node.kind === 'pane' ? [node] : node.children.flatMap((child) => panes(child))
}

export const focusedPane = computed(() => panes().find((p) => p.id === focusedPaneId.value) ?? panes()[0]!)

// The notes shown in any pane (a note shown twice appears twice).
export function openPaths(): string[] {
  return panes().flatMap((p) => (p.path ? [p.path] : []))
}

// The pane in the top-right corner of the main area: the one whose header carries the
// right panel's button. In a row of panes that is the last, in a stack the first.
export function topRightPaneId(node: LayoutNode = layout.value): string {
  if (node.kind === 'pane') return node.id
  return topRightPaneId(node.direction === 'row' ? node.children[node.children.length - 1]! : node.children[0]!)
}

export function setFocus(paneId: string) {
  focusedPaneId.value = paneId
}

// Shows a note in a pane. The note it showed goes onto its back list, and opening
// something new empties its forward list, like a browser.
function setPanePath(pane: Pane, path: string) {
  if (pane.path === path) return
  if (pane.path) pane.back.push(pane.path)
  pane.forward = []
  pane.path = path
}

// Opens a note in the focused pane, replacing what it showed.
export function showInFocusedPane(path: string) {
  setPanePath(focusedPane.value, path)
}

// Steps a pane back (or forward) through the notes it has shown. Returns the note
// now shown, or null if there was nowhere to go.
export function stepPane(id: string, direction: 'back' | 'forward'): string | null {
  const pane = findPane(id)
  const from = direction === 'back' ? pane?.back : pane?.forward
  const to = direction === 'back' ? pane?.forward : pane?.back
  const path = from?.pop()
  if (!pane || !to || !path) return null
  if (pane.path) to.push(pane.path)
  pane.path = path
  focusedPaneId.value = id
  return path
}

// --- Saving and restoring the layout (kept in config.json) ---

export type SavedNode =
  | { kind: 'pane'; path: string | null }
  | { kind: 'split'; direction: 'row' | 'column'; children: SavedNode[]; sizes: number[] }

export interface SavedLayout {
  root: SavedNode
  focused: number // which pane has the focus, counting panes in order
}

function savedNode(node: LayoutNode): SavedNode {
  if (node.kind === 'pane') return { kind: 'pane', path: node.path }
  return { kind: 'split', direction: node.direction, children: node.children.map(savedNode), sizes: [...node.sizes] }
}

export function serializeLayout(): SavedLayout {
  const index = panes().findIndex((p) => p.id === focusedPane.value.id)
  return { root: savedNode(layout.value), focused: Math.max(index, 0) }
}

// Rebuilds the layout from what was saved. Notes that no longer exist are dropped,
// along with the panes that showed them (the last pane stays, empty). Anything that
// doesn't look like a saved layout is ignored.
export function restoreLayout(saved: SavedLayout, exists: (path: string) => boolean) {
  try {
    const build = (node: SavedNode): LayoutNode => {
      if (node.kind === 'pane') return makePane(node.path && exists(node.path) ? node.path : null)
      if (node.children.length === 0 || node.children.length !== node.sizes.length) throw new Error('bad split')
      return {
        kind: 'split',
        id: `pane-${++idCounter}`,
        direction: node.direction === 'column' ? 'column' : 'row',
        children: node.children.map(build),
        sizes: node.sizes.map((s) => (s > 0 ? s : 1)),
      }
    }
    const built = build(saved.root)
    const focus = panes(built)[saved.focused]

    // Drop empty panes and collapse splits left with one child.
    const prune = (node: LayoutNode): LayoutNode | null => {
      if (node.kind === 'pane') return node.path ? node : null
      const children: LayoutNode[] = []
      const sizes: number[] = []
      node.children.forEach((child, i) => {
        const kept = prune(child)
        if (kept) {
          children.push(kept)
          sizes.push(node.sizes[i]!)
        }
      })
      if (children.length <= 1) return children[0] ?? null
      const total = sizes.reduce((a, b) => a + b, 0)
      return { ...node, children, sizes: sizes.map((s) => s / total) }
    }
    const root = prune(built) ?? makePane(null)
    normalize(root)

    layout.value = root
    focusedPaneId.value = (focus && panes(root).find((p) => p.id === focus.id) ? focus : panes(root)[0]!).id
  } catch {
    // Keep the current layout.
  }
}

// Opens a note in a specific pane and focuses it.
export function showInPane(paneId: string, path: string) {
  const pane = findPane(paneId)
  if (!pane) return
  setPanePath(pane, path)
  focusedPaneId.value = paneId
}

function findParent(id: string, node: LayoutNode = layout.value): { parent: Split; index: number } | null {
  if (node.kind === 'pane') return null
  const index = node.children.findIndex((c) => c.id === id)
  if (index !== -1) return { parent: node, index }
  for (const child of node.children) {
    const found = findParent(id, child)
    if (found) return found
  }
  return null
}

function replaceNode(id: string, replacement: LayoutNode) {
  const info = findParent(id)
  if (info) info.parent.children[info.index] = replacement
  else layout.value = replacement
}

// A split inside a split of the same direction is just more children of the outer
// one; fold it in so panes in a row stay one row.
function normalize(node: LayoutNode) {
  if (node.kind === 'pane') return
  node.children.forEach(normalize)
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!
    if (child.kind === 'split' && child.direction === node.direction) {
      const share = node.sizes[i]!
      node.children.splice(i, 1, ...child.children)
      node.sizes.splice(i, 1, ...child.sizes.map((s) => s * share))
      i += child.children.length - 1
    }
  }
}

// Opens `path` in a new pane on one side of an existing pane, which gives up half
// of its space. The new pane takes the focus.
export function splitPane(targetId: string, side: Side, path: string) {
  const target = findPane(targetId)
  if (!target) return
  const direction = side === 'left' || side === 'right' ? 'row' : 'column'
  const before = side === 'left' || side === 'top'
  const fresh = makePane(path)

  const info = findParent(targetId)
  if (info && info.parent.direction === direction) {
    const { parent, index } = info
    const half = parent.sizes[index]! / 2
    const at = before ? index : index + 1
    parent.sizes[index] = half
    parent.sizes.splice(at, 0, half)
    parent.children.splice(at, 0, fresh)
  } else {
    const raw = toRaw(target)
    replaceNode(targetId, {
      kind: 'split',
      id: `pane-${++idCounter}`,
      direction,
      children: before ? [fresh, raw] : [raw, fresh],
      sizes: [0.5, 0.5],
    })
  }
  focusedPaneId.value = fresh.id
}

function findPane(id: string) {
  return panes().find((p) => p.id === id)
}

// Closes a pane; its space goes to the others. The only pane is emptied instead.
export function closePane(id: string) {
  const pane = findPane(id)
  if (!pane) return
  const info = findParent(id)
  if (!info) {
    pane.path = null
    return
  }

  const { parent, index } = info
  parent.children.splice(index, 1)
  parent.sizes.splice(index, 1)
  const total = parent.sizes.reduce((a, b) => a + b, 0)
  parent.sizes = parent.sizes.map((s) => s / total)

  // The neighbour that takes over the focus, if the closed pane had it.
  const neighbour = parent.children[Math.min(index, parent.children.length - 1)]!
  if (focusedPaneId.value === id) focusedPaneId.value = panes(neighbour)[0]!.id

  if (parent.children.length === 1) replaceNode(parent.id, parent.children[0]!)
  normalize(layout.value)
}

// A note was deleted: close every pane showing it.
export function closePanesShowing(path: string) {
  for (const pane of panes()) {
    if (pane.path === path) closePane(pane.id)
  }
  for (const pane of panes()) {
    pane.back = pane.back.filter((p) => p !== path)
    pane.forward = pane.forward.filter((p) => p !== path)
  }
}

// A note or folder moved: panes follow their notes.
export function remapLayoutPaths(remap: (path: string) => string) {
  for (const pane of panes()) {
    if (pane.path) pane.path = remap(pane.path)
    pane.back = pane.back.map(remap)
    pane.forward = pane.forward.map(remap)
  }
}
