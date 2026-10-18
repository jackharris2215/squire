# Squire Notes

("Squire" for short: a personal notes app, the user's little assistant.)

A Vue 3 + Vite note-taking app. Notes are plain text files (custom format, not
markdown) in a "notebook" folder. Left sidebar: file tree + settings. Right
pane: the note editor, built from Notion-style blocks (including custom block
types: button, input, display, checkboxes, image, and later per-block
columns). All settings live in one plain config file.

We're building this incrementally, one small step at a time. Don't jump
ahead and implement features that haven't been asked for yet.

## Running it

- Server: `python server/server.py` (port 8765). By default it serves `notebook/`
  from the project root, resolved relative to the script. The config is a hidden file
  inside the notebook, `.squire-config.json` (excluded from listings and rejected as a
  request path, like the trash; copied once from the old project-folder `config.json`
  if the notebook has none), so a notebook carries its own settings and one mounted folder
  holds everything. Move them, the port or the address with flags or environment variables: `--notebook`/`NOTEBOOK_DIR`,
  `--config`/`CONFIG_PATH`, `--static`/`STATIC_DIR`, `--host`/`HOST`, `--port`/`PORT`.
  It also serves the built frontend (`dist/`, after `npm run build`) for any GET that
  isn't an API route, so the built app and the API are one address and there's no
  server address to set: `SERVER_URL` in `src/api.ts` is empty (same origin) unless
  `VITE_SERVER_URL` is set. It listens on every interface by default (`HOST`, so other
  devices on the LAN can reach it; the startup message prints the LAN address; set
  `HOST=localhost` to keep it to the machine). Authentication is one optional shared
  password, `SQUIRE_PASSWORD` / `--password` (the compose file sets it): with one set,
  every API route (`API_ROUTES` in `server.py`; add new routes there) needs the
  `squire_session` cookie that `POST /login` hands out, and the built frontend files stay
  public so the login page can load. Client side, `checkSession()` runs before anything
  loads and a 401 from `serverWrite()` or the staleness check sets `needsLogin`, which shows
  `LoginScreen.vue`; a correct password reloads the page. It is plain HTTP and one shared
  password, not strong security; don't expose it beyond a trusted network.
- Outside API (for scripts, an LLM): routes under `/api/` in `server.py` (`GET /api/notes`, `GET /api/search`,
  `GET`/`PUT /api/note`, and `GET`/`PUT`/`POST`/`DELETE /api/block`, which find a block by id with `find_block()`,
  hooked or floating, and change it under `WRITE_LOCK` inside `_write()`), separate from the app's own routes and from the password/cookie. They need
  `Authorization: Bearer` with `SQUIRE_API_TOKEN` (read-write) or `SQUIRE_API_READ_TOKEN` (read-only);
  neither set means the API is off (403). `api_role()` checks the token; a write goes through `_write()` like
  any other (so it bumps `lastSaved` and open browsers follow it live, see *Live sync*) but skips the staleness
  check unless the caller passes `&lastSaved=`. Block deletion through it is permanent (not trashed).
  `POST`/`DELETE /api/note` and `/api/folder` create and delete notes and folders; deletes reuse `delete_file()` /
  `delete_folder()` (into `.trash`, never destroyed). `POST /api/move` moves any file or folder (the app's own `move_item()`; links are not rewritten, same as dragging in the app). `GET`/`PUT`/`DELETE /api/variable` read/upsert/delete a notebook or note variable (see *Variables* below). Scripts and schedules (`/script`, `/script-schedule`, `/run`) are not on this outside surface, only the app's own routes. Don't add rename, config or settings routes to it without asking. (`mcp/squire_mcp.py` wraps this API for MCP clients, but it's unmaintained and out of date — don't rely on it reflecting the current routes.)
- Installable as a home-screen app: `public/manifest.webmanifest` (`display: standalone`, so it opens without the browser's address bar), its icons (`public/icon-*.png`, `apple-touch-icon.png`, plain placeholders: a green S on the panel brown), the tags in `index.html` and `public/sw.js` (a pass-through service worker, registered in `main.ts` in production builds, since Chrome on Android wants one with a fetch handler before it offers "Install app"; nothing is cached). Browsers only install a site as a standalone app over HTTPS (or `localhost`); from a plain `http://192.168...` address "Add to Home screen" makes an ordinary bookmark that keeps the address bar.
- Docker: `Dockerfile` (builds the frontend, then runs the server with `NOTEBOOK_DIR=/data/notebook`,
  `HOST=0.0.0.0`) and `docker-compose.yml` (mounts `./notebook` there; port published on
  every interface).
- Client in development: `npm run dev` (Vite), which forwards the API routes to the
  server on port 8765 (`server.proxy` in `vite.config.ts`; target overridable with
  `VITE_PROXY_TARGET`).

## Project layout

Frontend, all in `src/`:

| File | Job |
|------|-----|
| `App.vue` | Layout shell only: left icon rail, sidebar frame (resize handles, settings panel), the right panel (a resizable column, `config.rightPanelWidth` / `rightPanelCollapsed`, toggled by `RightPanelToggle.vue`, a button in the header of the top-right pane (`topRightPaneId()` in `layout.ts`, passed to `Editor.vue` as `rightPanelButton`) and in the settings page's header — there is no right-hand icon rail; its tabs (block browser, links, note info), centered in the header like the sidebar's), the reload popup, and the code that makes sure only one right-click menu is open. |
| `mobile.ts`, `swipe.ts` | Small screens (max-width 700px, the same breakpoint as `base.css` and the other `@media` blocks): the left icon rail and the sidebar (one drawer, so the note gets the whole width) and the right panel are drawers sliding over the note instead of taking room from it (CSS in `App.vue`, with a dim backdrop that closes them). Which one is open is `mobileDrawer` in `mobile.ts` — per session, never the saved `sidebarCollapsed`/`rightPanelCollapsed`, which stay the desktop layout and are shared by every device — and the toggle buttons (`toggleSidebar`, `toggleRightPanel`) switch on `isMobile`. Opening a note or revealing a block closes the drawer. `swipe.ts` opens and closes them by swiping sideways (right: sidebar, left: right panel), ignoring touches that start in a text box, slider, table, anything scrolling sideways, a floating block or a pannable image, and while text is selected. |
| `layout.ts` | The split-view layout tree (panes and splits, each pane showing a note or nothing), which pane has the focus, and the changes to it: `splitPane`, `closePane`, `closePanesShowing`, `remapLayoutPaths`. Also `serializeLayout` / `restoreLayout`: the layout is saved in `config.layout` (watcher in `store.ts`) and restored on startup by `restoreOpenNotes()`, dropping notes that no longer exist. State only otherwise; `store.ts` connects it to notes. |
| `PaneLayout.vue` | Draws the layout: a pane is an `Editor`, a split is its children with draggable dividers. Sets the focused pane on click and passes the editors' menu requests up to `App.vue`. While a note is being dragged (`dragNote.ts`) each pane shows a drop overlay: middle opens the note there, an edge splits the pane (`openInPane` / `openInSplit` in `store.ts`). The drag can start from a sidebar row or from a pane's own header (`Editor.vue`'s title, draggable, with its own drag-image element since the plain title is too faint to use as one); starting it there closes that pane immediately (the same `close` emit as its own close button), so the layout collapses before the drop rather than after — dropped nowhere, the note just stays closed. |
| `Editor.vue` | One pane (preparing for split view): shows either the note at its `path` prop, read from `noteCache`, or — if the path is an image (`isImagePath()`) — that image centered, served straight from the notebook with no cache entry. Keeps its own state (editing, Ctrl mode, `selectedBlockIds`); all of that is note-only, gated on `note` being non-null. Note header (title, gear menu, undo/redo, close) and the block editor: editing keys, two separate Ctrl systems (while editing, Ctrl+Up/Down moves to the block above or below; while not editing, holding Ctrl outlines every block so they can be clicked, box-selected and dragged, and the block menu applies to the selection), block drag-and-drop, rendering. Also draws the note's floating blocks (see *Floating blocks* below). Reports right-clicks upward with a `MenuContext` (its note path, selection, and an `unhook` function that measures where blocks are on screen); it doesn't own menus. |
| `BlockBrowser.vue`, `blockActions.ts` | The right panel's block browser: lists the focused note's blocks: the hooked ones in note order, then an "Unhooked" section with the floating ones front to back. A "Starts With" filter at the top limits both lists to blocks whose content starts with the typed text. Clicking a row selects the block, scrolls to it and brings a floating one to the front; a floating block's row has a Hook back button. Rows drag: within the first list to reorder (the block gets its own row at the gap, `placeBlock()` in `store.ts`), from it into Unhooked to unhook, from Unhooked into the first list to hook back at the gap. The panel can't reach into an editor, so `blockActions.ts` is a small registry (like `insert.ts`): each `Editor` registers `reveal` and `unhook` (which needs the screen), and the focused one is used. |
| `LinksList.vue` | The right panel's Links tab: every note or image the focused note links to with `[[...]]`/`![[...]]`, in first-appearance order, deduplicated by title. A link that doesn't resolve to anything in the notebook is still listed (greyed out) but isn't clickable; a resolved one opens in the focused pane. |
| `NoteInfo.vue` | The right panel's other tab: read-only facts about the focused note (name, location, created/modified, file size, word/character/block count). Counts come from the note itself; created/modified/size come from the server's `/file-info`, re-fetched whenever the open note changes. Which right-panel tab is showing is `config.rightPanelTab` (`App.vue`). |
| `BookmarkList.vue` | The sidebar's Bookmarks tab: `config.bookmarkOrder`'s items, in order — the complete, authoritative set of bookmarks (`toggleBookmark()`, `store.ts`, always keeps it that way), not derived from note content. An item is a note or an organizational folder (`BookmarkFolder`, types.ts — not a real notebook folder, just a way to group bookmarks; starts expanded); a folder's own notes are nested in its `notes` array, not separate top-level entries. Dragging reorders a row, or (for a note) files it into or out of a folder — `fileBookmark()`/`reorderBookmarkFolder()` (`store.ts`) take a `BookmarkBeforeRef` (an identity to land before, not a plain index, so the dragged item's own removal can't throw off the target position) rather than reusing `BlockBrowser.vue`'s simpler same-list gap drag. Dropping on a folder's header (rather than a gap) files into it even while collapsed, since a collapsed folder has no gaps of its own. The Files/Bookmarks/Recent Notes tabs themselves are in `App.vue`; the open tab is `config.sidebarTab`. |
| `RecentNotesList.vue` | The sidebar's Recent Notes tab: notes visited lately, most recent first. `config.recentNotes` (paths only) is updated by a watcher on `selectedFile` in `store.ts` and kept in the config, so it survives a reload; `remapPaths` re-keys it on rename/move like everything else path-based. A path whose note no longer exists is just skipped when shown, not cleaned out of the stored list. |
| `SettingsPage.vue`, `appearance.ts` | The settings page, opened by the gear at the bottom of the left rail (`settingsOpen`, `overlay.ts`). It covers the panes (they stay open underneath, hidden with `v-show`); its ✕, the gear again, or opening any note (`selectFile`/`openInPane`/`openInSplit`) closes it. The page is a fixed section list on the left (it doesn't scroll; the active section follows the scroll position and clicking one scrolls to it — add a section to `SECTIONS` and give it a `sectionEls` ref) beside the scrolling settings: Connection and storage, Appearance, then Editor (optional `Config` fields `enterBehavior` — Enter splits the block or adds a new line, Shift+Enter the other, lists continue on Enter either way —, `autoPairBrackets` — `handleAutoPair`/`handleAutoPairBackspace` in `Editor.vue`, on unless set false; only text blocks, not table cells —, `linkSuggestImages` and `linkSuggestPdfs`, which filter the `[[` autocomplete only, not Ctrl+P). Then Notes and notebook: `trashRetentionDays` (see *Deleting never destroys*), `newNoteFolder` (`createNewNote`), `confirmDelete` (`deleteNote`/`deleteFolder`; the trash is used either way), and `showImagesInTree`/`showPdfsInTree` (the file tree only; hidden files still work in links, Ctrl+P and search). Then Variables and formulas: `numberDecimals` (`formatNumber`), `dateFormat` and `timeFormat` (`formatDateValue`/`formatTimeValue` in `variables.ts`: display only, values are stored as `YYYY-MM-DD` / `HH:MM`) and `firstDayOfWeek` (`weekInfo()` in `notebookSettings.ts`, used for the weekly note's name). Then Data: export/import of the whole config file, reset (`SETTING_KEYS` in `notebookSettings.ts` lists the settings it clears — add new settings there; bookmarks, notebook variables, layout etc. are kept), and the server's `POST /open-notebook` (loopback requests only). `replaceConfig()` in `store.ts` swaps in a whole config and saves it immediately. The Connection and storage section is: read-only server facts (address, status, and the notebook and settings-file locations from the server's `GET /server-info` — they are set when the server starts, not in the app) and editable optional `Config` fields for the daily and weekly note folder and name format (`openDailyNote`/`openWeeklyNote` in `store.ts`; formats like `yyyy-MM-dd` and `yyyy-[W]WW`, formatted by `formatDate()`) and, for each, an optional template (`dailyTemplateEnabled`/`dailyTemplate`, `weeklyTemplateEnabled`/`weeklyTemplate`: a note's name, checked with `checkTemplateName()`; a new daily/weekly note starts as a deep copy of that note's `blocks`/`metadata`/`floating`, by `templateContent()` in `store.ts` — never its name, since a note's title is only ever its filename). A daily note also always gets a `metadata.variables` entry named "Today", type `date`, set to its own date (`withTodayVariable()` in `store.ts`; replaces one of any type a template already had by that name, rather than adding a second one) — weekly notes don't get one, since a week isn't a single date. Then the pasted-image folder (`addImage`), the autosave delay (`autosaveDelayMs`, used by `onEdited`) and the staleness check interval (`stalenessCheckSeconds`, applied live through `setStalenessInterval()` in `api.ts`). Defaults, `NAME_RE` and the input checks are in `notebookSettings.ts`; a folder of `''` is the notebook's top level (shown as `/`); `SettingField.vue` is the one-line editor (commits on Enter/blur if valid, with Reset). Appearance settings are optional `Config` fields (`theme`, `accentColor`, `font`, `defaultNoteWidth`, `showTitleByDefault`), written once changed. `appearance.ts` has the option lists and `startAppearance()`, which applies them: `data-theme` on `<html>`, `--color-accent`/`--color-on-accent` and `--font-app` inline on it. Colours in components must use the variables in `assets/base.css` (`--color-panel`, `--color-rail`, `--color-accent`, `rgb(var(--tint) / alpha)` for faint lines and hover fills), not hard-coded hex or white-alpha, or they won't follow the theme/accent. |
| `ScriptEditor.vue` | What a pane shows for a script (a `.py` file in the notebook): a plain text box (Enter keeps the indentation and adds a level after a colon, Tab and Shift+Tab indent and outdent the selected lines, Ctrl+S saves, Ctrl+Enter runs) drawn over a colored copy of its text from `pythonHighlight.ts` (a small tokenizer, not a parser; the two layers must keep identical font, padding and scroll position, see `syncScroll`), a Run button and the last run's output. All its state is in `store.ts` (see *Scripts* below), so it survives closing the pane. Scripts are listed in the sidebar like PDFs (row kind `'script'`, `scriptList`, `isScriptPath()`; the `+` buttons and the folder menu have *New script*) but are never notes: `buildNoteIndex()` skips them, so they are not in `noteList`, links, Ctrl+P or search. |
| `QuickSwitcher.vue` | Ctrl+P popup that finds a note by name (every typed word must appear in the title) and opens it. Shortcut handled in `App.vue`. |
| `LinkSuggest.vue`, `caret.ts` | The autocomplete list shown at the cursor after typing `[[` in a block (display only), and the helper that finds the cursor's screen position in a textarea. The logic (opening, keys, inserting `Title]]`) is in `Editor.vue`; it only inserts text (`Title]]`, or the image's filename via `imageLinkText()`), link rendering and clicking are `renderBlock`/`onBlockClick`. |
| `noteSearch.ts` | `findNotes()`: the name search shared by Ctrl+P and the `[[` autocomplete. Searches notes (by title) and images (by full filename) together. |
| `VariableList.vue`, `VariableMenu.vue`, `variables.ts` | The variable list shown in the right panel and in widgets' insert menus (two-line rows: type + name, value centered below); a `readonly` mode for the global list (clock-driven `{{Date}}`/`{{Time}}`, no add button, plain text rows). `VariableMenu.vue` is its right-click menu (copy, insert as display/widget, change type, delete) — same open/close-from-parent pattern as `SidebarMenu.vue`. `variables.ts` has the actual variable/formula/widget logic described under *Variables* below. |
| `markdownImport.ts` | `blocksFromMarkdown()`: splits a pasted/imported markdown file into one block per top-level `marked` token (heading, table, list, code block, paragraph), used when importing external markdown as a new note. |
| `format.ts` | `FORMATS`: the Ctrl+B/I/E/Shift+Ctrl+X inline-formatting shortcuts (wrap/unwrap the selection in `**`/`*`/`` ` ``/`~~`), pure text-in-text-out so `Editor.vue` only applies the result. |
| `list.ts` | Parses a block's markdown as a plain bullet list or an all-checkbox list (`isPureChecklist()` etc.) the same way `table.ts` reads a table — only when the whole block is exactly one such list. |
| `uuid.ts` | `randomUUID()`: wraps `crypto.randomUUID()` with a `getRandomValues()` fallback, since the secure-context-only native version is unavailable when the app is reached over plain `http://192.168...`. |
| `FileIcon.vue` | The small note/image/pdf/script/folder icon used in the file tree and search lists. |
| `overlay.ts` | Small shared UI flags that don't belong to one component: `switcherOpen` (Ctrl+P), `settingsOpen`, and `renaming` (which sidebar row is being renamed in place). |
| `main.ts` | App entry point; also registers `public/sw.js` in production builds (see *Installable as a home-screen app* above). |
| `FileTree.vue` | Sidebar tree: new note/folder buttons, nested folders, notes and images (`noteList` + `imageList`, merged and sorted together per folder), collapse, drag-and-drop moves, and renaming in place (the menu's Rename sets `renaming` in `overlay.ts`; the row's name becomes an input; `renameEntry()` in `store.ts` validates and renames). Also registers itself with `locate.ts` (a single-slot registry, like `blockActions.ts`'s) so a note's "Locate in browser" button can expand its ancestor folders and scroll to its row without the editor reaching into the sidebar's DOM directly. |
| `SidebarMenu.vue` | Right-click menu for sidebar notes, images and folders (images get a smaller menu: open variants, rename, delete — no copy). A note's menu has a "Move to" item with a hover submenu listing every folder flat (nested ones aren't indented or nested in the list, just all shown the same) plus "(root)"; picking one calls `moveItem()` (`store.ts`), the same move used by dragging a row onto a folder. |
| `BlockMenus.vue` | Right-click menus inside a note: block settings (alignment, colors, unhook / hook back) and table cell operations. Works on hooked and floating blocks alike (`findAnyBlock`, `allBlocks`). |
| `TableBlock.vue` | Editable grid for a block that is exactly one markdown table. |
| `store.ts` | Shared state and all notebook operations: file/folder/note lists, the note cache, which note is open, config, loading, per-note autosave and save status, create/copy/rename/move/delete. Also `isImagePath()` and `imageList` (images are never cached or tracked for autosave — `ensureLoaded` skips them, the `<img>` tag fetches them directly from the server). |
| `api.ts` | `SERVER_URL`, the write queue `serverWrite()`, and the `lastSaved` / out-of-date state. |
| `ConfirmDialog.vue`, `dialog.ts` | The app's own confirmation popup. Call `askConfirm()` instead of the browser's `confirm()`. |
| `history.ts` | Undo/redo for a note's blocks: per-note snapshot history in memory, typing grouped into steps. Driven from `store.ts`, by path (`canUndoFor(path)`, `undoEdit(path)`); shortcuts and header buttons are in `Editor.vue`. |
| `table.ts` | Parse and serialize markdown tables (via marked). |
| `blocks.ts` | Block color palette, alignment options, `blockStyle()`. |
| `types.ts` | Shared types: `Block`, `FloatingBlock`, `Note`, `Config`, `SidebarRow`, `MenuContext`. |
| `assets/menus.css` | Global styles shared by menus, form controls and icon buttons. Everything else is scoped to its component. |

Backend: `server/server.py`, one file, standard library only. The notebook is the
`notebook/` folder; settings are `.squire-config.json` inside it.

## How the data works

- A note is a JSON file: `{ metadata, blocks }`. There's no separate title field —
  a note's name is its filename (`nameFromPath()`), the same as a folder's name is
  its path segment. `blocks` is rows of blocks (`Block[][]`); more than one block in
  a row means columns. A block has `id`, `type`, `content` (a markdown string), and
  optional `align`, `textColor`, `background`. Older blocks lack the optional
  fields, so a missing value means the default and the field is only written when
  first changed. Never assume they exist.
- Per-note settings live in `metadata` (`showTitle`, `width`: small/medium/large), and a field is only
  written once it's changed. Whether a note is bookmarked is the one exception: it's
  tracked in `config.bookmarkOrder` (also the Bookmarks tab's order and grouping into
  organizational folders — see `BookmarkList.vue`) rather than the note's own
  metadata, specifically so bookmark state is known without loading the note — see
  `isBookmarked()` / `toggleBookmark()` in `store.ts`.
- **Scripts** are Python files in the notebook, but a `.py` file's bytes on disk are actually JSON, `{"script": <code>, ...other metadata}` (`_load_script()`/`read_script()` in `server.py`), so a script can carry metadata (a future schedule, say) alongside its code without a separate sidecar file; a file not yet in that format (plain Python text, from before this existed) is read as `{"script": <that text>}` and upgrades to real JSON on its next save (`put_script()`, which keeps any existing metadata and only replaces `"script"`). Server: `GET`/`PUT /script?path=` read/save a script's code as plain text, unwrapping/wrapping the JSON so callers never see it (`PUT` is a normal `_write()`, so lastSaved and live sync apply); `POST /run?path=` (`run_script()`) pulls the code out, writes it to a temp file (same name, for sensible tracebacks) since the on-disk file isn't valid Python by itself, and runs that as a separate process in the notebook folder with a 60 s limit, returning `{output, exitCode, timedOut}` — it must not hold `WRITE_LOCK` since the script's own writes need it. The child gets `SQUIRE_URL` and `SQUIRE_API_TOKEN` (a random `INTERNAL_TOKEN` made at startup, accepted by `api_role()` from loopback only, and working even when the outside API is off) and finds `server/squire.py` through `PYTHONPATH`. `squire.py` is a standard-library client of the `/api/` routes (like `mcp/squire_mcp.py`): scripts never call server functions directly, so every change they make goes through the same path as any other (trash, lastSaved, live updates). The outside `PUT /api/script` route (see above) also goes through `put_script()`, so it keeps taking plain text in and out, same as before. Client: `scriptCache` (text, dirty flag, save state) and `scriptRuns` (last output) in `store.ts`, saved a moment after each edit (`editScript`/`saveScript`), flushed by `saveAllNotes()`, re-keyed in `remapPaths()`, dropped by `forgetNote()`; a script shown in a pane is refetched after a change made elsewhere unless it has unsaved typing. A script is never named `squire` (it would hide the library). **Scheduling:** a script's `"schedule"` (in its JSON, alongside `"script"`) is `{enabled, nextRun: "YYYY-MM-DDTHH:MM" (local time), repeatEnabled, repeat: {kind: 'time'|'month'|'year', hours, minutes, monthDay, yearMonth, yearDay}}` — `repeat` keeps every kind's fields at once so switching the radio doesn't lose what was typed into the others. `GET`/`PUT /script-schedule?path=` read/write it (the `PUT` also a normal `_write()`). A background thread (`run_due_scripts_every_minute`, started next to the trash-purge one) checks once a minute for an enabled schedule whose `nextRun` has passed, runs it (`fire_schedule()`, under its own short `WRITE_LOCK` separate from the run itself, matching `run_script()`'s own lock requirement), sets `"lastRun"` on the script, and reschedules it per `repeat` (`_compute_next_run()`: `'time'` adds its hours/minutes to the run that just fired; `'month'`/`'year'` advance to the next occurrence of a day-of-month or month/day, clamped to the shortest month, e.g. the 31st becomes the 30th or 28th where that month doesn't have one) — repeatedly, without re-running the script, until the computed time is no longer overdue (so time off doesn't cause a burst of catch-up runs). No repeat turns `enabled` back off, so a one-shot schedule doesn't keep firing. The schedule menu (`Editor.vue`, in the same top-left spot as a note's settings gear) fetches it only while open, not with every script load. Not built yet: running on a note or notebook change.
- **PDFs** are shown like images but simpler: `isPdfPath()` / `pdfList` (`store.ts`) put them in the sidebar tree (row kind `'pdf'`), and a pane showing one (`isPdf` in `Editor.vue`) is just an `<iframe>` of the served file, so the browser's own viewer does the work. They never enter `noteCache`, the note list, link resolution, search or recent notes. Rename (extension kept) and delete work as for images; the server always serves `.pdf` as raw bytes.
- **Image links:** `[[img.jpg]]` is a plain link that opens the image like a note; `![[img.jpg]]` renders it inline, `![[img.jpg|400]]` with a max width of 400px (all in `markdown.ts`). Images match only on full filename (extension included) or notebook path, via `imageIndex` in `store.ts`; a missing image link is never offered for creation as a note. Renaming an image rewrites `[[file.ext]]` and `[[path/file.ext]]` (server `rename_file` + `renameImage`).
- **A formula link**, `[[{{Date}}]]` say — only when the whole bracket content is one `{{formula}}`, not mixed with other text — is resolved before anything else: `resolveLinkFormulas()` (`markdown.ts`) evaluates it exactly like a plain `{{display}}` (`evaluateWidget()`) and splices the result in as the literal title, so the rest of the pipeline (resolve/missing/offer-to-create) runs exactly as if that text had been typed by hand. Left alone (falls through to a missing widget) if the formula can't be evaluated. `LinksList.vue` calls the same function before its own independent `[[...]]` scan, so the Links tab shows the resolved title too.
- **A plain markdown link** (`[text](url)`, unlike a `[[wikilink]]` above) is to somewhere outside the notebook: `markdown.ts` registers a custom `marked` link renderer so it opens in a new tab (`target="_blank"`), and `onBlockClick`/`onCellClick` (`Editor.vue`/`TableBlock.vue`) let the browser handle the click instead of starting to edit the block or cell.
- **Pasting an image** into a block's textarea (`onBlockPaste` in `Editor.vue`) saves it through `addImage()` (`store.ts`) to the pasted-image folder (a setting, `attachments` by default) as `Pasted image <date-time>.<ext>` via the server's `PUT /image` (raw bytes, never overwrites, creates the folder), then inserts `![[name]]` at the cursor.
- **Variables** (text, number, boolean, date, time; names are letters and spaces only, unique per list, checked by `variableProblem()` in `variables.ts`; invalid ones are red and never found). Notebook variables live in `config.variables`, note variables in `metadata.variables`; `findVariable()` looks in the note first, then the notebook, then the read-only global ones (`globalVariables`, computed, never stored). `{{name}}` / `{{a+b*2}}` displays a value or formula (numbers rounded to 1 decimal); a formula can also compare values with `== != > < >= <=` (text compares alphabetically, booleans only with `==`/`!=`) and use `"quoted text"`, `Date(m/d/yyyy)` and `Time(h:mm)` literals (the latter two are rewritten to a marked quoted string before tokenizing, since their own `/`/`:` would otherwise be read as operators), which `evaluateFormula` parses to a `{ kind, value }` of `'number' | 'date' | 'time' | 'text' | 'boolean'` — only the first three take part in `+ - * / % ^`. `{{kind, argument}}` (commas, kind first, e.g. `{{input, score}}`) draws a widget; `{{if, condition, trueValue, falseValue}}` is a separate case in `renderWidget` (not a `WIDGETS` entry, since its first argument is a condition, not a variable) that shows `trueValue` or `falseValue` (each anything a plain `{{display}}` accepts) depending on whether `condition` (`evaluateBoolean`) is true. Widget kinds and the variable types each accepts are listed in `WIDGETS` (`variables.ts`), drawn in `markdown.ts`, and their events handled by `handleWidgetEvent()` (called from `Editor.vue` and `TableBlock.vue`). A widget on a type it doesn't accept shows faded text instead.
- **Floating blocks** (unhooked): `note.floating`, an optional array beside `blocks`, only written while a block is unhooked. Each entry is a normal block plus `x` (px from the middle of the note column, so it holds when the note's width changes), `y` (px from the top of the note), `width` and `z` (higher is in front). "Unhook" and "Hook back" are in the block menu and the block browser (`unhookBlock()` / `hookBlock()` in `store.ts`; unhooking keeps the block where it is on screen, hooking puts it in its own row at the end). A block is in `blocks` or in `floating`, never both, so anything that handles blocks must handle both: use `allBlocks()` / `findAnyBlock()` (`store.ts`) rather than `blocks.flat()` / `findBlockPosition()` unless it really means the hooked ones only. Floating blocks are drawn by `Editor.vue` in a zero-height `.floating-layer` inside `.note` (inside `.blocks-container`, so Ctrl mode, selection and box-select work on them). Editing differs: Enter is a new line (no splitting), Backspace on an empty one deletes it. They move by a grip tab (or the whole block while Ctrl is held) and resize by their right edge; a drag only moves the element and commits once on release, so it is one undo step. A Ctrl selection is all hooked or all floating blocks (whichever was picked first). `z` is left out of undo snapshots (`history.ts`) so clicking a block to the front isn't a step. Dragging a hooked block decides what happens by how far from the note's edge it's dropped: near the middle reorders it (a new row at the nearest gap), near either edge snaps it into a row/column there (`EDGE_ZONE_PX` in `Editor.vue`), and past that band it unhooks the block (and any other blocks dragged with it, keeping their relative layout) at the drop position — see `onBlocksDragOver` / `onFloatDrop` in `Editor.vue`.
- A block that is exactly one markdown table renders as an editable grid. Its
  content stays a markdown string.
- **A note's content loads the first time it's actually opened, not at startup.**
  `loadFiles()` only fetches the notebook's file list (instant, however many notes there
  are); `noteList`/`noteIndex` are built from paths alone (`buildNoteIndex()`,
  `store.ts`), so the sidebar, Ctrl+P and `[[links]]` all work before any note's
  content has been fetched. Opening a note (`selectFile`/`openInPane`/`openInSplit`)
  calls `ensureLoaded()`, which fetches it into `noteCache` only if it isn't there
  yet; `isLoadingPath()` is true in the meantime, which is what shows `Editor.vue`'s
  spinner. Once loaded, a note stays in `noteCache` for the rest of the session — the
  open note is the same object as its cache entry, and the cache is reactive, so a
  pane showing a note by path updates when it loads or changes. Anything that reads
  a note *other than the one it's currently showing* (`copyNote`, say) must call
  `ensureLoaded()` itself first, since that note may never have been opened.
- Paths are notebook-relative and always use `/`, on every OS.

## Rules that are easy to break

- **All changes to the server go through `serverWrite()`** (in `api.ts`). It runs
  them one at a time, and each carries the client's `lastSaved`.
- **Staleness:** the config file holds `lastSaved`, bumped by every notebook change. The
  server refuses a change (HTTP 412) if the client's `lastSaved` is older; the client
  then shows the reload popup and holds all further writes. `PUT /config` is not a
  notebook change and never bumps it.
- **Live sync (changes made elsewhere: the API, another window):** the server's `GET /events`
  is a server-sent-events stream (`_stream_events`, `broadcast()` in `server.py`); `_write()`
  sends every connected window `{type: 'change', lastSaved, notes, tree}` after each change, so a
  new write route passes `notes=[paths whose content changed]` and `tree=True` when files or
  folders came, went or moved. `sync.ts` (`startLiveSync()`, started in `App.vue`) batches the
  events and calls `applyServerChange()` (`store.ts`): it waits for our own writes, skips an
  event whose `lastSaved` we already have (that's our own change, since every write reply
  updates it), refreshes the file list (`refreshFiles()`, which keeps the tree's collapse state;
  an open path that is gone is closed via `forgetNote`), fetches again each note shown in a pane
  (`refreshNote()`: if it differs, `mergeNote()` swaps the server's copy in place, keeping blocks
  with the same id as the same objects, with the note's `quiet` flag set so the autosave watcher
  doesn't take it for an edit; **the server's copy wins** — unsaved edits and the note's undo
  history are dropped) and drops other cached notes so they load afresh. Only then is `lastSaved`
  adopted, so a note we may write is never older than the `lastSaved` we send. The config is
  never refreshed (it holds the layout and our unsaved settings). Missed events (the window
  slept, the stream dropped) are covered by the `hello` event each connection starts with and by
  `startStalenessPolling()` (`api.ts`, `stalenessCheckSeconds`, now a 60 s backup check and on
  window focus), which hands to the same code through `onServerAhead()`. The reload popup is now
  only for a refused write (412), i.e. a real race.
- **A note's name is its filename.** There's no title field to go stale, so a save
  is just a plain write. Renaming (`/rename`, body `{ name }`) is a filesystem
  rename — the same shape as folder rename — plus rewriting `[[links]]` elsewhere in
  the notebook.
- **Panes and the focus:** `selectedFile` (store) is the note in the focused pane;
  `selectFile` opens a note there, `openInSplit` opens one in a new pane. A note shown
  in any pane is tracked for autosave by a watcher in `store.ts` (so showing it twice
  is fine). Only the focused `Editor` reacts to the keyboard; every `Editor` removes its
  window listeners when it unmounts. Deleting a note closes its panes, and moves
  re-key them (`remapLayoutPaths`).
- **Autosave is per tracked note.** A note that is open gets `trackNote(path)` (its own
  watcher, 500 ms timer, save status) and `untrackNote(path)` when
  it's no longer shown; `saveStateFor(path)` feeds the footer. Before a rename or move,
  `saveAllNotes()` flushes everything. Deleting calls `discardPendingSave` first so a
  late save can't recreate the note. `remapTracked` re-keys it with the rest.
- **Notes and folders move by renaming on the server**, then every path the client
  tracks is re-keyed in `remapPaths` (`store.ts`). Add new per-path state there too.
- **Deleting never destroys:** the server moves deleted files and folders into
  `notebook/.trash/<date-time>/<original path>`. The trash is excluded from every listing
  (`notebook_items()`) and rejected as a request path. There is no restore UI yet; recover
  by hand. The only thing that ever removes trash is the optional `trashRetentionDays`
  setting: `purge_trash()` deletes entries older than that (by the date in their folder
  name; folders not named like that are never touched) at startup, hourly and whenever
  the config is saved. Unset, nothing is ever deleted.
- **Undo history is per note, keyed by path.** If you add code that re-keys, removes or
  rewrites notes (move, delete, rename), keep `history.ts` in sync: `remapPaths` calls
  `remapHistories`, `forgetNote` calls `dropHistory`, and `renameNote` clears all
  histories because it rewrites text in other notes. A table operation calls
  `breakUndoStep()` first so it is its own step.
- Server errors come back as `{"error": ...}`; successful changes return the new
  `lastSaved`.

## Testing policy — read this before touching anything

**Do not write or run tests. Do not install any testing framework or
library** (no Vitest, Jest, Playwright, Cypress, @vue/test-utils, etc.).

The user does all visual, UI, and UX testing themselves by running the app
and looking at it. That is the only testing that happens on this project.

The only verification you are allowed to do yourself is:

- Double-check your own work by reading the code back.
- Confirm the project **builds**: `npm run build`.

If the build fails, fix it. Otherwise, stop there and let the user verify
the result visually — don't start the dev server to "check" the UI yourself
unless the user explicitly asks you to.
