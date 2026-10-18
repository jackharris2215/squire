import { computed, ref } from 'vue'
import type { Variable } from './types'
import { config, noteCache, queueConfigSave, runScript } from './store'
import { DEFAULT_DATE_FORMAT, DEFAULT_DECIMALS, formatDate } from './notebookSettings'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// --- Global variables: a third, read-only list beside the notebook's and a note's.
// Each entry is computed fresh from the clock rather than stored anywhere. The clock
// ticks once a minute (good enough for a Date/Time display, and cheap) so a {{Time}}
// left on screen stays current without re-rendering on every render.
const clockTick = ref(Date.now())
setInterval(() => {
  clockTick.value = Date.now()
}, 60_000)

export const globalVariables = computed<Variable[]>(() => {
  const now = new Date(clockTick.value)
  return [
    { name: 'Date', type: 'date', value: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, readonly: true },
    { name: 'Time', type: 'time', value: `${pad(now.getHours())}:${pad(now.getMinutes())}`, readonly: true },
  ]
})

// A variable name is letters (a-z, A-Z) and spaces, nothing else. That keeps names
// clear of the math operators, digits and brackets a {{formula}} is made of, and of
// everything that means something in a link, an embed or a path.
const NAME_RE = /^[A-Za-z ]+$/

// What is wrong with the variable at `index` of `variables`, or null if it's fine.
// Names are unique within one list (a note's, or the notebook's), ignoring case and
// surrounding spaces; the same name in a note and in the notebook is allowed. A
// variable with a problem is shown in red and must be left out of any lookup.
export function variableProblem(variables: Variable[], index: number): string | null {
  const name = variables[index]!.name.trim()
  if (!name) return 'A variable needs a name.'
  if (!NAME_RE.test(name)) return 'Names can only have letters and spaces.'
  const lower = name.toLowerCase()
  if (variables.some((v, i) => i !== index && v.name.trim().toLowerCase() === lower)) {
    return 'Another variable here has the same name.'
  }
  return null
}

// The variable a name refers to, as seen from a note: its own variables are searched
// first, then the notebook's. A variable with a problem is never found. Reads
// reactive state, so anything rendered from it updates when a variable changes.
export function findVariable(name: string, notePath: string | null): Variable | null {
  const lower = name.trim().toLowerCase()
  const noteVariables = (notePath && (noteCache.get(notePath)?.metadata.variables as Variable[] | undefined)) || []
  for (const list of [noteVariables, config.value.variables ?? []]) {
    const index = list.findIndex((v) => v.name.trim().toLowerCase() === lower)
    if (index !== -1 && !variableProblem(list, index)) return list[index]!
  }
  return globalVariables.value.find((v) => v.name.trim().toLowerCase() === lower) ?? null
}

// Numbers are shown rounded to the number of decimals in the settings (one unless
// changed), without trailing zeros.
export function formatNumber(value: number): string {
  return String(Number(value.toFixed(config.value.numberDecimals ?? DEFAULT_DECIMALS)))
}

// A stored date ("YYYY-MM-DD") as the settings' date format shows it.
export function formatDateValue(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  if (!year || !month || !day) return iso
  return formatDate(config.value.dateFormat ?? DEFAULT_DATE_FORMAT, new Date(year, month - 1, day))
}

// A stored time ("HH:MM") as 24 hour, or 12 hour (2:30 PM) if the settings say so.
export function formatTimeValue(text: string): string {
  if (config.value.timeFormat !== '12h') return text
  const [hours, minutes] = text.split(':').map(Number)
  if (hours === undefined || minutes === undefined || Number.isNaN(hours) || Number.isNaN(minutes)) return text
  return `${hours % 12 || 12}:${pad(minutes)} ${hours >= 12 ? 'PM' : 'AM'}`
}

