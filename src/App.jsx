import { useState, useEffect, useCallback } from 'react'
import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/react'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import { api, setUnauthorizedHandler } from './lib/api.js'
import { clearVaultCache } from './lib/groupsStorage.js'

export default function App() {
  // null = checking, true = signed in, false = signed out, 'error' = server unreachable
  const [authed, setAuthed] = useState(null)
  const [checkError, setCheckError] = useState('')

  const checkSession = useCallback(() => {
    setAuthed(null)
    setCheckError('')
    api
      .listAccounts()
      .then(() => setAuthed(true))
      .catch((e) => {
        // Only 401/403 mean "not signed in". A network or 5xx failure must not
        // dump a signed-in user on the login screen — offer a retry instead.
        if (e && (e.status === 401 || e.status === 403)) {
          setAuthed(false)
        } else {
          setCheckError((e && e.message) || 'Could not reach the server.')
          setAuthed('error')
        }
      })
  }, [])

  useEffect(() => {
    checkSession()
  }, [checkSession])

  // Any later 401 (session expired or revoked) returns to the login screen and
  // drops the cached vault layout.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearVaultCache()
      setAuthed(false)
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  return (
    <>
      {authed === null ? (
        <div className="login-page">
          <div className="empty" role="status" aria-live="polite">
            <div className="spinner" style={{ margin: '0 auto 12px' }} />
            Loading…
          </div>
        </div>
      ) : authed === 'error' ? (
        <div className="login-page">
          <div className="card login-card">
            <h1 className="login-title" style={{ marginBottom: 14 }}>Can&apos;t reach the server</h1>
            <div className="error" role="alert">{checkError}</div>
            <button type="button" className="btn btn-primary" onClick={checkSession} style={{ width: '100%' }}>
              Try again
            </button>
          </div>
        </div>
      ) : !authed ? (
        <Login onLogin={() => setAuthed(true)} />
      ) : (
        <Dashboard />
      )}
      <Analytics />
      <SpeedInsights />
    </>
  )
}
