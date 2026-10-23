import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Open modals, topmost last. Only the top one reacts to Escape / Tab so a
// picker stacked on a form closes (and traps focus) on its own.
const stack = []
let lockCount = 0
let savedOverflow = ''

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function lockScroll() {
  if (lockCount++ === 0) {
    savedOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
}

function unlockScroll() {
  if (lockCount > 0 && --lockCount === 0) {
    document.body.style.overflow = savedOverflow
  }
}

/**
 * Accessible modal shell. Mount it only while open (callers return null
 * otherwise). Provides role="dialog", Escape-to-close, a Tab focus trap,
 * body scroll lock and focus restore, and closes on backdrop click only when
 * the press also started on the backdrop (so selecting text inside the dialog
 * and releasing outside does not dismiss it).
 *
 * `dismissible={false}` blocks Escape and backdrop dismissal (e.g. while saving).
 */
export default function Modal({
  onClose,
  ariaLabel,
  className = 'modal',
  style,
  backdropStyle,
  dismissible = true,
  children,
}) {
  const dialogRef = useRef(null)
  const pressedOnBackdrop = useRef(false)
  const latest = useRef({ onClose, dismissible })
  latest.current = { onClose, dismissible }
  // Captured during the first render, before autoFocus moves focus into the dialog.
  const [previouslyFocused] = useState(() =>
    typeof document !== 'undefined' ? document.activeElement : null
  )

  useEffect(() => {
    const token = {}
    stack.push(token)
    lockScroll()

    const dialog = dialogRef.current
    if (dialog && !dialog.contains(document.activeElement)) {
      const first = dialog.querySelector('[data-autofocus]') || dialog.querySelector(FOCUSABLE)
      ;(first || dialog).focus()
    }

    function onKeyDown(e) {
      if (stack[stack.length - 1] !== token) return
      if (e.key === 'Escape') {
        if (latest.current.dismissible) {
          e.stopPropagation()
          latest.current.onClose?.()
        }
        return
      }
      if (e.key !== 'Tab' || !dialog) return
      const nodes = Array.from(dialog.querySelectorAll(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement
      )
      if (nodes.length === 0) {
        e.preventDefault()
        dialog.focus()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (!dialog.contains(active)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      const i = stack.indexOf(token)
      if (i !== -1) stack.splice(i, 1)
      unlockScroll()
      if (previouslyFocused && previouslyFocused.isConnected && previouslyFocused.focus) {
        previouslyFocused.focus()
      }
    }
  }, [previouslyFocused])

  return createPortal(
    <div
      className="modal-backdrop"
      style={backdropStyle}
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        const direct = pressedOnBackdrop.current && e.target === e.currentTarget
        pressedOnBackdrop.current = false
        if (direct && dismissible) onClose?.()
      }}
    >
      <div
        ref={dialogRef}
        className={className}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
