import { marked } from 'marked'
import { SERVER_URL } from './api'
import { imageIndex, isImagePath, isPdfPath, isScriptPath, noteIndex, scriptIndex } from './store'
import type { Variable } from './types'
import { WIDGETS, evaluateBoolean, evaluateNumber, evaluateWidget, findVariable, formatNumber, widgetAccepts, widgetKind } from './variables'

// A plain markdown link ([text](url)) is to somewhere outside the notebook, unlike a
// [[wikilink]] (rendered separately, below); it opens in a new tab rather than
// navigating the app away, and onBlockClick (Editor.vue) lets the browser handle the
// click instead of starting to edit the block.
marked.use({
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens)
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
      return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
    },
  },
})

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// A widget that can't be drawn (no such variable, an unknown kind, or a variable of a
// type the widget doesn't work with) shows its own text, faded.
function missingWidget(text: string, reason?: string): string {
  const title = reason ? ` title="${escapeHtml(reason)}"` : ''
  return `<span class="variable-widget missing"${title}>{{${escapeHtml(text)}}}</span>`
}

// The input widget: the same kind of control as next to the variable in the
// variables tab, drawn inline. handleWidgetEvent saves what's typed.
function renderInput(variable: Variable, name: string): string {
  const attrs = `data-widget="input" data-name="${escapeHtml(name)}"`
  if (variable.type === 'boolean') {
    return `<button class="widget-input widget-bool" ${attrs}>${variable.value ? 'true' : 'false'}</button>`
  }
  const text = String(variable.value)
  const type = variable.type === 'number' ? 'number' : 'text'
  return `<input class="widget-input" ${attrs} type="${type}" value="${escapeHtml(text)}" spellcheck="false" style="width:${Math.max(text.length, 3) + 2}ch">`
}

// The checkbox widget, for a boolean variable.
function renderCheckbox(variable: Variable, name: string): string {
  const attrs = `data-widget="checkbox" data-name="${escapeHtml(name)}"`
  const checked = variable.value ? ' checked' : ''
  return `<span class="widget-checkbox${checked}" role="checkbox" aria-checked="${!!variable.value}" ${attrs}></span>`
}

// The counter widget: the number with a - button before it and a + button after, in
// one box. The - and + are drawn by CSS (so they sit exactly centered); handleWidgetEvent
// does the stepping.
function renderCounter(variable: Variable, name: string): string {
  return (
    `<span class="widget-counter" data-widget="counter" data-name="${escapeHtml(name)}">` +
    `<span class="counter-button" data-action="minus" role="button" aria-label="Decrease"></span>` +
    `<span class="counter-value">${escapeHtml(formatNumber(Number(variable.value)))}</span>` +
    `<span class="counter-button" data-action="plus" role="button" aria-label="Increase"></span>` +
    `</span>`
  )
}

// The slider widget: from 0 to `max` in steps of `step`. The thumb moves natively while
// dragging; the variable is saved when it is let go (see handleWidgetEvent), because
// redrawing the block mid-drag would drop the thumb.
function renderSlider(variable: Variable, name: string, max: number, step: number): string {
  const attrs = `data-widget="slider" data-name="${escapeHtml(name)}"`
  return `<input type="range" class="widget-slider" ${attrs} min="0" max="${max}" step="${step}" value="${Number(variable.value)}">`
}

// The checkboxes widget: a row of `max` boxes, the first `value` of them ticked.
function renderCheckboxes(variable: Variable, name: string, max: number): string {
  const value = Number(variable.value)
  const total = Math.min(Math.max(Math.floor(max), 0), 100)
  const boxes = Array.from({ length: total }, (_, i) => `<span class="widget-checkbox${i < value ? ' checked' : ''}" data-index="${i + 1}"></span>`)
  return `<span class="widget-checkboxes" data-widget="checkboxes" data-name="${escapeHtml(name)}">${boxes.join('')}</span>`
}

