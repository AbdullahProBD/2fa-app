import { useState, useRef, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChevronDown, faCheck } from '@fortawesome/free-solid-svg-icons'

/**
 * Beautiful dark-themed dropdown replacing native <select>.
 * Props: value, onChange(value), options [{ value, label }], placeholder, ariaLabel
 */
export default function Select({
  value,
  onChange,
  options = [],
  placeholder = 'Select…',
  ariaLabel,
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const btnRef = useRef(null)

  const selected = options.find((o) => String(o.value) === String(value))

  useEffect(() => {
    if (!open) return
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        // Close only the dropdown, not the dialog it lives in.
        e.stopPropagation()
        setOpen(false)
        btnRef.current?.focus()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(ref.current?.querySelectorAll('[role="option"]') || [])
        if (items.length === 0) return
        e.preventDefault()
        const i = items.indexOf(document.activeElement)
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1
        items[(next + items.length) % items.length].focus()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={`custom-select ${open ? 'open' : ''}`} ref={ref}>
      <button
        ref={btnRef}
        type="button"
        className="custom-select-btn"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="custom-select-value">
          {selected ? (
            selected.label
          ) : (
            <span className="custom-select-placeholder">{placeholder}</span>
          )}
        </span>
        <FontAwesomeIcon icon={faChevronDown} className="custom-select-chevron" />
      </button>
      {open && (
        <div className="custom-select-menu" role="listbox">
          {options.map((opt) => {
            const active = String(opt.value) === String(value)
            return (
              <button
                key={String(opt.value)}
                type="button"
                role="option"
                aria-selected={active}
                className={`custom-select-option ${active ? 'selected' : ''}`}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
              >
                <span>{opt.label}</span>
                {active && (
                  <FontAwesomeIcon icon={faCheck} className="custom-select-check" />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
