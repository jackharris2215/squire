import { ref } from 'vue'

// Empty: requests go to the address the app was loaded from, since the server also
// serves the built app. `npm run dev` forwards them to the server (vite.config.ts); to
// point at a server somewhere else, set VITE_SERVER_URL (e.g. http://host:8765).
export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? ''

// The server's "lastSaved" as of our last load or write. Every change we send
// carries it; if the server's is newer someone else changed the notebook, and
// outOfDate (the server's newer time) shows the reload popup.
export const lastSaved = ref(0)
export const outOfDate = ref<number | null>(null)
// True when the server wants a password (it answered 401): LoginScreen.vue is shown.
export const needsLogin = ref(false)

// Whether the server will talk to us: false (and the login screen shows) if it wants a
// password we haven't given. An unreachable server isn't a login problem, so it passes.
export async function checkSession(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/config`)
    if (res.status === 401) needsLogin.value = true
    return res.status !== 401
  } catch {
    return true
  }
}

// Sends the password; returns an error message, or null once the server has accepted it
// (it then sets a cookie the browser sends with every later request, images and PDFs too).
export async function login(password: string): Promise<string | null> {
  try {
    const res = await fetch(`${SERVER_URL}/login`, { method: 'POST', body: JSON.stringify({ password }) })
    if (res.ok) return null
    return res.status === 401 ? 'Wrong password.' : 'The server did not accept that.'
  } catch {
    return 'Cannot reach the server.'
  }
}
let writeChain: Promise<unknown> = Promise.resolve()
let pendingWrites = 0 // changes queued or in flight

// Every change to the server goes through here, one at a time, so each carries
// the lastSaved returned by the one before it.
export function serverWrite(url: string, init: RequestInit = {}): Promise<{ ok: boolean; data: any }> {
  const run = async () => {
    if (outOfDate.value) return { ok: false, data: { error: 'Out of date' } }
    const sep = url.includes('?') ? '&' : '?'
    const res = await fetch(`${SERVER_URL}${url}${sep}lastSaved=${lastSaved.value}`, init)
    if (res.status === 401) {
      needsLogin.value = true // e.g. the server was restarted with a different password
      return { ok: false, data: { error: 'Login required' } }
    }
    const data = await res.json()
    if (res.status === 412) outOfDate.value = data.lastSaved
    else if (data.lastSaved) lastSaved.value = data.lastSaved
    return { ok: res.ok, data }
  }
  pendingWrites++
  const result = writeChain.then(run)
  const finished = () => pendingWrites--
  result.then(finished, finished)
  writeChain = result.catch(() => {})
  return result
}

// Checks the server's lastSaved every few seconds (the interval is a setting), and
// whenever the window comes back into view, so a stale window is flagged before any
// edit instead of when it tries to save. Start it once the first load has set lastSaved.
let stalenessTimer: ReturnType<typeof setInterval> | undefined
// What to do when the check finds the server ahead of us. sync.ts sets it: it fetches what
// changed instead of asking for a reload. The check is then the safety net behind the live
// event stream, for events missed while the window slept or the connection dropped.
let serverAheadHandler: ((serverLastSaved: number) => void) | null = null

export function onServerAhead(handler: (serverLastSaved: number) => void) {
  serverAheadHandler = handler
}

async function checkStaleness() {
  if (outOfDate.value) return
  try {
    const res = await fetch(`${SERVER_URL}/config`)
    if (res.status === 401) {
      needsLogin.value = true
      return
    }
    const { lastSaved: serverLastSaved } = await res.json()
    // While our own changes are in flight, the server's newer time is likely
    // just them; the next check will settle it.
    if (pendingWrites === 0 && serverLastSaved > lastSaved.value) {
      // Normally the live sync (sync.ts) catches up; the popup is for when there is none.
      if (serverAheadHandler) serverAheadHandler(serverLastSaved)
      else outOfDate.value = serverLastSaved
    }
  } catch {
    // Server unreachable: saving will report that itself.
  }
}

// Changes how often the check runs; takes effect at once.
export function setStalenessInterval(intervalMs: number) {
  clearInterval(stalenessTimer)
  stalenessTimer = setInterval(checkStaleness, intervalMs)
}

export function startStalenessPolling(intervalMs = 5000) {
  setStalenessInterval(intervalMs)
  window.addEventListener('focus', checkStaleness)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkStaleness()
  })
}

// Resolves once every change sent so far has finished.
export function whenWritesDone() {
  return writeChain
}

export function reloadPage() {
  window.location.reload()
}
