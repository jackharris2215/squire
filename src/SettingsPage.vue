<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { SERVER_URL, reloadPage } from './api'
import { askConfirm } from './dialog'
import { ACCENT_PRESETS, DEFAULT_ACCENT, FONTS, NOTE_WIDTHS, THEMES } from './appearance'
import {
  AUTOSAVE_SECONDS_RANGE,
  DECIMALS_RANGE,
  DEFAULT_ATTACHMENTS_FOLDER,
  DEFAULT_DATE_FORMAT,
  DEFAULT_DECIMALS,
  DEFAULT_AUTOSAVE_MS,
  DEFAULT_DAILY_FOLDER,
  DEFAULT_DAILY_FORMAT,
  DEFAULT_STALENESS_CHECK_SECONDS,
  DEFAULT_WEEKLY_FOLDER,
  DEFAULT_WEEKLY_FORMAT,
  FIRST_DAYS,
  SETTING_KEYS,
  STALENESS_SECONDS_RANGE,
  checkDateFormat,
  checkFolder,
  checkNoteNameFormat,
  checkSeconds,
  checkTemplateName,
  checkWholeNumber,
  folderOrDefault,
  formatDate,
  normalizeFolder,
} from './notebookSettings'
import { settingsOpen } from './overlay'
import RightPanelToggle from './RightPanelToggle.vue'
import SettingField from './SettingField.vue'
import { config, defaultConfig, queueConfigSave, replaceConfig } from './store'
import { formatDateValue, formatNumber, formatTimeValue } from './variables'
import type { Config } from './types'

// The settings page: takes the editor's place while it is open (the notes stay open
// underneath). Each setting is written to the config once it's changed.

const theme = computed(() => config.value.theme ?? 'system')
const accent = computed(() => (config.value.accentColor ?? DEFAULT_ACCENT).toLowerCase())
const font = computed(() => config.value.font ?? 'default')
const defaultWidth = computed(() => config.value.defaultNoteWidth ?? 'small')
const showTitle = computed({
  get: () => config.value.showTitleByDefault !== false,
  set: (value: boolean) => change({ showTitleByDefault: value }),
})

function change(values: Partial<Config>) {
  Object.assign(config.value, values)
  queueConfigSave()
}

function close() {
  settingsOpen.value = false
}

// --- The section list on the left: it stays put while the settings scroll, lights the
// section being read (from the scroll position alone), and scrolls to one when clicked. ---

const SECTIONS = [
  { id: 'connection', label: 'Connection and storage' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'editor', label: 'Editor' },
  { id: 'notes', label: 'Notes and notebook' },
  { id: 'variables', label: 'Variables and formulas' },
  { id: 'data', label: 'Data' },
] as const

const scrollEl = ref<HTMLElement | null>(null)
const sectionEls: Record<string, HTMLElement | null> = {}
const activeSection = ref<string>(SECTIONS[0].id)

