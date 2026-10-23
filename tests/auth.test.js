import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'

// Tests for the rate limiter and CSRF middleware don't require a full app
// instance — we just verify the auth module's CSRF cookie helpers behave
// correctly and the requireSession middleware rejects bad requests.

const originalSecret = process.env.SESSION_SECRET
const originalNodeEnv = process.env.NODE_ENV
const originalVercel = process.env.VERCEL
process.env.SESSION_SECRET = 'a'.repeat(64)
process.env.NODE_ENV = 'production'

const {
  requireSession,
  requireCsrfIfSession,
  buildCsrfCookie,
  buildCookie,
  buildClearCookie,
  createSession,
  verifySession,
  csrfTokenForSession,
  readCookieFromReq,
  unwrapVaultKeyFromSession,
} = await import('../server/lib/auth.js')
import jwt from 'jsonwebtoken'

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
  }
  return res
}

function makeReq({ method = 'GET', cookies = '', headers = {} } = {}) {
  return { method, headers: { ...headers, cookie: cookies } }
}

describe('requireSession middleware', () => {
  test('rejects request with no session cookie', () => {
    let called = false
    const req = makeReq({ method: 'POST' })
    const res = makeRes()
    requireSession(req, res, () => { called = true })
    assert.equal(called, false)
    assert.equal(res.statusCode, 401)
  })

  test('rejects POST with valid session but missing CSRF', () => {
    // Forge a valid session via signSession, by piggy-backing on requireSession
    // (we just want to ensure CSRF is enforced on writes). Easiest way: import
    // signSession dynamically. To keep this test independent, we use a
    // simple module import:
    let called = false
    // Build a fake JWT — invalid signature means verifySession returns null,
    // so we'll fall through to "no session" path. Add a separate path by
    // importing signSession:
    return import('../server/lib/auth.js').then(({ signSession }) => {
      const token = signSession({ userId: 'test-uid', vaultKey: Buffer.alloc(32) })
      const req = makeReq({ method: 'POST', cookies: `2fa_session=${token}` })
      const res = makeRes()
      requireSession(req, res, () => { called = true })
      assert.equal(called, false)
      assert.equal(res.statusCode, 403)
    })
  })

  test('allows GET with valid session (no CSRF needed)', async () => {
    const { signSession } = await import('../server/lib/auth.js')
    const token = signSession({ userId: 'test-uid', vaultKey: Buffer.alloc(32) })
    let called = false
    const req = makeReq({ method: 'GET', cookies: `2fa_session=${token}` })
    const res = makeRes()
    requireSession(req, res, () => { called = true })
    assert.equal(called, true)
  })

  test('allows POST with valid session AND matching session-bound CSRF', () => {
    const { token, csrfToken } = createSession({ userId: 'test-uid', vaultKey: Buffer.alloc(32) })
    let called = false
    const req = makeReq({
      method: 'POST',
      cookies: `2fa_session=${token}; 2fa_csrf=${csrfToken}`,
      headers: { 'x-csrf-token': csrfToken },
    })
    const res = makeRes()
    requireSession(req, res, () => { called = true })
    assert.equal(called, true)
  })

  test('rejects POST when attacker sets both CSRF cookie and header to a self-chosen value', () => {
    // Cookie-injection scenario: the double-submit pair matches, but the value
    // is not the one derived from the victim's session.
    const { token } = createSession({ userId: 'test-uid', vaultKey: Buffer.alloc(32) })
    const forged = buildCsrfCookie().token
    let called = false
    const req = makeReq({
      method: 'POST',
      cookies: `2fa_session=${token}; 2fa_csrf=${forged}`,
      headers: { 'x-csrf-token': forged },
    })
    const res = makeRes()
    requireSession(req, res, () => { called = true })
    assert.equal(called, false)
    assert.equal(res.statusCode, 403)
  })

  test('rejects a CSRF token taken from a different session', () => {
    const a = createSession({ userId: 'test-uid', vaultKey: Buffer.alloc(32) })
    const b = createSession({ userId: 'test-uid', vaultKey: Buffer.alloc(32) })
    assert.notEqual(a.csrfToken, b.csrfToken)
    const req = makeReq({
      method: 'DELETE',
      cookies: `2fa_session=${a.token}; 2fa_csrf=${b.csrfToken}`,
      headers: { 'x-csrf-token': b.csrfToken },
    })
    const res = makeRes()
    let called = false
    requireSession(req, res, () => { called = true })
    assert.equal(called, false)
    assert.equal(res.statusCode, 403)
  })

  test('csrfTokenForSession is stable for a session (so /api/csrf can re-issue it)', () => {
    const { token, csrfToken } = createSession({ userId: 'u', vaultKey: Buffer.alloc(32) })
    assert.equal(csrfTokenForSession(verifySession(token)), csrfToken)
  })
})

