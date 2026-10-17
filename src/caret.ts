// Where a character of a textarea is on screen. A textarea can't say, so this
// builds an invisible copy of it (same font, width and padding), fills it with the
// text up to that character, and measures where it ended.

const COPIED = [
  'box-sizing',
  'width',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'text-transform',
  'text-indent',
  'text-align',
  'tab-size',
]

// Viewport coordinates of the top-left of the character at `index`, plus the
// height of a line there.
export function caretPosition(textarea: HTMLTextAreaElement, index: number) {
  const style = getComputedStyle(textarea)
  const mirror = document.createElement('div')
  for (const property of COPIED) mirror.style.setProperty(property, style.getPropertyValue(property))
  Object.assign(mirror.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    visibility: 'hidden',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  })
  mirror.textContent = textarea.value.slice(0, index)
  const marker = document.createElement('span')
  marker.textContent = textarea.value.slice(index) || '.'
  mirror.append(marker)
  document.body.append(mirror)

  const box = textarea.getBoundingClientRect()
  const position = {
    left: box.left + marker.offsetLeft - textarea.scrollLeft,
    top: box.top + marker.offsetTop - textarea.scrollTop,
    lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3,
  }
  mirror.remove()
  return position
}