// Functions a formula can call: a name immediately followed by "(", one or more
// comma-separated arguments, and ")". A new function is a new entry here.
const FUNCTIONS: Record<string, (args: number[]) => number> = {
  max: (args) => Math.max(...args),
  min: (args) => Math.min(...args),
  round: (args) => Math.round(args[0]!),
  abs: (args) => Math.abs(args[0]!),
  floor: (args) => Math.floor(args[0]!),
  ceil: (args) => Math.ceil(args[0]!),
}

// A date is stored as "YYYY-MM-DD" and held, for arithmetic, as a day count (so
// adding/subtracting days can't drift across months via local-time rounding); a time
// is stored as "HH:MM" and held as minutes since midnight (wrapped to a day).
const MS_PER_DAY = 86400000

function dateToDays(text: string): number {
  return Math.round(Date.parse(`${text}T00:00:00Z`) / MS_PER_DAY)
}

function daysToDate(days: number): string {
  return new Date(days * MS_PER_DAY).toISOString().slice(0, 10)
}

function timeToMinutes(text: string): number {
  const [hours, minutes] = text.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

function minutesToTime(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`
}

// A formula's running value: a plain number, or a date/time carried as its
// arithmetic form (see above) so + and - can add a count of days/minutes to it; or,
// from a quoted string literal, a text/boolean variable, or a comparison, text or a
// boolean. Only the number/date/time kinds take part in + - * / % ^; the rest only
// ever come from, or go into, a comparison (== != > < >= <=).
type FormulaValue = { kind: 'number' | 'date' | 'time'; value: number } | { kind: 'text'; value: string } | { kind: 'boolean'; value: boolean }

function formatFormulaValue(result: FormulaValue): string {
  if (result.kind === 'date') return formatDateValue(daysToDate(result.value))
  if (result.kind === 'time') return formatTimeValue(minutesToTime(result.value))
  if (result.kind === 'text') return result.value
  if (result.kind === 'boolean') return result.value ? 'true' : 'false'
  return formatNumber(result.value)
}

// Works out what {{expression}} shows, or null if it isn't valid. An expression that
// is just one variable's name shows that variable as it is (a number rounded, text/
// date/time/boolean untouched). Anything else is a formula: numbers, "quoted text",
// Date(m/d/yyyy) and Time(h:mm) literals, variables, + - * / % ^, comparisons
// (== != > < >= <=), parentheses, and calls to FUNCTIONS (max(a, b), say) — plus +
// and - between a date or time (variable or literal) and a plain number (days or
// minutes), and - between two dates or two times (their difference). A variable's
// name in a formula runs up to the next operator, comma or parenthesis, so spaces in
// it are fine.
export function evaluateWidget(expression: string, notePath: string | null): string | null {
  const direct = findVariable(expression, notePath)
  if (direct) {
    if (direct.type === 'number') return formatNumber(Number(direct.value))
    if (direct.type === 'date') return formatDateValue(String(direct.value))
    if (direct.type === 'time') return formatTimeValue(String(direct.value))
    return String(direct.value)
  }
  const result = evaluateFormula(expression, notePath)
  return result === null ? null : formatFormulaValue(result)
}

// The number an expression stands for, for a widget argument: a number variable, a
// plain number or a formula. Null if it isn't one (a text, date or time variable, or a
// formula that resolves to a date/time, say).
export function evaluateNumber(expression: string, notePath: string | null): number | null {
  const direct = findVariable(expression, notePath)
  if (direct) return direct.type === 'number' ? Number(direct.value) : null
  const result = evaluateFormula(expression, notePath)
  return result && result.kind === 'number' ? result.value : null
}

// Whether an expression is true, for the if widget's condition: a boolean variable, or
// a formula that resolves to one (a comparison, almost always). Null if it isn't one.
export function evaluateBoolean(expression: string, notePath: string | null): boolean | null {
  const direct = findVariable(expression, notePath)
  if (direct) return direct.type === 'boolean' ? Boolean(direct.value) : null
  const result = evaluateFormula(expression, notePath)
  return result && result.kind === 'boolean' ? result.value : null
}

// Date(1/15/2026) and Time(14:30): a date or time literal, for comparing against one
// without having to make a variable out of it. Replaced before tokenizing with a
// quoted string carrying a marker prefix atom() recognizes, since the date's own
// slashes would otherwise tokenize as division.
const DATE_LITERAL_RE = /\bdate\s*\(\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*\)/gi
const TIME_LITERAL_RE = /\btime\s*\(\s*(\d{1,2}):(\d{2})\s*\)/gi

function replaceLiterals(expression: string): string {
  return expression
    .replace(DATE_LITERAL_RE, (_match, month, day, year) => `"@date:${year}-${pad(Number(month))}-${pad(Number(day))}"`)
    .replace(TIME_LITERAL_RE, (_match, hours, minutes) => `"@time:${pad(Number(hours))}:${minutes}"`)
}

// The value of a formula (see evaluateWidget), or null if it isn't valid.
function evaluateFormula(expression: string, notePath: string | null): FormulaValue | null {
  const tokens = replaceLiterals(expression).match(
    /"[^"]*"|\d+\.?\d*|\.\d+|==|!=|>=|<=|[+\-*/%^(),<>=!]|[^\d\s+\-*/%^(),.<>=!"][^+\-*/%^(),<>=!]*/g,
  )
  if (!tokens) return null
  let pos = 0

  // comparison := expr ((==|!=|>|<|>=|<=) expr)?
  // expr := term (+|- term)*   term := unary (*|/|% unary)*   unary := -unary | power
  // power := atom (^ unary)?   atom := number | "text" | variable | ( expr )
  const fail = (): never => {
    throw new Error('invalid')
  }
  const asNumber = (value: FormulaValue): number => (value.kind === 'number' ? value.value : fail())

  // A date/time plus or minus a plain number stays that date/time (a count of days or
  // minutes); a date minus a date, or a time minus a time, is the plain number of days
  // or minutes between them. Anything else (adding two dates, a piece of text, or a
  // boolean, say) doesn't mean anything and fails.
  const addSub = (left: FormulaValue, right: FormulaValue, sign: 1 | -1): FormulaValue => {
    if (left.kind === 'text' || left.kind === 'boolean' || right.kind === 'text' || right.kind === 'boolean') return fail()
    if (left.kind === 'number' && right.kind === 'number') return { kind: 'number', value: left.value + sign * right.value }
    if (left.kind !== 'number' && right.kind === 'number') return { kind: left.kind, value: left.value + sign * right.value }
    if (left.kind === 'number' && right.kind !== 'number' && sign === 1) return { kind: right.kind, value: left.value + right.value }
    if (left.kind === right.kind && left.kind !== 'number' && sign === -1) return { kind: 'number', value: left.value - right.value }
    return fail()
  }
  const COMPARATORS = ['==', '!=', '>', '<', '>=', '<='] as const
  // A comparison between two values of the same kind: == and != work on anything,
  // ordering (> < >= <=) on numbers, dates, times (earlier sorts lower) and text
  // (alphabetically), but not on booleans. Comparing different kinds is never equal
  // and never ordered, except == and != between them, which just come out false/true.
  const comparison = (): FormulaValue => {
    const left = expr()
    const op = tokens[pos] as (typeof COMPARATORS)[number] | undefined
    if (!op || !COMPARATORS.includes(op)) return left
    pos++
    const right = expr()
    if (left.kind !== right.kind) {
      if (op === '==') return { kind: 'boolean', value: false }
      if (op === '!=') return { kind: 'boolean', value: true }
      return fail()
    }
    if (op === '==') return { kind: 'boolean', value: left.value === right.value }
    if (op === '!=') return { kind: 'boolean', value: left.value !== right.value }
    if (left.kind === 'boolean') return fail()
    const [l, r] = [left.value, right.value] as [number | string, number | string]
    if (op === '>') return { kind: 'boolean', value: l > r }
    if (op === '<') return { kind: 'boolean', value: l < r }
    return { kind: 'boolean', value: op === '>=' ? l >= r : l <= r }
  }
  const expr = (): FormulaValue => {
    let value = term()
    // The sign has to be read out of `tokens` before `term()` runs for the right-hand
    // side: as a 3rd call argument it would still be read first textually, but JS
    // evaluates arguments left to right, so term() (argument 2) would advance `pos`
    // past the operator before this ternary (argument 3) ever looked at it.
    while (tokens[pos] === '+' || tokens[pos] === '-') {
      const sign = tokens[pos++] === '+' ? 1 : -1
      value = addSub(value, term(), sign)
    }
    return value
  }
  const term = (): FormulaValue => {
    let value = unary()
    while (tokens[pos] === '*' || tokens[pos] === '/' || tokens[pos] === '%') {
      const op = tokens[pos++]
      const left = asNumber(value)
      const right = asNumber(unary())
      value = { kind: 'number', value: op === '*' ? left * right : op === '/' ? left / right : left % right }
    }
    return value
  }
  const unary = (): FormulaValue => {
    if (tokens[pos] === '-') {
      pos++
      return { kind: 'number', value: -asNumber(unary()) }
    }
    if (tokens[pos] === '+') {
      pos++
      return unary()
    }
    const base = atom()
    if (tokens[pos] !== '^') return base
    pos++
    return { kind: 'number', value: asNumber(base) ** asNumber(unary()) }
  }
  const atom = (): FormulaValue => {
    const token = tokens[pos++]
    if (token === undefined) return fail()
    if (token === '(') {
      const value = expr()
      if (tokens[pos++] !== ')') fail()
      return value
    }
    if (token.startsWith('"')) {
      const text = token.slice(1, -1)
      if (text.startsWith('@date:')) return { kind: 'date', value: dateToDays(text.slice(6)) }
      if (text.startsWith('@time:')) return { kind: 'time', value: timeToMinutes(text.slice(6)) }
      return { kind: 'text', value: text }
    }
    if (/^[\d.]/.test(token)) return { kind: 'number', value: Number(token) }
    if (/^(==|!=|>=|<=|[+\-*/%^),<>=!])$/.test(token)) return fail()
    const fn = FUNCTIONS[token.trim().toLowerCase()]
    if (fn && tokens[pos] === '(') {
      pos++
      const args = [asNumber(expr())]
      while (tokens[pos] === ',') {
        pos++
        args.push(asNumber(expr()))
      }
      if (tokens[pos++] !== ')') fail()
      return { kind: 'number', value: fn(args) }
    }
    const variable = findVariable(token, notePath)
    if (variable?.type === 'number') return { kind: 'number', value: Number(variable.value) }
    if (variable?.type === 'date') return { kind: 'date', value: dateToDays(String(variable.value)) }
    if (variable?.type === 'time') return { kind: 'time', value: timeToMinutes(String(variable.value)) }
    if (variable?.type === 'text') return { kind: 'text', value: String(variable.value) }
    if (variable?.type === 'boolean') return { kind: 'boolean', value: Boolean(variable.value) }
    return fail()
  }

  try {
    const result = comparison()
    if (pos !== tokens.length) return null
    if (result.kind !== 'text' && result.kind !== 'boolean' && !Number.isFinite(result.value)) return null
    return result
  } catch {
    return null
  }
}

// A variable's value after its type is switched. Text that isn't a number becomes 0,
// a number other than 0 and the text "true" become true, and so on.
export function convertValue(value: Variable['value'], type: Variable['type']): Variable['value'] {
  if (type === 'number') return Number(value) || 0
  if (type === 'boolean') return value === true || String(value).toLowerCase() === 'true' || (typeof value === 'number' && value !== 0)
  if (type === 'date') {
    const text = String(value)
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : new Date().toISOString().slice(0, 10)
  }
  if (type === 'time') {
    const text = String(value)
    return /^\d{2}:\d{2}$/.test(text) ? text : new Date().toTimeString().slice(0, 5)
  }
  return String(value)
}

// --- Widgets: {{kind, argument}} ---
// Each widget kind lists the variable types it works with, so a widget is never drawn
// for a type it can't handle (a checkbox for a text variable, say). The plain
// {{name}} or {{formula}} display isn't listed: it works for every type. A new widget is a new
// entry here plus its drawing in markdown.ts.
// `types` is what the widget's first argument (a variable) may be; `usage` names its
// arguments in order, and one ending in ? is optional.
export const WIDGETS: Record<string, { types: Variable['type'][]; usage: string[] }> = {
  input: { types: ['text', 'number', 'boolean', 'date', 'time'], usage: ['variable'] },
  checkbox: { types: ['boolean'], usage: ['variable'] },
  checkboxes: { types: ['number'], usage: ['variable', 'max'] },
  counter: { types: ['number'], usage: ['variable'] },
  slider: { types: ['number'], usage: ['variable', 'max', 'step?'] },
}

export function widgetKind(kind: string): string | null {
  const name = kind.trim().toLowerCase()
  return Object.hasOwn(WIDGETS, name) ? name : null
}

export function widgetAccepts(kind: string, type: Variable['type']): boolean {
  return WIDGETS[kind]?.types.includes(type) ?? false
}

// Acts on an event from inside a rendered widget (the block's text is v-html, so the
// widgets are plain elements and the blocks listen for the events): a boolean button
// or a checkbox flips on click, a counter steps by one, a slider or a text or number box saves its value when it changes (not on every
// key, since the block is redrawn from the value and would drop the cursor). Returns
// true if the event was on a widget, so the caller doesn't also treat it as a click
// on the block.
export function handleWidgetEvent(event: Event, notePath: string | null): boolean {
  const el = (event.target as HTMLElement | null)?.closest?.('[data-widget]')
  if (!el) return false
  const widget = (el as HTMLElement).dataset.widget
  // The run widget isn't a variable (it has no data-name): just run the script.
  if (widget === 'run') {
    if (event.type === 'click') runScript((el as HTMLElement).dataset.path ?? '')
    return true
  }
  const variable = findVariable((el as HTMLElement).dataset.name ?? '', notePath)
  if (!variable) return true

  if (widget === 'checkboxes') {
    // Clicking box n sets the variable to n; clicking the last ticked box un-ticks it.
    const n = Number((event.target as HTMLElement).closest<HTMLElement>('[data-index]')?.dataset.index)
    if (event.type === 'click' && n) variable.value = Number(variable.value) === n ? n - 1 : n
  } else if (widget === 'counter') {
    // The - and + at either end of the number.
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action
    if (event.type === 'click' && action) variable.value = Number((Number(variable.value) + (action === 'plus' ? 1 : -1)).toFixed(10))
  } else if (widget === 'checkbox') {
    if (event.type === 'click') variable.value = !variable.value
  } else if (el instanceof HTMLButtonElement) {
    if (event.type === 'click') variable.value = !variable.value
  } else if (el instanceof HTMLInputElement && event.type === 'change') {
    const typed = parseFloat(el.value)
    variable.value = variable.type === 'number' ? (Number.isNaN(typed) ? 0 : typed) : el.value
  } else {
    return true
  }
  if (config.value.variables?.includes(variable)) queueConfigSave() // a notebook variable
  return true
}


// What the right-click menu inserts for a variable: {{name}} for the display (kind
// null), or {{kind, name}} for a widget. An argument the user has to choose, like a
// maximum, gets a placeholder, and `select` is where it is in the text so it can be
// typed over.
const ARGUMENT_DEFAULTS: Record<string, string> = { max: '10' }

export function widgetSnippet(kind: string | null, name: string): { text: string; select?: [number, number] } {
  if (!kind) return { text: `{{${name}}}` }
  const extras = WIDGETS[kind]!.usage.slice(1)
    .filter((argument) => !argument.endsWith('?'))
    .map((argument) => ARGUMENT_DEFAULTS[argument] ?? '')
  const head = `{{${kind}, ${name}`
  const text = head + extras.map((extra) => `, ${extra}`).join('') + '}}'
  if (!extras.length) return { text }
  const start = head.length + 2
  return { text, select: [start, start + extras[0]!.length] }
}