describe('session token verification', () => {
  test('rejects tokens signed with a different algorithm (alg=none)', () => {
    const none = jwt.sign({ uid: 'u', sid: 's' }, '', { algorithm: 'none' })
    assert.equal(verifySession(none), null)
  })

  test('rejects tokens without a sid claim (pre-CSRF-binding sessions)', () => {
    const legacy = jwt.sign({ uid: 'u' }, process.env.SESSION_SECRET, { algorithm: 'HS256' })
    assert.equal(verifySession(legacy), null)
  })

  test('rejects expired tokens', () => {
    const expired = jwt.sign({ uid: 'u', sid: 's' }, process.env.SESSION_SECRET, {
      algorithm: 'HS256',
      expiresIn: -10,
    })
    assert.equal(verifySession(expired), null)
  })

  test('wrapped vault key round-trips and rejects truncated GCM tags', () => {
    const vaultKey = Buffer.alloc(32, 7)
    const { token } = createSession({ userId: 'u', vaultKey })
    const claims = verifySession(token)
    assert.equal(Buffer.compare(unwrapVaultKeyFromSession(claims.vk), vaultKey), 0)
    const shortTag = { ...claims.vk, t: Buffer.from(claims.vk.t, 'base64').subarray(0, 4).toString('base64') }
    assert.equal(unwrapVaultKeyFromSession(shortTag), null)
  })
})

describe('requireCsrfIfSession (logout)', () => {
  test('lets a request with no session through so stale cookies can be cleared', () => {
    let called = false
    requireCsrfIfSession(makeReq({ method: 'POST' }), makeRes(), () => { called = true })
    assert.equal(called, true)
  })

  test('still enforces CSRF when a valid session is present', () => {
    const { token } = createSession({ userId: 'u', vaultKey: Buffer.alloc(32) })
    const res = makeRes()
    let called = false
    requireCsrfIfSession(makeReq({ method: 'POST', cookies: `2fa_session=${token}` }), res, () => { called = true })
    assert.equal(called, false)
    assert.equal(res.statusCode, 403)
  })
})

describe('cookie parsing', () => {
  test('finds a cookie among others and keeps "=" inside the value', () => {
    const req = makeReq({ cookies: 'a=1; 2fa_session=abc=def ; b=2' })
    assert.equal(readCookieFromReq(req, '2fa_session'), 'abc=def')
  })

  test('does not match cookies whose name merely ends with the target', () => {
    const req = makeReq({ cookies: 'x2fa_session=evil' })
    assert.equal(readCookieFromReq(req, '2fa_session'), null)
  })

  test('treats an empty value as absent', () => {
    assert.equal(readCookieFromReq(makeReq({ cookies: '2fa_session=' }), '2fa_session'), null)
  })
})

describe('CSRF cookie helpers', () => {
  test('CSRF cookie uses SameSite=Lax and Secure in production', () => {
    const { cookie } = buildCsrfCookie()
    assert.ok(cookie.includes('SameSite=Lax'), `expected SameSite=Lax in: ${cookie}`)
    assert.ok(cookie.includes('Secure'), `expected Secure in: ${cookie}`)
    assert.ok(!cookie.includes('HttpOnly'), `CSRF cookie must NOT be HttpOnly`)
  })

  test('CSRF cookie uses SameSite=Lax and Secure when VERCEL=1 (no NODE_ENV)', () => {
    const saved = process.env.NODE_ENV
    delete process.env.NODE_ENV
    process.env.VERCEL = '1'
    return import('../server/lib/auth.js?vercel=1').then((mod) => {
      const { cookie } = mod.buildCsrfCookie()
      assert.ok(cookie.includes('SameSite=Lax'), `expected SameSite=Lax in: ${cookie}`)
      assert.ok(cookie.includes('Secure'), `expected Secure in: ${cookie}`)
      if (saved === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = saved
      delete process.env.VERCEL
    })
  })

  test('Session cookie is HttpOnly + SameSite=Strict + Secure', () => {
    const cookie = buildCookie('dummy')
    assert.ok(cookie.includes('HttpOnly'))
    assert.ok(cookie.includes('SameSite=Strict'))
    assert.ok(cookie.includes('Secure'))
  })

  test('Clear cookies return both session and CSRF cookie strings', () => {
    const cleared = buildClearCookie()
    assert.ok(Array.isArray(cleared))
    assert.equal(cleared.length, 2)
    assert.ok(cleared[0].startsWith('2fa_session='))
    assert.ok(cleared[1].startsWith('2fa_csrf='))
  })
})

after(() => {
  if (originalSecret === undefined) delete process.env.SESSION_SECRET
  else process.env.SESSION_SECRET = originalSecret
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalVercel === undefined) delete process.env.VERCEL
  else process.env.VERCEL = originalVercel
})
