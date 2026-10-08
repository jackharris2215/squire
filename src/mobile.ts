import { ref } from 'vue'

// Small screens (a phone): the sidebar and the right panel become drawers that slide over
// the note instead of taking room from it. Whether one is open is this session's own
// business, not a setting: the saved open/closed state is for the desktop layout and is
// shared by every device. The CSS side is the same 700px breakpoint as in base.css.
const query = window.matchMedia('(max-width: 700px)')

export const isMobile = ref(query.matches)

// Which drawer is open, if any (always null on a wide screen).
export const mobileDrawer = ref<'left' | 'right' | null>(null)

query.addEventListener('change', (event) => {
  isMobile.value = event.matches
  mobileDrawer.value = null
})

export function closeDrawer() {
  mobileDrawer.value = null
}

export function toggleDrawer(side: 'left' | 'right') {
  mobileDrawer.value = mobileDrawer.value === side ? null : side
}
