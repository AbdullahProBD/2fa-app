import { useEffect, useRef } from 'react'

export function Toast({ message, onDone, duration = 3000 }) {
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  // Re-arm on every new message and always clear on change/unmount so timers
  // from earlier toasts can never dismiss a newer one.
  useEffect(() => {
    if (!message || !duration) return undefined
    const t = setTimeout(() => doneRef.current?.(), duration)
    return () => clearTimeout(t)
  }, [message, duration])

  if (!message) return null
  return (
    <div className="toast" role="status" aria-live="polite" onClick={onDone}>
      {message}
    </div>
  )
}
