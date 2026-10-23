import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'

const COOKIE_NAME = '2fa_session'
const CSRF_COOKIE_NAME = '2fa_csrf'
const CSRF_HEADER_NAME = 'x-csrf-token'
const SESSION_TTL_SECONDS = 60 * 60 * 24 // 24 hours

// ── C1 FIX: Throw hard if SESSION_SECRET is not set ───────────────────────────
function getSessionSecret() {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_SECRET env var is required and must be at least 32 characters. ' +
        'Generate one with: openssl rand -hex 32'
    )
  }
  return secret
}

// ── H2 FIX: Use HKDF instead of raw SHA-256 as KDF ───────────────────────────
function getAesKey() {
  return crypto.hkdfSync('sha256', getSessionSecret(), 'session-vault-wrap', '', 32)
}

export function wrapVaultKeyForSession(vaultKey) {
  const aesKey = Buffer.from(getAesKey())
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv, { authTagLength: 16 })
  const ct = Buffer.concat([cipher.update(vaultKey), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: iv.toString('base64'),
    c: ct.toString('base64'),
    t: tag.toString('base64'),
  }
}

export function unwrapVaultKeyFromSession(wrapped) {
  if (!wrapped) return null
  const aesKey = Buffer.from(getAesKey())
  try {
    const iv = Buffer.from(wrapped.v, 'base64')
    const ct = Buffer.from(wrapped.c, 'base64')
    const tag = Buffer.from(wrapped.t, 'base64')
    if (iv.length !== 12 || tag.length !== 16) return null
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv, { authTagLength: 16 })
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    return null
  }
}

// Creates a session and the CSRF token bound to it. The token is an HMAC of the
// session's random `sid`, so it can be re-derived from any valid session (see
// /api/csrf) but cannot be forged by someone who can only set cookies.
export function createSession({ userId, vaultKey }) {
  const sid = crypto.randomBytes(16).toString('base64url')
  const token = jwt.sign(
    {
      uid: userId,
      sid,
      vk: wrapVaultKeyForSession(vaultKey),
    },
    getSessionSecret(),
    { algorithm: 'HS256', expiresIn: SESSION_TTL_SECONDS }
  )
  return { token, csrfToken: csrfTokenForSid(sid) }
}

export function signSession(args) {
  return createSession(args).token
}

export function verifySession(token) {
  try {
    const claims = jwt.verify(token, getSessionSecret(), { algorithms: ['HS256'] })
    if (typeof claims?.uid !== 'string' || typeof claims.sid !== 'string') return null
    return claims
  } catch {
    return null
  }
}

function csrfTokenForSid(sid) {
  const key = Buffer.from(
    crypto.hkdfSync('sha256', getSessionSecret(), 'session-csrf', '', 32)
  )
  return crypto.createHmac('sha256', key).update(sid).digest('base64url')
}

export function csrfTokenForSession(session) {
  return csrfTokenForSid(session.sid)
}

// ── CSRF protection: session-bound double-submit ─────────────────────────────
// The CSRF token is derived from the session (see createSession). State-changing
// requests must send it in the X-CSRF-Token header AND the readable 2fa_csrf
// cookie, and it must match the one derived from the session cookie — so a
// cookie-injection attacker (e.g. from a sibling subdomain) who sets both
// cookies still fails, because they cannot compute the HMAC.
function generateCsrfToken() {
  return crypto.randomBytes(24).toString('base64url')
}

// True on Vercel deployments too — Vercel does not set NODE_ENV=production,
// only VERCEL=1, so we treat VERCEL as production for cookie purposes.
function isProdLike() {
  return process.env.NODE_ENV === 'production' || !!process.env.VERCEL
}

export function buildCookie(token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ]
  if (isProdLike()) {
    parts.push('Secure')
  }
  return parts.join('; ')
}

export function buildCsrfCookie(token = generateCsrfToken()) {
  const parts = [
    `${CSRF_COOKIE_NAME}=${token}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ]
  if (isProdLike()) {
    parts.push('Secure')
  }
  return { token, header: token, cookie: parts.join('; ') }
}

export function buildClearCookie() {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ]
  if (isProdLike()) {
    parts.push('Secure')
  }
  const csrfParts = [
    `${CSRF_COOKIE_NAME}=`,
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ]
  if (isProdLike()) {
    csrfParts.push('Secure')
  }
  return [parts.join('; '), csrfParts.join('; ')]
}

export function readCookieFromReq(req, name = COOKIE_NAME) {
  const raw = req.headers?.cookie || ''
  if (!raw) return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    return value || null
  }
  return null
}

// Constant-time string comparison
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

export function getSession(req) {
  const token = readCookieFromReq(req, COOKIE_NAME)
  if (!token) return null
  return verifySession(token)
}

export function getVaultKeyFromReq(req) {
  const session = getSession(req)
  if (!session) return null
  return unwrapVaultKeyFromSession(session.vk)
}

export function getUserIdFromReq(req) {
  const session = getSession(req)
  return session?.uid || null
}

function csrfValid(req, session) {
  const csrfCookie = readCookieFromReq(req, CSRF_COOKIE_NAME)
  const csrfHeader = req.headers[CSRF_HEADER_NAME]
  return (
    typeof csrfHeader === 'string' &&
    safeEqual(csrfHeader, csrfCookie) &&
    safeEqual(csrfHeader, csrfTokenForSession(session))
  )
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// ── Middleware: require a valid session and a matching CSRF token on
//    any state-changing request.
export function requireSession(req, res, next) {
  const session = getSession(req)
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (SAFE_METHODS.has(req.method.toUpperCase()) || csrfValid(req, session)) {
    return next()
  }
  return res.status(403).json({ error: 'CSRF token missing or invalid' })
}

// For logout: with no valid session there is nothing to protect, so let the
// request through to clear stale cookies; with a valid one, CSRF still applies.
export function requireCsrfIfSession(req, res, next) {
  const session = getSession(req)
  if (!session || SAFE_METHODS.has(req.method.toUpperCase()) || csrfValid(req, session)) {
    return next()
  }
  return res.status(403).json({ error: 'CSRF token missing or invalid' })
}
