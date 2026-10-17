<script setup lang="ts">
import { computed, ref } from 'vue'
import { highlightPython } from './pythonHighlight'
import { editScript, runScript, saveScript, scriptCache, scriptRuns } from './store'

// What a pane shows for a script (a Python file in the notebook): a plain text box, Run, and
// what the last run printed. Typing saves a moment later like a note; Run saves first. All the
// state is in store.ts (scriptCache, scriptRuns), so it survives the pane being closed.
const props = defineProps<{ path: string }>()

const entry = computed(() => scriptCache.get(props.path))
const run = computed(() => scriptRuns.get(props.path))

// The colors come from a copy of the text drawn behind the text box (see .script-highlight);
// the box's own text is transparent, so only its caret and selection show.
const highlighted = computed(() => highlightPython(entry.value?.text ?? ''))
const boxEl = ref<HTMLTextAreaElement | null>(null)
const highlightEl = ref<HTMLElement | null>(null)

function syncScroll() {
  if (!boxEl.value || !highlightEl.value) return
  highlightEl.value.scrollTop = boxEl.value.scrollTop
  highlightEl.value.scrollLeft = boxEl.value.scrollLeft
}

const status = computed(() => {
  const state = entry.value?.state
  return state === 'saving' ? 'Saving…' : state === 'error' ? 'Not saved' : 'Saved'
})

const runSummary = computed(() => {
  const r = run.value
  if (!r) return ''
  if (r.running) return 'Running…'
  if (r.error) return 'Could not run'
  if (r.timedOut) return 'Stopped: it ran too long'
  return r.exitCode === 0 ? 'Finished' : `Failed (exit code ${r.exitCode})`
})

function onInput(event: Event) {
  editScript(props.path, (event.target as HTMLTextAreaElement).value)
}

const INDENT = '    '

// Indents (or, with `dedent`, outdents) every line the selection touches by one level. The
// selection stays on the same text.
function shiftLines(box: HTMLTextAreaElement, dedent: boolean) {
  const { value, selectionStart: start, selectionEnd: end } = box
  const first = value.lastIndexOf('\n', start - 1) + 1
  // A selection that ends at the very start of a line doesn't include that line.
  const reach = end > start && value[end - 1] === '\n' ? end - 1 : end
  const newline = value.indexOf('\n', reach)
  const last = newline === -1 ? value.length : newline
  let firstChange = 0
  let totalChange = 0
  const lines = value
    .slice(first, last)
    .split('\n')
    .map((line, i) => {
      const next = dedent ? line.replace(/^( {1,4}|\t)/, '') : line ? INDENT + line : line
      if (i === 0) firstChange = next.length - line.length
      totalChange += next.length - line.length
      return next
    })
  box.setRangeText(lines.join('\n'), first, last, 'preserve')
  box.setSelectionRange(Math.max(first, start + firstChange), Math.max(first, end + totalChange))
  editScript(props.path, box.value)
}

// Enter starts the next line at the same indentation, one level deeper after a line that
// ends in a colon.
function newLine(box: HTMLTextAreaElement) {
  const { value, selectionStart: start, selectionEnd: end } = box
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const before = value.slice(lineStart, start)
  let indent = before.match(/^[ \t]*/)![0]
  if (/:\s*(#.*)?$/.test(before)) indent += INDENT
  box.setRangeText('\n' + indent, start, end, 'end')
  editScript(props.path, box.value)
}

function onKeydown(event: KeyboardEvent) {
  const box = event.target as HTMLTextAreaElement
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    saveScript(props.path)
  } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    runScript(props.path)
  } else if (event.key === 'Enter' && plain && !event.isComposing) {
    event.preventDefault()
    newLine(box)
  } else if (event.key === 'Tab' && plain) {
    // Python is indented with spaces; Tab never leaves the box.
    event.preventDefault()
    if (event.shiftKey || box.selectionStart !== box.selectionEnd) shiftLines(box, event.shiftKey)
    else {
      box.setRangeText(INDENT, box.selectionStart, box.selectionEnd, 'end')
      editScript(props.path, box.value)
    }
  }
}
</script>