// Only scrolls: the highlight is set by updateActive as the page moves, so a click
// shows nothing until the scroll gets there (and doesn't fight it on the way).
function scrollToSection(id: string) {
  sectionEls[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// The last section whose top has reached the top of the scroll area; at the very bottom
// it's the last one, since a short last section can't be scrolled up to the top.
function updateActive() {
  const box = scrollEl.value
  if (!box) return
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) {
    activeSection.value = SECTIONS.at(-1)!.id
    return
  }
  const top = box.getBoundingClientRect().top + 24
  let current: string = SECTIONS[0].id
  for (const section of SECTIONS) {
    const el = sectionEls[section.id]
    if (el && el.getBoundingClientRect().top <= top) current = section.id
  }
  activeSection.value = current
}

onMounted(() => nextTick(updateActive))

// --- Connection and storage ---

// Where the app is talking to: the address it was loaded from (the server also serves
// the app), and what the server says about the notebook it has open.
const serverAddress = SERVER_URL || window.location.origin
const serverReachable = ref<boolean | null>(null)
const serverInfo = ref<{ notebook: string; config: string } | null>(null)

onMounted(async () => {
  try {
    const res = await fetch(`${SERVER_URL}/server-info`)
    serverReachable.value = true
    if (res.ok) serverInfo.value = await res.json()
  } catch {
    serverReachable.value = false
  }
})

// A folder setting is shown as typed, with "/" for the top level of the notebook.
function folderShown(value: string | undefined, fallback: string) {
  const folder = folderOrDefault(value, fallback)
  return folder === '' ? '/' : folder
}

const dailyFolder = computed(() => folderShown(config.value.dailyNoteFolder, DEFAULT_DAILY_FOLDER))
const dailyFormat = computed(() => config.value.dailyNoteFormat ?? DEFAULT_DAILY_FORMAT)
const dailyTemplateEnabled = computed({
  get: () => !!config.value.dailyTemplateEnabled,
  set: (value: boolean) => change({ dailyTemplateEnabled: value }),
})
const dailyTemplate = computed(() => config.value.dailyTemplate ?? '')
const weeklyFolder = computed(() => folderShown(config.value.weeklyNoteFolder, DEFAULT_WEEKLY_FOLDER))
const weeklyFormat = computed(() => config.value.weeklyNoteFormat ?? DEFAULT_WEEKLY_FORMAT)
const weeklyTemplateEnabled = computed({
  get: () => !!config.value.weeklyTemplateEnabled,
  set: (value: boolean) => change({ weeklyTemplateEnabled: value }),
})
const weeklyTemplate = computed(() => config.value.weeklyTemplate ?? '')
const attachmentsFolder = computed(() => folderShown(config.value.attachmentsFolder, DEFAULT_ATTACHMENTS_FOLDER))
const autosaveSeconds = computed(() => String((config.value.autosaveDelayMs ?? DEFAULT_AUTOSAVE_MS) / 1000))
const stalenessSeconds = computed(() => String(config.value.stalenessCheckSeconds ?? DEFAULT_STALENESS_CHECK_SECONDS))

// --- Editor ---

const enterBehavior = computed(() => config.value.enterBehavior ?? 'split')
const autoPair = computed({
  get: () => config.value.autoPairBrackets !== false,
  set: (value: boolean) => change({ autoPairBrackets: value }),
})
const suggestImages = computed({
  get: () => config.value.linkSuggestImages !== false,
  set: (value: boolean) => change({ linkSuggestImages: value }),
})
const suggestPdfs = computed({
  get: () => config.value.linkSuggestPdfs !== false,
  set: (value: boolean) => change({ linkSuggestPdfs: value }),
})

// --- Notes and notebook ---

const TRASH_CHOICES = [
  { days: undefined, label: 'Keep forever' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const

const newNoteFolder = computed(() => folderShown(config.value.newNoteFolder, ''))
const confirmDelete = computed({
  get: () => config.value.confirmDelete !== false,
  set: (value: boolean) => change({ confirmDelete: value }),
})
const showImages = computed({
  get: () => config.value.showImagesInTree !== false,
  set: (value: boolean) => change({ showImagesInTree: value }),
})
const showPdfs = computed({
  get: () => config.value.showPdfsInTree !== false,
  set: (value: boolean) => change({ showPdfsInTree: value }),
})

// --- Variables and formulas ---

const decimals = computed(() => String(config.value.numberDecimals ?? DEFAULT_DECIMALS))
const dateFormat = computed(() => config.value.dateFormat ?? DEFAULT_DATE_FORMAT)
const timeFormat = computed(() => config.value.timeFormat ?? '24h')
const firstDay = computed(() => config.value.firstDayOfWeek ?? 'monday')
const checkDecimals = (value: string) => checkWholeNumber(value, DECIMALS_RANGE)

// What the formats look like right now, from today's date, a time and a number.
const todayIso = (() => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
})()

// --- Data: the settings file, and the notebook folder ---

const dataMessage = ref<{ text: string; error: boolean } | null>(null)
const importInput = ref<HTMLInputElement | null>(null)

function say(text: string, error = false) {
  dataMessage.value = { text, error }
}

// Everything in the settings file: the settings, and also the bookmarks, notebook
// variables, panel sizes and which notes are open.
function exportConfig() {
  const blob = new Blob([JSON.stringify(config.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'squire-config.json'
  link.click()
  URL.revokeObjectURL(url)
  say('Exported to squire-config.json in your downloads.')
}

async function onImportChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // so choosing the same file again still fires @change
  if (!file) return

  let imported: unknown
  try {
    imported = JSON.parse(await file.text())
  } catch {
    return say('That file is not valid JSON.', true)
  }
  if (!imported || typeof imported !== 'object' || Array.isArray(imported)) return say('That file is not a settings file.', true)

  const confirmed = await askConfirm({
    title: 'Import settings',
    message:
      'Replace everything in the settings file (settings, bookmarks, notebook variables and which notes are open) with this file\'s? The app reloads afterwards.',
    confirmLabel: 'Import',
  })
  if (!confirmed) return

  // The save counter belongs to this notebook, not to the file.
  const { lastSaved: _lastSaved, sidebarWidthPercent: _old, ...values } = imported as Record<string, unknown>
  const ok = await replaceConfig({ ...defaultConfig(), ...values } as Config)
  if (ok) reloadPage()
  else say('The server did not accept the settings.', true)
}

// Only the settings on this page; bookmarks, notebook variables and the open notes stay.
async function resetSettings() {
  const confirmed = await askConfirm({
    title: 'Reset settings',
    message: 'Put every setting on this page back to its default? Bookmarks, notebook variables and your open notes are kept.',
    confirmLabel: 'Reset',
  })
  if (!confirmed) return
  const next: Record<string, unknown> = { ...config.value }
  for (const key of SETTING_KEYS) delete next[key]
  say((await replaceConfig(next as unknown as Config)) ? 'Settings reset.' : 'The server did not accept the change.', false)
}

async function openNotebookFolder() {
  try {
    const res = await fetch(`${SERVER_URL}/open-notebook`, { method: 'POST' })
    const data = await res.json()
    say(res.ok ? 'Opened the notebook folder on the server\'s machine.' : (data.error ?? 'Could not open the folder.'), !res.ok)
  } catch {
    say('Cannot reach the server.', true)
  }
}

const checkDailyFormat = (value: string) => checkNoteNameFormat(value, false)
const checkWeeklyFormat = (value: string) => checkNoteNameFormat(value, true)
const checkAutosave = (value: string) => checkSeconds(value, AUTOSAVE_SECONDS_RANGE)
const checkStaleness = (value: string) => checkSeconds(value, STALENESS_SECONDS_RANGE)
</script>

<template>
  <section class="settings-page">
    <header class="settings-header">
      <button class="icon-button" title="Close settings" aria-label="Close settings" @click="close">✕</button>
      <h1 class="settings-title">Settings</h1>
      <RightPanelToggle class="settings-right" />
    </header>
    <div class="settings-body">
      <nav class="settings-nav" aria-label="Settings sections">
        <button
          v-for="section in SECTIONS"
          :key="section.id"
          class="nav-item"
          :class="{ active: activeSection === section.id }"
          @click="scrollToSection(section.id)"
        >{{ section.label }}</button>
      </nav>
      <div ref="scrollEl" class="settings-scroll scroll-area" @scroll.passive="updateActive">
        <div class="settings-content">
          <section :ref="(el) => (sectionEls['connection'] = el as HTMLElement | null)" class="settings-block">
            <h2 class="settings-section">Connection and storage</h2>
        <div class="setting">
          <label class="setting-label">Server</label>
          <dl class="info">
            <dt>Address</dt>
            <dd>{{ serverAddress }}</dd>
            <dt>Status</dt>
            <dd :class="{ bad: serverReachable === false }">
              {{ serverReachable === null ? 'Checking…' : serverReachable ? 'Connected' : 'Cannot reach the server' }}
            </dd>
            <template v-if="serverInfo">
              <dt>Notebook</dt>
              <dd>{{ serverInfo.notebook }}</dd>
              <dt>Settings file</dt>
              <dd>{{ serverInfo.config }}</dd>
            </template>
          </dl>
          <p class="setting-hint">Set when the server starts (see the README); they can't be changed from here.</p>
        </div>

        <div class="setting">
          <label class="setting-label">Daily note folder</label>
          <SettingField
            :model-value="dailyFolder"
            :validate="checkFolder"
            :can-reset="dailyFolder !== DEFAULT_DAILY_FOLDER"
            @commit="change({ dailyNoteFolder: normalizeFolder($event) })"
            @reset="change({ dailyNoteFolder: undefined })"
          />
          <label class="setting-label sub-label">Daily note name</label>
          <SettingField
            :model-value="dailyFormat"
            :validate="checkDailyFormat"
            :can-reset="dailyFormat !== DEFAULT_DAILY_FORMAT"
            @commit="change({ dailyNoteFormat: $event })"
            @reset="change({ dailyNoteFormat: undefined })"
          />
          <p class="setting-hint">
            Today: {{ formatDate(dailyFormat) }}. Use yyyy, MM, dd (also yy, MMMM, MMM, M, dddd, ddd, d);
            text in [brackets] is kept as written. Use / for the top level of the notebook.
          </p>
          <label class="setting-check check-gap">
            <input v-model="dailyTemplateEnabled" type="checkbox" class="checkbox" />
            Start from a template
          </label>
          <template v-if="dailyTemplateEnabled">
            <label class="setting-label sub-label">Template note</label>
            <SettingField
              :model-value="dailyTemplate"
              :validate="checkTemplateName"
              :can-reset="!!dailyTemplate"
              placeholder="Daily Template"
              @commit="change({ dailyTemplate: $event })"
              @reset="change({ dailyTemplate: undefined })"
            />
            <p class="setting-hint">A new daily note starts as a copy of this note's content (not its name).</p>
          </template>
        </div>

        <div class="setting">
          <label class="setting-label">Weekly note folder</label>
          <SettingField
            :model-value="weeklyFolder"
            :validate="checkFolder"
            :can-reset="weeklyFolder !== DEFAULT_WEEKLY_FOLDER"
            @commit="change({ weeklyNoteFolder: normalizeFolder($event) })"
            @reset="change({ weeklyNoteFolder: undefined })"
          />
          <label class="setting-label sub-label">Weekly note name</label>
          <SettingField
            :model-value="weeklyFormat"
            :validate="checkWeeklyFormat"
            :can-reset="weeklyFormat !== DEFAULT_WEEKLY_FORMAT"
            @commit="change({ weeklyNoteFormat: $event })"
            @reset="change({ weeklyNoteFormat: undefined })"
          />
          <p class="setting-hint">
            This week: {{ formatDate(weeklyFormat, new Date(), true) }}. Like the daily name, plus WW or W for the
            ISO week number (yyyy is that week's year).
          </p>
          <label class="setting-check check-gap">
            <input v-model="weeklyTemplateEnabled" type="checkbox" class="checkbox" />
            Start from a template
          </label>
          <template v-if="weeklyTemplateEnabled">
            <label class="setting-label sub-label">Template note</label>
            <SettingField
              :model-value="weeklyTemplate"
              :validate="checkTemplateName"
              :can-reset="!!weeklyTemplate"
              placeholder="Weekly Template"
              @commit="change({ weeklyTemplate: $event })"
              @reset="change({ weeklyTemplate: undefined })"
            />
            <p class="setting-hint">A new weekly note starts as a copy of this note's content (not its name).</p>
          </template>
        </div>

        <div class="setting">
          <label class="setting-label">Pasted image folder</label>
          <SettingField
            :model-value="attachmentsFolder"
            :validate="checkFolder"
            :can-reset="attachmentsFolder !== DEFAULT_ATTACHMENTS_FOLDER"
            @commit="change({ attachmentsFolder: normalizeFolder($event) })"
            @reset="change({ attachmentsFolder: undefined })"
          />
          <p class="setting-hint">Where images pasted into a note are saved. Images already there stay where they are.</p>
        </div>

        <div class="setting">
          <label class="setting-label">Autosave delay (seconds)</label>
          <SettingField
            narrow
            :model-value="autosaveSeconds"
            :validate="checkAutosave"
            :can-reset="config.autosaveDelayMs !== undefined"
            @commit="change({ autosaveDelayMs: Math.round(Number($event) * 1000) })"
            @reset="change({ autosaveDelayMs: undefined })"
          />
          <p class="setting-hint">How long after you stop typing a note is saved. Takes effect on the next edit.</p>
        </div>

        <div class="setting">
          <label class="setting-label">Backup check for outside changes every (seconds)</label>
          <SettingField
            narrow
            :model-value="stalenessSeconds"
            :validate="checkStaleness"
            :can-reset="config.stalenessCheckSeconds !== undefined"
            @commit="change({ stalenessCheckSeconds: Number($event) })"
            @reset="change({ stalenessCheckSeconds: undefined })"
          />
          <p class="setting-hint">Changes made elsewhere (the API, another window) show up live. This is a slower backup check for any the live connection missed, such as while the device was asleep.</p>
        </div>
          </section>

          <section :ref="(el) => (sectionEls['appearance'] = el as HTMLElement | null)" class="settings-block">
            <h2 class="settings-section">Appearance</h2>
        <div class="setting">
          <label class="setting-label">Theme</label>
          <div class="segmented">
            <button
              v-for="t in THEMES"
              :key="t.value"
              class="segment"
              :class="{ active: theme === t.value }"
              @click="change({ theme: t.value })"
            >{{ t.label }}</button>
          </div>
        </div>

        <div class="setting">
          <label class="setting-label">Accent color</label>
          <div class="accent-row">
            <button
              v-for="a in ACCENT_PRESETS"
              :key="a.value"
              class="swatch"
              :class="{ active: accent === a.value }"
              :style="{ background: a.value }"
              :title="a.label"
              :aria-label="a.label"
              @click="change({ accentColor: a.value })"
            />
            <input
              type="color"
              class="color-input"
              title="Pick a color"
              aria-label="Pick a color"
              :value="accent"
              @input="change({ accentColor: ($event.target as HTMLInputElement).value })"
            />
            <button v-if="accent !== DEFAULT_ACCENT" class="settings-apply" @click="change({ accentColor: DEFAULT_ACCENT })">Reset</button>
          </div>
        </div>

        <div class="setting">
          <label class="setting-label">Font</label>
          <div class="segmented">
            <button
              v-for="f in FONTS"
              :key="f.value"
              class="segment"
              :class="{ active: font === f.value }"
              :style="f.stack ? { fontFamily: f.stack } : {}"
              @click="change({ font: f.value })"
            >{{ f.label }}</button>
          </div>
        </div>

        <div class="setting">
          <label class="setting-label">Default note width</label>
          <div class="segmented">
            <button
              v-for="w in NOTE_WIDTHS"
              :key="w.value"
              class="segment"
              :class="{ active: defaultWidth === w.value }"
              @click="change({ defaultNoteWidth: w.value })"
            >{{ w.label }}</button>
          </div>
          <p class="setting-hint">For notes that haven't set their own width.</p>
        </div>

        <div class="setting">
          <label class="setting-check">
            <input v-model="showTitle" type="checkbox" class="checkbox" />
            Show the title by default
          </label>
          <p class="setting-hint">For notes that haven't set their own.</p>
        </div>
          </section>

          <section :ref="(el) => (sectionEls['editor'] = el as HTMLElement | null)" class="settings-block">
            <h2 class="settings-section">Editor</h2>

            <div class="setting">
              <label class="setting-label">Enter key</label>
              <div class="segmented">
                <button
                  class="segment"
                  :class="{ active: enterBehavior === 'split' }"
                  @click="change({ enterBehavior: 'split' })"
                >Splits the block</button>
                <button
                  class="segment"
                  :class="{ active: enterBehavior === 'newline' }"
                  @click="change({ enterBehavior: 'newline' })"
                >Adds a new line</button>
              </div>
              <p class="setting-hint">Shift+Enter does the other one. Lists still continue on Enter either way.</p>
            </div>

            <div class="setting">
              <label class="setting-check">
                <input v-model="autoPair" type="checkbox" class="checkbox" />
                Auto-pair brackets
              </label>
              <p class="setting-hint">
                Typing ( [ or { adds the closing one, so [[ becomes [[]] with the link list open. Typing the closing
                one steps over it, and Backspace removes an empty pair.
              </p>
            </div>

            <div class="setting">
              <label class="setting-label">Link autocomplete (after typing [[)</label>
              <label class="setting-check">
                <input v-model="suggestImages" type="checkbox" class="checkbox" />
                Include images
              </label>
              <label class="setting-check check-gap">
                <input v-model="suggestPdfs" type="checkbox" class="checkbox" />
                Include PDFs
              </label>
              <p class="setting-hint">Notes are always included. This doesn't change Ctrl+P.</p>
            </div>
          </section>

          <section :ref="(el) => (sectionEls['notes'] = el as HTMLElement | null)" class="settings-block">
            <h2 class="settings-section">Notes and notebook</h2>

            <div class="setting">
              <label class="setting-label">Empty the trash</label>
              <div class="segmented">
                <button
                  v-for="choice in TRASH_CHOICES"
                  :key="choice.label"
                  class="segment"
                  :class="{ active: config.trashRetentionDays === choice.days }"
                  @click="change({ trashRetentionDays: choice.days })"
                >{{ choice.label }}</button>
              </div>
              <p class="setting-hint">
                Deleted notes and folders sit in the notebook's .trash folder. With a limit set, the server permanently
                deletes entries older than that, when it starts, hourly, and when you change this.
              </p>
            </div>

            <div class="setting">
              <label class="setting-label">Folder for new notes</label>
              <SettingField
                :model-value="newNoteFolder"
                :validate="checkFolder"
                :can-reset="newNoteFolder !== '/'"
                @commit="change({ newNoteFolder: normalizeFolder($event) })"
                @reset="change({ newNoteFolder: undefined })"
              />
              <p class="setting-hint">Where New Note puts a note. / is the top level of the notebook; the folder is made if it's missing.</p>
            </div>

            <div class="setting">
              <label class="setting-check">
                <input v-model="confirmDelete" type="checkbox" class="checkbox" />
                Ask before deleting
              </label>
              <p class="setting-hint">For notes and folders. They go to the trash either way.</p>
            </div>

            <div class="setting">
              <label class="setting-label">Files in the file tree</label>
              <label class="setting-check">
                <input v-model="showImages" type="checkbox" class="checkbox" />
                Show images
              </label>
              <label class="setting-check check-gap">
                <input v-model="showPdfs" type="checkbox" class="checkbox" />
                Show PDFs
              </label>
              <p class="setting-hint">Hidden files are still in the notebook and still work in [[links]], Ctrl+P and search.</p>
            </div>
          </section>

          <section :ref="(el) => (sectionEls['variables'] = el as HTMLElement | null)" class="settings-block">
            <h2 class="settings-section">Variables and formulas</h2>

            <div class="setting">
              <label class="setting-label">Number rounding (decimals)</label>
              <SettingField
                narrow
                :model-value="decimals"
                :validate="checkDecimals"
                :can-reset="config.numberDecimals !== undefined"
                @commit="change({ numberDecimals: Number($event) })"
                @reset="change({ numberDecimals: undefined })"
              />
              <p class="setting-hint">Numbers are shown rounded to this many decimals, without trailing zeros: 3.14159 shows as {{ formatNumber(3.14159) }}.</p>
            </div>

            <div class="setting">
              <label class="setting-label">Date format</label>
              <SettingField
                :model-value="dateFormat"
                :validate="checkDateFormat"
                :can-reset="dateFormat !== DEFAULT_DATE_FORMAT"
                @commit="change({ dateFormat: $event })"
                @reset="change({ dateFormat: undefined })"
              />
              <p class="setting-hint">
                Today: {{ formatDateValue(todayIso) }}. Uses the same letters as the daily note name (yyyy, MM, dd, MMMM, dddd and so
                on; text in [brackets] is kept). Only changes how dates are shown, not how they are stored.
              </p>
            </div>

            <div class="setting">
              <label class="setting-label">Time format</label>
              <div class="segmented">
                <button class="segment" :class="{ active: timeFormat === '24h' }" @click="change({ timeFormat: '24h' })">24 hour</button>
                <button class="segment" :class="{ active: timeFormat === '12h' }" @click="change({ timeFormat: '12h' })">12 hour</button>
              </div>
              <p class="setting-hint">Now: {{ formatTimeValue('14:30') }} is how 14:30 shows.</p>
            </div>

            <div class="setting">
              <label class="setting-label">First day of the week</label>
              <div class="segmented">
                <button
                  v-for="day in FIRST_DAYS"
                  :key="day.value"
                  class="segment"
                  :class="{ active: firstDay === day.value }"
                  @click="change({ firstDayOfWeek: day.value })"
                >{{ day.label }}</button>
              </div>
              <p class="setting-hint">
                Decides the week number in the weekly note's name: with Monday, week 1 is the one with the year's first Thursday
                (ISO); with Sunday or Saturday it is the one with January 1. This week: {{ formatDate(weeklyFormat, new Date(), true, firstDay) }}.
                Changing it can make the weekly note for the current week a different note.
              </p>
            </div>
          </section>

          <section :ref="(el) => (sectionEls['data'] = el as HTMLElement | null)" class="settings-block">
            <h2 class="settings-section">Data</h2>

            <div class="setting">
              <label class="setting-label">Settings file</label>
              <div class="button-row">
                <button class="data-button" @click="exportConfig">Export…</button>
                <button class="data-button" @click="importInput?.click()">Import…</button>
                <button class="data-button danger" @click="resetSettings">Reset settings</button>
              </div>
              <input ref="importInput" type="file" accept=".json,application/json" class="import-input" @change="onImportChosen" />
              <p class="setting-hint">
                Export saves a copy of everything in the settings file: the settings, bookmarks, notebook variables and which notes are
                open. Import replaces all of it with a file's. Reset puts only the settings on this page back to their defaults.
              </p>
            </div>

            <div class="setting">
              <label class="setting-label">Notebook folder</label>
              <div class="button-row">
                <button class="data-button" @click="openNotebookFolder">Open in file manager</button>
              </div>
              <p class="setting-hint">Opens the folder on the machine the server runs on. It doesn't work from another computer or a container.</p>
            </div>

            <p v-if="dataMessage" class="data-message" :class="{ bad: dataMessage.error }">{{ dataMessage.text }}</p>
          </section>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings-page {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  color: var(--color-text-strong);
}

.settings-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: var(--bar-height);
  padding: 0 0.5rem;
  border-bottom: 1px solid var(--color-border);
}

.settings-right {
  margin-left: auto;
}

.settings-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}

.settings-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* Outside the scrolling part, so it stays where it is. */
.settings-nav {
  flex: 0 0 12rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 1.25rem 0.75rem;
  border-right: 1px solid var(--color-border);
}

.nav-item {
  text-align: left;
  font: inherit;
  font-size: 0.85rem;
  color: var(--color-text);
  background: transparent;
  border: none;
  border-radius: 4px;
  padding: 0.4rem 0.6rem;
  cursor: pointer;
}

.nav-item:hover {
  background: rgb(var(--tint) / 0.08);
}

.nav-item.active {
  color: var(--color-text-strong);
  background: rgb(var(--tint) / 0.1);
}

.settings-scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 1.5rem 1.25rem;
}

/* A narrower section list and less padding on a small screen. */
@media (max-width: 700px) {
  .settings-nav {
    flex-basis: 8rem;
    padding: 1rem 0.4rem;
  }

  .settings-scroll {
    padding: 1rem 0.75rem;
  }
}

.settings-content {
  max-width: 34rem;
  margin: 0 auto;
  padding-bottom: 50vh; /* so the last section can be scrolled up to the top */
}

.settings-block + .settings-block {
  margin-top: 2.5rem;
}

.settings-section {
  margin: 0 0 1rem;
  padding-bottom: 0.4rem;
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text);
  border-bottom: 1px solid var(--color-border);
}

.setting {
  margin-bottom: 1.25rem;
}

.setting-label {
  display: block;
  margin-bottom: 0.4rem;
  font-size: 0.85rem;
  color: var(--color-text-strong);
}

.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.data-button {
  font: inherit;
  font-size: 0.8rem;
  color: var(--color-text-strong);
  background: transparent;
  border: 1px solid var(--color-border-hover);
  border-radius: 6px;
  padding: 0.35rem 0.9rem;
  cursor: pointer;
}

.data-button:hover {
  border-color: var(--color-accent);
}

.data-button.danger {
  color: #e08080;
}

.data-button.danger:hover {
  border-color: #e08080;
}

.import-input {
  display: none;
}

.data-message {
  font-size: 0.8rem;
  color: var(--color-text-strong);
}

.data-message.bad {
  color: #e08080;
}

.check-gap {
  margin-top: 0.4rem;
}

.sub-label {
  margin-top: 0.75rem;
}

.info {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.35rem 1rem;
  margin: 0;
  font-size: 0.8rem;
}

.info dt {
  color: var(--color-text);
  opacity: 0.7;
}

.info dd {
  margin: 0;
  color: var(--color-text-strong);
  word-break: break-all;
}

.info dd.bad {
  color: #e08080;
}

.setting-hint {
  margin: 0.3rem 0 0;
  font-size: 0.75rem;
  color: var(--color-text);
  opacity: 0.6;
}

.setting-check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  cursor: pointer;
}

/* Same look as the note settings menu's checkboxes (Editor.vue). */
.checkbox {
  appearance: none;
  flex-shrink: 0;
  width: 0.9rem;
  height: 0.9rem;
  margin: 0;
  border: 1px solid var(--color-border-hover);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
}

.checkbox:hover {
  border-color: var(--color-accent);
}

.checkbox:checked {
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.accent-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.swatch {
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
}

.swatch.active {
  border-color: var(--color-text-strong);
}

.color-input {
  width: 2rem;
  height: 1.6rem;
  padding: 0;
  background: transparent;
  border: 1px solid var(--color-border-hover);
  border-radius: 4px;
  cursor: pointer;
}
</style>