// Splits {{...}}'s inside on commas, but not ones inside parentheses, so a widget
// argument that's itself a formula calling a function (min(1, 4), say) stays one
// part instead of being cut into pieces.
function splitTopLevel(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') depth++
    else if (inner[i] === ')') depth--
    else if (inner[i] === ',' && depth === 0) {
      parts.push(inner.slice(start, i))
      start = i + 1
    }
  }
  parts.push(inner.slice(start))
  return parts.map((part) => part.trim())
}

// Shows what {{...}} says. One item, {{score}} or {{a + b * 2}}, is a variable or a
// formula (see evaluateWidget). Several items separated by commas are a widget:
// {{input, score}} is the widget "input" given the argument "score", and more
// more arguments can follow (checkboxes takes a variable and a maximum). Anything that can't be drawn shows its own text, faded.
// {{if, condition, trueValue, falseValue}}: shows trueValue (a variable, "quoted
// text" or a formula, same as a plain {{display}}) if condition is true, falseValue
// if not. Not a WIDGETS entry since its first argument is a condition, not a
// variable — there's no widget form of it, and no "if" should ever be insertable
// from the variable menu.
function renderIf(parts: string[], notePath: string | null, inner: string): string {
  if (parts.length !== 4) return missingWidget(inner, 'The if display is written {{if, condition, trueValue, falseValue}}.')
  const [, condition, trueValue, falseValue] = parts as [string, string, string, string]
  const result = evaluateBoolean(condition, notePath)
  if (result === null) return missingWidget(inner, 'The condition must be a boolean variable or a comparison such as a > b.')
  const shown = evaluateWidget(result ? trueValue : falseValue, notePath)
  if (shown === null) return missingWidget(inner, 'trueValue and falseValue must be a variable, "quoted text", or a formula.')
  return `<span class="variable-widget">${escapeHtml(shown)}</span>`
}

// The run widget: a button that runs a script (by name, filename, or full path) when
// clicked, optionally labeled with a third argument (the script's name otherwise). It
// isn't a variable, so it's special-cased here like "if" rather than being a WIDGETS
// entry; handleWidgetEvent (variables.ts) calls store.ts's runScript() directly on a
// click. Running never writes anything into this (or any) note — the script's own
// output stays wherever runScript already keeps it (the script's own pane, if it's open).
function unquote(text: string): string {
  return text.trim().replace(/^"([^"]*)"$/, '$1').trim()
}

function renderRun(parts: string[], inner: string): string {
  const name = unquote(parts[1]!)
  const path = scriptIndex.value[name]
  if (!path) return missingWidget(inner, `There is no script named "${name}".`)
  const label = parts[2] !== undefined ? unquote(parts[2]) : name
  return `<button class="widget-input widget-run" data-widget="run" data-path="${escapeHtml(path)}">${escapeHtml(label)}</button>`
}

