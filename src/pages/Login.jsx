import { useState, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faShieldHalved,
  faLock,
  faUnlock,
  faEye,
  faEyeSlash,
  faKey,
  faCircleCheck,
} from '@fortawesome/free-solid-svg-icons'
import { api, primeCsrfCache } from '../lib/api.js'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState(null)
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.getMode()
      .then((res) => {
        if (cancelled) return
        setMode(res)
      })
      .catch(() => {
        if (!cancelled) setMode({ mode: 'unknown' })
      })
    return () => { cancelled = true }
  }, [])

  // Fallback when getMode returns mode='ready' (the only value the server
  // returns now) — show the standard "first time" message.
  useEffect(() => {
    if (mode && mode.mode === 'ready' && mode.hasAccount === undefined) {
      setMode((m) => ({ ...(m || {}), hasAccount: false }))
    }
  }, [mode])

  async function submit(e) {
    e.preventDefault()
    if (loading) return
    setErr('')
    setLoading(true)
    try {
      const res = await api.login(username, password)
      // Prime the in-memory CSRF cache from the value the login response
      // returned in its body. This protects against the rare case where the
      // browser drops the JS-readable 2fa_csrf cookie right after login
      // (some privacy settings + SameSite=Strict + Vercel redirects can
      // cause this). Using the body value lets the very next write succeed.
      if (res && typeof res.csrfToken === 'string') {
        primeCsrfCache(res.csrfToken)
      }
      // Keep the form disabled while the page reloads into the dashboard.
      window.location.reload()
    } catch (e) {
      setErr(e.message)
      setLoading(false)
    }
  }

  const hint = !mode
    ? 'Loading…'
    : mode.mode === 'misconfigured'
      ? 'Server is misconfigured — check environment variables.'
      : mode.hasAccount
        ? 'Sign in to your vault.'
        : 'First time? Sign in to create your vault.'

  return (
    <div className="login-page">
      <div className="card login-card">
        <div className="login-brand">
          <div className="vault-brand-icon">
            <FontAwesomeIcon icon={faShieldHalved} style={{ fontSize: 26 }} />
          </div>
          <div>
            <h1 className="login-title">2FA Vault</h1>
            <p className="login-subtitle" role="status" aria-live="polite">{hint}</p>
          </div>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label className="label" htmlFor="login-username">Username</label>
            <input
              id="login-username"
              className="input"
              type="text"
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="login-password">Password</label>
            <div className="password-wrap">
              <input
                id="login-password"
                className="input"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="btn-icon password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                <FontAwesomeIcon icon={showPassword ? faEyeSlash : faEye} style={{ fontSize: 15 }} />
              </button>
            </div>
          </div>
          {err && <div className="error" role="alert">{err}</div>}
          <button className="btn btn-primary login-submit" type="submit" disabled={loading}>
            <FontAwesomeIcon icon={loading ? faLock : faUnlock} style={{ fontSize: 13 }} /> {loading ? 'Unlocking…' : 'Unlock vault'}
          </button>
        </form>
        <ul className="login-features">
          <li>
            <FontAwesomeIcon icon={faKey} style={{ fontSize: 12 }} />
            <span>Secrets are encrypted with AES-256-GCM using a key derived from your password.</span>
          </li>
          <li>
            <FontAwesomeIcon icon={faCircleCheck} style={{ fontSize: 12 }} />
            <span>TOTP &amp; HOTP, groups, and live camera QR scanning.</span>
          </li>
        </ul>
        <p className="login-footnote">
          Forgot the password? All stored 2FA secrets are lost &mdash; that&apos;s the trade-off for zero-knowledge storage.
        </p>
      </div>
    </div>
  )
}
