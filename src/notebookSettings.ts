// The notebook-related settings (Settings page → Connection and storage): their
// defaults, checks for what the user types, and the date formatting behind the daily
// and weekly note names. No imports from the store, so both it and the settings page
// can use this.

// A note's name is its filename; only these characters ever reach the filesystem, so
// names are safe on every OS without needing to slugify them into something uglier than
// what was typed.
export const NAME_RE = /^[A-Za-z0-9 _()-]+$/

export const DEFAULT_DAILY_FOLDER = 'Daily Notes'
export const DEFAULT_DAILY_FORMAT = 'yyyy-MM-dd'
export const DEFAULT_WEEKLY_FOLDER = 'Weekly Notes'
export const DEFAULT_WEEKLY_FORMAT = 'yyyy-[W]WW'
export const DEFAULT_ATTACHMENTS_FOLDER = 'attachments'
export const DEFAULT_AUTOSAVE_MS = 500
export const DEFAULT_STALENESS_CHECK_SECONDS = 60 // only a safety net: changes normally arrive live (sync.ts)

export const AUTOSAVE_SECONDS_RANGE = { min: 0.2, max: 10 }
export const STALENESS_SECONDS_RANGE = { min: 2, max: 300 }

// --- Folders ---
// A folder setting is a notebook-relative path like "Daily Notes" or "Journal/Daily";
// "/" means the notebook's top level (stored as an empty string).

export function checkFolder(input: string): string | null {
  const value = input.trim()
  if (!value) return 'Enter a folder, or / for the top level of the notebook.'
  if (value === '/') return null
  if (/[\\<>:"|?*]/.test(value)) return 'Folders can\'t contain \\ < > : " | ? or *.'
  const parts = value.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.some((part) => !part.trim())) return 'Folder names can\'t be empty.'
  if (parts.some((part) => part.startsWith('.'))) return 'Folder names can\'t start with a dot.'
  return null
}

// What gets stored for a folder the user typed ('' is the top level).
export function normalizeFolder(input: string): string {
  return input
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((part) => part.trim())
    .join('/')
}

// The folder to use for a setting that may not be set (undefined means the default).
export function folderOrDefault(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : value
}

// --- Dates ---

// Which day a week starts on, and so which week is week 1: with Monday that is ISO
// 8601's rule (week 1 holds the year's first Thursday); with Sunday or Saturday it is the
// week holding January 1. A week's year is the one most of it falls in, so the turn of the
// year lands on the right side of it. (dow is the start day, doy the January date that is
// always in week 1 — the same two numbers moment.js uses.)
export type FirstDay = 'monday' | 'sunday' | 'saturday'

export const FIRST_DAYS = [
  { value: 'monday', label: 'Monday' },
  { value: 'sunday', label: 'Sunday' },
  { value: 'saturday', label: 'Saturday' },
] as const

const WEEK_RULES: Record<FirstDay, { dow: number; doy: number }> = {
  monday: { dow: 1, doy: 4 },
  sunday: { dow: 0, doy: 6 },
  saturday: { dow: 6, doy: 12 },
}

function weekOneStart(year: number, rule: { dow: number; doy: number }): Date {
  const firstWeekDay = 7 + rule.dow - rule.doy // this January date is always in week 1
  const january = new Date(year, 0, firstWeekDay)
  return new Date(year, 0, firstWeekDay - ((7 + january.getDay() - rule.dow) % 7))
}

export function weekInfo(date: Date, firstDay: FirstDay = 'monday'): { year: number; week: number } {
  const rule = WEEK_RULES[firstDay]
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  let year = day.getFullYear()
  if (day >= weekOneStart(year + 1, rule)) year++
  else if (day < weekOneStart(year, rule)) year--
  const days = Math.round((day.getTime() - weekOneStart(year, rule).getTime()) / (24 * 60 * 60 * 1000))
  return { year, week: Math.floor(days / 7) + 1 }
}

// yyyy yy | MMMM MMM MM M | dddd ddd dd d | WW W (week number, by `firstDay`); text in
// [square brackets] is kept as written. For a weekly note (`weekly`), yyyy and yy are the
// week's year rather than the calendar year.
const TOKEN_RE = /\[([^\]]*)\]|yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|WW|W/g