function renderWidget(inner: string, notePath: string | null): string {
  const parts = splitTopLevel(inner)
  // Only a comma after "if"/"run" makes it that display — a bare {{if}} or {{run}}
  // could be a variable actually named that (variable names are letters and spaces,
  // so that's legal), and should show as that instead.
  if (parts.length > 1 && parts[0]!.trim().toLowerCase() === 'if') return renderIf(parts, notePath, inner)
  if (parts.length >= 2 && parts.length <= 3 && parts[0]!.trim().toLowerCase() === 'run') return renderRun(parts, inner)
  // A comma doesn't always mean a widget: a formula's function calls have them too
  // (max(a, b), say), so a formula is tried whenever the first part isn't a widget.
  const widget = parts.length > 1 ? widgetKind(parts[0]!) : null
  if (!widget) {
    const shown = evaluateWidget(inner, notePath)
    if (shown !== null) return `<span class="variable-widget">${escapeHtml(shown)}</span>`
    return parts.length > 1 ? missingWidget(inner, `There is no "${parts[0]}" widget.`) : missingWidget(inner)
  }

  const [, ...args] = parts as [string, ...string[]]
  const usage = WIDGETS[widget]!.usage
  const required = usage.filter((name) => !name.endsWith('?')).length
  if (args.length < required || args.length > usage.length) {
    return missingWidget(inner, `The ${widget} widget is written {{${widget}, ${usage.map((name) => (name.endsWith('?') ? `[${name.slice(0, -1)}]` : name)).join(', ')}}}.`)
  }
  const variable = findVariable(args[0]!, notePath)
  if (!variable) return missingWidget(inner)
  if (!widgetAccepts(widget, variable.type)) {
    return missingWidget(inner, `The ${widget} widget doesn't work with ${variable.type} variables.`)
  }
  if (variable.readonly) {
    return missingWidget(inner, `The ${widget} widget can't be used with a global variable.`)
  }
  if (widget === 'checkboxes') {
    const max = evaluateNumber(args[1]!, notePath)
    if (max === null) return missingWidget(inner, 'The maximum must be a number, a number variable or a formula.')
    return renderCheckboxes(variable, args[0]!, max)
  }
  if (widget === 'slider') {
    const max = evaluateNumber(args[1]!, notePath)
    const step = args[2] === undefined ? 1 : evaluateNumber(args[2], notePath)
    if (max === null || max <= 0) return missingWidget(inner, 'The maximum must be a number above 0.')
    if (step === null || step <= 0) return missingWidget(inner, 'The step must be a number above 0.')
    return renderSlider(variable, args[0]!, max, step)
  }
  if (widget === 'checkbox') return renderCheckbox(variable, args[0]!)
  if (widget === 'counter') return renderCounter(variable, args[0]!)
  return renderInput(variable, args[0]!)
}

// Turns [[Title]] into a link to that note (or one that would create it), and
// [[img.jpg]] into a link to that image. ![[img.jpg]] shows the image inline,
// ![[img.jpg|400]] with a max width of 400px. [[Title|Display text]] (not an embed) links to
// Title but shows "Display text" instead, same idea as Obsidian's alias syntax.
// An image is only matched by its full filename (or its notebook path), never by a
// title, and a missing image is never offered for creation as a note.
function renderLinks(html: string): string {
  return html.replace(/(!?)\[\[([^\]]+)\]\]/g, (_match, bang, inner) => {
    // ![[img.jpg|400]]: an embed may end in |width, a max width in pixels. The
    // height follows, so the aspect ratio is kept.
    const sized = bang ? /^(.+)\|\s*(\d+)\s*$/.exec(inner) : null
    // [[Title|Display text]]: a plain link's |suffix is an alias instead of a width.
    const aliased = !bang ? /^(.+?)\|([\s\S]*)$/.exec(inner) : null
    const title = sized ? sized[1]! : aliased ? aliased[1]!.trim() : inner
    const shown = aliased ? aliased[2]!.trim() || title : title
    const imagePath = imageIndex.value[title]
    if (bang && imagePath && isImagePath(imagePath)) {
      const src = `${SERVER_URL}/file?path=${encodeURIComponent(imagePath)}`
      const maxWidth = sized ? `min(${sized[2]}px,100%)` : '100%'
      return `<img class="embed-image" src="${src}" alt="${title}" draggable="false" style="max-width:${maxWidth};height:auto">`
    }
    const path = noteIndex.value[title] ?? imagePath ?? scriptIndex.value[title]
    if (path) return `${bang}<a href="#" class="note-link" data-path="${path}">${shown}</a>`
    if (isImagePath(title) || isPdfPath(title) || isScriptPath(title)) return `${bang}<a href="#" class="note-link missing">${shown}</a>`
    return `${bang}<a href="#" class="note-link missing" data-title="${title}">${shown}</a>`
  })
}

