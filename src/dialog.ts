import { ref } from 'vue'

// A confirmation dialog the app draws itself (see ConfirmDialog.vue), used in
// place of the browser's confirm(). Await askConfirm(); it resolves true if the
// user confirms and false if they cancel.
interface DialogState {
  title: string
  message: string
  confirmLabel: string
  resolve: (confirmed: boolean) => void
}

export const dialog = ref<DialogState | null>(null)

export function askConfirm(options: { title: string; message: string; confirmLabel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    // Only one dialog at a time; a new one cancels any that's still open.
    dialog.value?.resolve(false)
    dialog.value = { confirmLabel: 'Delete', ...options, resolve }
  })
}

export function answerDialog(confirmed: boolean) {
  const current = dialog.value
  dialog.value = null
  current?.resolve(confirmed)
}
