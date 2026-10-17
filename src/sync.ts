import { SERVER_URL, onServerAhead } from './api'
import { applyServerChange } from './store'

// Follows changes made elsewhere (the API, another window) as they happen. The server keeps a
// stream open (GET /events) and says what changed after every change anyone makes;
// applyServerChange (store.ts) then updates the file list and the notes on screen. A change
// we made ourselves is recognised there and skipped.
//
// Events can be missed (the window slept, the connection dropped), so the server also says
// where it stands each time the stream connects, and the slow check in api.ts hands over to
// the same code; both ask applyServerChange to look at everything.

interface Batch {
  lastSaved: number
  notes: Set<string> | null // null: unknown, look at every note
  tree: boolean
}

let source: EventSource | null = null
let batch: Batch | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let running = false

// Events that arrive together (an API call making several edits) are applied together.
function queue(lastSaved: number, notes: string[] | null, tree: boolean) {
  batch ??= { lastSaved: 0, notes: new Set(), tree: false }
  batch.lastSaved = Math.max(batch.lastSaved, lastSaved)
  batch.tree ||= tree
  if (notes === null) batch.notes = null
  else if (batch.notes) for (const path of notes) batch.notes.add(path)
  clearTimeout(timer)
  timer = setTimeout(run, 30)
}

async function run() {
  if (running || !batch) return
  const { lastSaved, notes, tree } = batch
  batch = null
  running = true
  try {
    await applyServerChange({ lastSaved, notes: notes && [...notes], tree })
  } finally {
    running = false
  }
  if (batch) run() // more came in meanwhile
}

function connect() {
  source?.close()
  source = new EventSource(`${SERVER_URL}/events`)
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data)
      if (event.type === 'hello') queue(event.lastSaved, null, true)
      else if (event.type === 'change') queue(event.lastSaved, event.notes ?? [], !!event.tree)
    } catch {
      // Not an event we understand; ignore it.
    }
  }
  // A dropped connection is retried by the browser itself; one it gave up on (the server
  // answered with an error, say) is retried here.
  source.onerror = () => {
    if (source?.readyState === EventSource.CLOSED) setTimeout(connect, 5000)
  }
}

// Start once the first load is done and the login (if any) has passed.
export function startLiveSync() {
  onServerAhead((serverLastSaved) => queue(serverLastSaved, null, true))
  connect()
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && source?.readyState === EventSource.CLOSED) connect()
  })
}