// [[{{Date}}]] (or ![[{{Date}}]], optionally followed by |width or |an alias): when the whole
// bracket content up to that point is one {{formula}}, it's evaluated like a plain {{display}}
// and spliced in as the literal title before anything else runs, so the link resolves/misses/
// offers creation exactly as if that text had been typed by hand; anything after it (a width,
// an alias) is left as-is for renderLinks to interpret. Left alone (so it falls through to the
// normal {{...}} handling, which shows a missing widget) if the formula can't be evaluated.
// Shared with LinksList.vue, which re-scans the same raw [[...]] syntax independently.
export function resolveLinkFormulas(content: string, notePath: string | null): string {
  return content.replace(/(!?)\[\[\{\{([^{}]+)\}\}([^\]]*)\]\]/g, (match, bang, expr, suffix) => {
    const shown = evaluateWidget(expr.trim(), notePath)
    return shown === null ? match : `${bang}[[${shown}${suffix}]]`
  })
}

// Renders a block's markdown: paragraphs, bold, [[links]], {{variables}}, tables, and checklist
// checkboxes made clickable. Shared with TableBlock.vue, so a table cell's
// content renders exactly the same way a text block's does.
export function renderBlock(content: string, notePath: string | null = null): string {
  // Each line becomes its own paragraph, except consecutive table rows, which
  // must stay on adjacent lines or marked won't see a table.
  // {{widgets}} are swapped for placeholders first, so markdown can't mangle a
  // formula (two * would turn the text between them into italics); they are put
  // back once the markdown is rendered.
  const widgets: string[] = []
  const protectedContent = resolveLinkFormulas(content, notePath).replace(/\{\{([^{}]+)\}\}/g, (_match, inner: string) => {
    widgets.push(renderWidget(inner, notePath))
    return `${widgets.length - 1}`
  })
  const lines = protectedContent.split('\n')
  const isTableRow = (line: string) => line.trim().startsWith('|')
  const isFenceDelimiter = (line: string) => /^\s*(```+|~~~+)/.test(line)
  // Lines inside a fenced code block keep their own single newlines (the point of a
  // code block is that its formatting is exact); doubling every line like the rest
  // of a block's text would otherwise get would double-space the code and often
  // break the fence's own indentation-sensitive content.
  let inFence = false
  const withPreservedLineBreaks = lines
    .map((line, i) => {
      if (isFenceDelimiter(line)) inFence = !inFence
      if (i === lines.length - 1) return line
      const keepSingle = inFence || (isTableRow(line) && isTableRow(lines[i + 1]!))
      return line + (keepSingle ? '\n' : '\n\n')
    })
    .join('')
  const html = marked.parse(withPreservedLineBreaks, { async: false }) as string
  const withLinks = renderLinks(html)
  // marked renders checklist items as disabled checkboxes; make them clickable and
  // number them in document order, so a click can flip the matching line's [ ]/[x].
  let index = -1
  let withCheckboxes = withLinks.replace(/<input ([^>]*)type="checkbox"([^>]*)>/g, (_match, before, after) => {
    index++
    const checked = /\bchecked(="")?/.test(before + after)
    return `<input type="checkbox" class="block-checkbox" data-index="${index}"${checked ? ' checked' : ''}>`
  })
  if (withCheckboxes.includes('block-checkbox')) {
    // The checkbox takes the bullet's place: flag its <li> and the enclosing <ul> so
    // CSS can drop the marker and tighten the indent to match, without depending on
    // :has() support.
    withCheckboxes = withCheckboxes
      .replace(/<li>([\s\S]*?)<\/li>/g, (match, inner) =>
        inner.includes('block-checkbox') ? `<li class="checklist-item">${inner}</li>` : match,
      )
      .replace('<ul>', '<ul class="checklist">')
  }
  // Widgets go back in last, so the checklist pass above can't mistake a checkbox
  // widget for a list item's checkbox.
  return withCheckboxes.replace(/(\d+)/g, (_match, i: string) => widgets[Number(i)]!)
}