export function formatDate(format: string, date: Date = new Date(), weekly = false, firstDay: FirstDay = 'monday'): string {
  const { year: weekYear, week } = weekInfo(date, firstDay)
  const year = weekly ? weekYear : date.getFullYear()
  const pad = (n: number) => String(n).padStart(2, '0')
  return format.replace(TOKEN_RE, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal
    switch (token) {
      case 'yyyy': return String(year)
      case 'yy': return pad(year % 100)
      case 'MMMM': return date.toLocaleDateString([], { month: 'long' })
      case 'MMM': return date.toLocaleDateString([], { month: 'short' })
      case 'MM': return pad(date.getMonth() + 1)
      case 'M': return String(date.getMonth() + 1)
      case 'dddd': return date.toLocaleDateString([], { weekday: 'long' })
      case 'ddd': return date.toLocaleDateString([], { weekday: 'short' })
      case 'dd': return pad(date.getDate())
      case 'd': return String(date.getDate())
      case 'WW': return pad(week)
      default: return String(week) // 'W'
    }
  })
}

// Whether a format always produces a usable note name. Tried on dates across a year,
// since month and day names change.
export function checkNoteNameFormat(format: string, weekly: boolean): string | null {
  if (!format.trim()) return 'Enter a format.'
  const start = new Date(2026, 0, 1)
  for (let i = 0; i < 366; i += 9) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const name = formatDate(format, date, weekly).trim()
    if (!name) return 'That format makes an empty name.'
    if (!NAME_RE.test(name)) return 'Names can only have letters, numbers, spaces, -, _ and (). Put other text in [brackets] only if it is one of those.'
  }
  return null
}

// --- Timing ---

export function checkSeconds(input: string, range: { min: number; max: number }): string | null {
  const value = Number(input)
  if (!input.trim() || !Number.isFinite(value)) return 'Enter a number of seconds.'
  if (value < range.min || value > range.max) return `Use between ${range.min} and ${range.max} seconds.`
  return null
}

// --- Variables and formulas ---

export const DEFAULT_DATE_FORMAT = 'yyyy-MM-dd' // how a date variable or date formula is shown
export const DEFAULT_DECIMALS = 1 // how many decimals a number is rounded to
export const DECIMALS_RANGE = { min: 0, max: 10 }

export function checkDateFormat(format: string): string | null {
  return format.trim() ? null : 'Enter a format.'
}

export function checkWholeNumber(input: string, range: { min: number; max: number }): string | null {
  const value = Number(input)
  if (!input.trim() || !Number.isInteger(value)) return 'Enter a whole number.'
  if (value < range.min || value > range.max) return `Use between ${range.min} and ${range.max}.`
  return null
}

// --- Resetting ---

// The config's settings, as opposed to what else it holds (the layout, bookmarks, recent
// notes, notebook variables and panel sizes). "Reset settings" removes exactly these.
export const SETTING_KEYS = [
  'theme', 'accentColor', 'font', 'defaultNoteWidth', 'showTitleByDefault',
  'dailyNoteFolder', 'dailyNoteFormat', 'weeklyNoteFolder', 'weeklyNoteFormat', 'attachmentsFolder',
  'autosaveDelayMs', 'stalenessCheckSeconds',
  'enterBehavior', 'autoPairBrackets', 'linkSuggestImages', 'linkSuggestPdfs',
  'trashRetentionDays', 'newNoteFolder', 'confirmDelete', 'showImagesInTree', 'showPdfsInTree',
  'numberDecimals', 'dateFormat', 'timeFormat', 'firstDayOfWeek',
] as const
