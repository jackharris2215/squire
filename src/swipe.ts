import { isMobile, mobileDrawer } from './mobile'

// Swiping sideways on a small screen opens and closes the drawers: a swipe right opens the
// sidebar (or closes the right panel), a swipe left opens the right panel (or closes the
// sidebar). A touch is ignored if it starts somewhere sideways movement already means
// something (a block being edited, a slider, a table, a floating block, a pannable image, or
// anything else that scrolls sideways, such as a script's unwrapped code), if a second finger
// comes down, or if text is being selected, so typing and editing are never mistaken for a
// swipe. A block being edited (.block-input) is always ignored outright, since it's usually
// short enough to never scroll sideways itself; anything else that might scroll sideways (the
// script editor's textarea, say) is only ignored when it actually does, so swiping still works
// over it otherwise — a script view has no other room to start a swipe from.

const MIN_DISTANCE = 60 // px sideways
const MAX_MS = 600
const IGNORED = 'input, select, [contenteditable], table, .table-block, .floating, .image-preview, .block-input'

function startsWhereSidewaysMeansSomething(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null
  if (el?.closest(IGNORED)) return true
  while (el && el !== document.documentElement) {
    const overflowX = getComputedStyle(el).overflowX
    if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth) return true
    el = el.parentElement
  }
  return false
}

export function startSwipeGestures(onSwipe: (direction: 'left' | 'right') => void) {
  let start: { x: number; y: number; time: number } | null = null

  window.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0]
      start =
        isMobile.value && event.touches.length === 1 && touch && !startsWhereSidewaysMeansSomething(event.target)
          ? { x: touch.clientX, y: touch.clientY, time: Date.now() }
          : null
    },
    { passive: true },
  )

  // A second finger (a pinch) cancels it.
  window.addEventListener(
    'touchmove',
    (event) => {
      if (event.touches.length > 1) start = null
    },
    { passive: true },
  )

  window.addEventListener(
    'touchend',
    (event) => {
      const touch = event.changedTouches[0]
      const began = start
      start = null
      if (!began || !touch || Date.now() - began.time > MAX_MS) return
      if (window.getSelection()?.toString()) return
      const dx = touch.clientX - began.x
      const dy = touch.clientY - began.y
      if (Math.abs(dx) < MIN_DISTANCE || Math.abs(dy) * 2 > Math.abs(dx)) return
      onSwipe(dx > 0 ? 'right' : 'left')
    },
    { passive: true },
  )
}

// What a swipe does to the drawers.
export function swipeDrawers(direction: 'left' | 'right') {
  if (direction === 'right') mobileDrawer.value = mobileDrawer.value === 'right' ? null : 'left'
  else mobileDrawer.value = mobileDrawer.value === 'left' ? null : 'right'
}