<template>
  <div class="script-editor">
    <div class="script-toolbar">
      <button class="script-run" :disabled="!entry || run?.running" title="Save and run (Ctrl+Enter)" @click="runScript(props.path)">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z" /></svg>
        Run
      </button>
      <span class="script-status" :class="{ error: entry?.state === 'error' }">{{ status }}</span>
    </div>
    <div v-if="entry" class="script-code">
      <pre ref="highlightEl" class="script-highlight" aria-hidden="true" v-html="highlighted" />
      <textarea
        ref="boxEl"
        class="script-text"
        :value="entry.text"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        wrap="off"
        @input="onInput"
        @keydown="onKeydown"
        @scroll="syncScroll"
      />
    </div>
    <div v-else class="script-loading"><div class="spinner" /></div>
    <section v-if="run" class="script-output">
      <div class="script-output-head" :class="{ bad: run.error || run.timedOut || (run.exitCode !== null && run.exitCode !== 0) }">
        {{ runSummary }}
      </div>
      <pre class="script-output-text">{{ run.error ?? run.output }}</pre>
    </section>
  </div>
</template>

<style scoped>
.script-editor {
  /* Fills the note area exactly instead of growing with its content. The note box is as tall as
     its content needs, so a long output would push everything past the bottom of the pane. */
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
}

.script-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
}

.script-run {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.7rem;
  font: inherit;
  font-size: 0.85rem;
  color: var(--color-on-accent);
  background: var(--color-accent);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.script-run:disabled {
  opacity: 0.5;
  cursor: default;
}

.script-status {
  font-size: 0.8rem;
  opacity: 0.6;
}

.script-status.error {
  color: #e08080;
  opacity: 1;
}

/* The text box with its colored copy behind it. The two must lay text out identically (same
   font, size, padding, tab width, no wrapping) and scroll together (syncScroll). */
.script-code {
  --tok-keyword: #8250df;
  --tok-string: #0a7f3f;
  --tok-comment: #6e7781;
  --tok-number: #b35900;
  --tok-name: #0b61c4;
  --tok-builtin: #0b7285;
  --tok-constant: #b35900;
  --tok-decorator: #9a6700;

  position: relative;
  flex: 1;
  min-height: 0;
}

:global(:root[data-theme='dark']) .script-code {
  --tok-keyword: #c792ea;
  --tok-string: #98c379;
  --tok-comment: #7f848e;
  --tok-number: #f0a05a;
  --tok-name: #61afef;
  --tok-builtin: #56b6c2;
  --tok-constant: #f0a05a;
  --tok-decorator: #e5c07b;
}

.script-highlight,
.script-text {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 0.75rem;
  border: none;
  font-family: ui-monospace, 'Cascadia Code', Consolas, Menlo, monospace;
  font-size: 0.85rem;
  line-height: 1.5;
  letter-spacing: normal;
  tab-size: 4;
  white-space: pre;
  word-wrap: normal;
  overflow-wrap: normal;
}

.script-highlight {
  overflow: hidden;
  /* Room past the end, so the copy can scroll as far as the box does with its scrollbars. */
  padding-right: calc(0.75rem + 20px);
  padding-bottom: calc(0.75rem + 20px);
  color: var(--color-text-strong);
  pointer-events: none;
}

.script-text {
  overflow: auto;
  color: transparent;
  caret-color: var(--color-text-strong);
  background: transparent;
  outline: none;
  resize: none;
}

.script-text::selection {
  background: rgb(var(--tint) / 0.25);
  color: transparent;
}

.script-highlight :deep(.tok-keyword) {
  color: var(--tok-keyword);
}

.script-highlight :deep(.tok-string) {
  color: var(--tok-string);
}

.script-highlight :deep(.tok-comment) {
  color: var(--tok-comment);
  font-style: italic;
}

.script-highlight :deep(.tok-number) {
  color: var(--tok-number);
}

.script-highlight :deep(.tok-name) {
  color: var(--tok-name);
}

.script-highlight :deep(.tok-builtin) {
  color: var(--tok-builtin);
}

.script-highlight :deep(.tok-constant) {
  color: var(--tok-constant);
}

.script-highlight :deep(.tok-decorator) {
  color: var(--tok-decorator);
}

.script-loading {
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
  animation: script-spin 0.8s linear infinite;
}

@keyframes script-spin {
  to {
    transform: rotate(360deg);
  }
}

.script-output {
  flex: 0 0 auto;
  max-height: 40%;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--color-border);
  background: rgb(var(--tint) / 0.04);
}

.script-output-head {
  padding: 0.25rem 0.75rem;
  font-size: 0.75rem;
  opacity: 0.7;
}

.script-output-head.bad {
  color: #e08080;
  opacity: 1;
}

.script-output-text {
  margin: 0;
  padding: 0 0.75rem 0.6rem;
  font-family: ui-monospace, 'Cascadia Code', Consolas, Menlo, monospace;
  font-size: 0.8rem;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow: auto;
  user-select: text;
}
</style>
