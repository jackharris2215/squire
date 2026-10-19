// navigator.clipboard only exists in a secure context (HTTPS or localhost); this app is also
// reached over plain http on the LAN (see uuid.ts for the same restriction elsewhere), where
// it's undefined. Falls back to the old hidden-textarea + execCommand trick, which has no such
// restriction.
export function copyText(text: string) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}
