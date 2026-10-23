// Copies text to the clipboard. `navigator.clipboard` only exists in secure
// contexts (HTTPS/localhost), so fall back to a hidden textarea + execCommand
// for plain-HTTP self-hosted setups. Resolves true on success, never throws.
export async function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.setAttribute('aria-hidden', 'true')
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  const previous = document.activeElement
  document.body.appendChild(ta)
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(ta)
    if (previous && previous.focus) previous.focus()
  }
}
