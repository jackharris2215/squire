export interface Block {
  id: string
  type: string
  content: string
  // Display settings. Older blocks don't have these; a missing value means the
  // default, and the field is only added the first time it's changed.
  align?: 'left' | 'center' | 'right'
  textColor?: string // a key from COLORS (blocks.ts)
  background?: string // a key from COLORS (blocks.ts)
}

// A block taken out of the flow and placed freely on the note. x is in pixels from the
// middle of the note column (so it holds when the note's width changes), y in pixels
// from the top of the note, width in pixels, and a higher z sits in front.
export interface FloatingBlock extends Block {
  x: number
  y: number
  width: number
  z: number
}

export interface Note {
  metadata: Record<string, unknown>
  blocks: Block[][] // rows of blocks; more than one block in a row means columns
  floating?: FloatingBlock[] // unhooked blocks; only written once one is unhooked
}

import type { SavedLayout } from './layout'

// A named value the notebook or a note keeps; widgets will read and change them.
export interface Variable {
  name: string
  type: 'text' | 'number' | 'boolean' | 'date' | 'time'
  value: string | number | boolean // matches the type
  // Set only on a global variable (see variables.ts): computed, never stored, and
  // never changeable, so a widget (every one but the plain {{name}} display is a way
  // to change the value) can't be used with it.
  readonly?: boolean
}

// The Bookmarks tab's items, top-level order. A folder here is purely organizational
// (not a real notebook folder — just a way to group bookmarks) and holds its own notes'
// paths, in order; a note not in any folder is "unfiled", listed at the top level.
export interface BookmarkFolder {
  kind: 'folder'
  id: string
  name: string
  collapsed?: boolean // folders start expanded; this is only written once one is collapsed
  notes: string[]
}
export interface BookmarkNote {
  kind: 'note'
  path: string
}
export type BookmarkItem = BookmarkNote | BookmarkFolder

export interface Config {
  sidebarWidth: number // pixels
  sidebarCollapsed: boolean
  lastOpenNote: string | null
  bottomPanelHeightPercent: number
  bottomPanelCollapsed: boolean
  sidebarTab: 'files' | 'bookmarks' | 'recent'
  recentNotes?: string[] // paths of recently opened notes, most recent first; only written once one is visited
  bottomTab: 'global' | 'notebook' | 'note' // the variables tab open in the bottom panel
  rightPanelWidth: number // pixels
  rightPanelCollapsed: boolean
  rightPanelTab?: 'blocks' | 'links' | 'info' // which tab the right panel shows; defaults to blocks
  // Appearance settings (SettingsPage.vue, appearance.ts). Each is only written once it's
  // changed; a missing one means the default.
  theme?: 'system' | 'dark' | 'light' // defaults to system
  accentColor?: string // a #rrggbb colour; the default green when missing
  font?: 'default' | 'system' | 'serif' | 'mono'
  defaultNoteWidth?: 'small' | 'medium' | 'large' // for notes that haven't set their own
  showTitleByDefault?: boolean // for notes that haven't set their own; true when missing
  // Connection and storage settings (SettingsPage.vue, notebookSettings.ts). Each is only
  // written once it's changed; a missing one means the default. A folder is a notebook-
  // relative path, '' for the top level.
  dailyNoteFolder?: string
  dailyNoteFormat?: string // e.g. yyyy-MM-dd
  dailyTemplateEnabled?: boolean // a new daily note starts as a copy of dailyTemplate's content
  dailyTemplate?: string // the template note's name (title, not path)
  weeklyNoteFolder?: string
  weeklyNoteFormat?: string // e.g. yyyy-[W]WW
  weeklyTemplateEnabled?: boolean
  weeklyTemplate?: string
  attachmentsFolder?: string // where pasted images are saved
  autosaveDelayMs?: number // how long after the last edit a note is saved
  stalenessCheckSeconds?: number // how often the server is asked whether the notebook changed
  // Editor settings (SettingsPage.vue). Each is only written once it's changed.
  enterBehavior?: 'split' | 'newline' // what Enter does in a block (Shift+Enter does the other); split when missing
  autoPairBrackets?: boolean // typing ( [ { adds the closing one; true when missing
  linkSuggestImages?: boolean // images in the [[ autocomplete; true when missing
  linkSuggestPdfs?: boolean // PDFs in the [[ autocomplete; true when missing
  // Notes and notebook settings (SettingsPage.vue). Each is only written once it's changed.
  trashRetentionDays?: number // trash entries older than this are deleted by the server; kept forever when missing
  newNoteFolder?: string // where a new note goes; '' (the top level) when missing
  confirmDelete?: boolean // ask before deleting a note or folder; true when missing
  showImagesInTree?: boolean // images in the file tree; true when missing
  showPdfsInTree?: boolean // PDFs in the file tree; true when missing
  // Variables and formulas settings (SettingsPage.vue). Each is only written once it's changed.
  numberDecimals?: number // numbers are rounded to this many decimals; 1 when missing
  dateFormat?: string // how dates are shown (formatDate tokens); yyyy-MM-dd when missing
  timeFormat?: '24h' | '12h' // how times are shown; 24h when missing
  firstDayOfWeek?: 'monday' | 'sunday' | 'saturday' // which day weeks start on (week numbers in the weekly note); monday when missing
  variables?: Variable[] // the notebook variables; only written once one is added
  bookmarkOrder?: BookmarkItem[] // the Bookmarks tab's items (and the complete set of bookmarked notes), top-level order
  layout?: SavedLayout // the panes and the notes in them; see layout.ts
}

// One line of the sidebar tree.
export interface SidebarRow {
  kind: 'folder' | 'note' | 'image' | 'pdf' | 'script'
  path: string
  label: string
  depth: number
}

// Which note's pane a block or table menu was opened from, so the menu acts on that
// note and that pane's selection no matter which pane is focused.
export interface MenuContext {
  path: string
  selectedIds: string[] // blocks Ctrl+clicked in that pane when the menu opened
  clearSelection: () => void
  // Takes these hooked blocks out of the flow where they are on screen (only that
  // pane can measure where that is).
  unhook: (blockIds: string[]) => void
  // Puts this block into edit mode with the cursor in it.
  edit: (blockId: string) => void
}
