import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

// End-to-end checks against the real Express app with the DB layer mocked.
process.env.SESSION_SECRET = 'b'.repeat(64)
process.env.ADMIN_USER = 'admin'
process.env.ADMIN_PASS = 'correct horse battery staple'
process.env.NODE_ENV = 'production'
process.env.VERCEL = '1' // import without starting a listener

const { default: app } = await import('../server/index.js')
const { _mock } = await import('../server/lib/supabase.js')

let server
let base
let storedUser = null
let createCalls = 0

_mock('getUserByUsername', async () => storedUser)
_mock('createUser', async (data) => {
  createCalls++
  storedUser = {
    id: '11111111-1111-4111-8111-111111111111',
    username: data.username,
    password_hash: data.passwordHash,
    kek_salt: data.kekSalt,
    kek_iterations: data.kekIterations,
    wrapped_vault_key: data.wrappedVaultKey,
    wrapped_vault_iv: data.wrappedVaultIv,
    wrapped_vault_tag: data.wrappedVaultTag,
  }
  return storedUser
})
_mock('updateUserWrappedKey', async () => {})
_mock('listAccountsByUser', async () => [])

before(async () => {
  server = createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

function post(path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function cookiesFrom(res) {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c) => !c.endsWith('='))
    .join('; ')
}

let session // { cookie, csrf }

describe('login', () => {
  test('first login with the wrong password does not claim the vault', async () => {
    const res = await post('/api/login', { username: 'admin', password: 'x'.repeat(20) })
    assert.equal(res.status, 401)
    assert.equal(createCalls, 0)
  })

  test('wrong username gets the same generic 401', async () => {
    const res = await post('/api/login', { username: 'root', password: 'x'.repeat(20) })
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: 'Invalid credentials' })
  })

  test('first login with ADMIN_PASS bootstraps and returns a session-bound CSRF token', async () => {
    const res = await post('/api/login', { username: 'admin', password: process.env.ADMIN_PASS })
    assert.equal(res.status, 200)
    assert.equal(createCalls, 1)
    const body = await res.json()
    assert.ok(body.csrfToken)
    session = { cookie: cookiesFrom(res), csrf: body.csrfToken }
    assert.match(session.cookie, /2fa_session=/)
  })

  test('subsequent login unlocks the stored vault', async () => {
    const res = await post('/api/login', { username: 'admin', password: process.env.ADMIN_PASS })
    assert.equal(res.status, 200)
    assert.equal(createCalls, 1)
  })

  test('form-encoded login bodies are not parsed (no cross-site form POSTs)', async () => {
    const res = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=admin&password=whatever-long-enough',
    })
    assert.equal(res.status, 400)
  })
})

describe('API hardening', () => {
  test('cross-origin state-changing requests are rejected before login runs', async () => {
    const res = await post(
      '/api/login',
      { username: 'admin', password: process.env.ADMIN_PASS },
      { origin: 'https://evil.example' }
    )
    assert.equal(res.status, 403)
  })

  test('same-origin Origin header is accepted', async () => {
    const res = await post(
      '/api/login',
      { username: 'admin', password: process.env.ADMIN_PASS },
      { origin: base }
    )
    assert.equal(res.status, 200)
  })

  test('responses are not cacheable', async () => {
    const res = await fetch(base + '/api/accounts', { headers: { cookie: session.cookie } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  test('unauthenticated API access is 401, unknown routes 404', async () => {
    assert.equal((await fetch(base + '/api/accounts')).status, 401)
    const res = await fetch(base + '/api/nope', { headers: { cookie: session.cookie } })
    assert.equal(res.status, 404)
  })

  test('malformed JSON yields 400, not 500', async () => {
    const res = await post('/api/login', '{"username":')
    assert.equal(res.status, 400)
  })

  test('/api/csrf re-issues the same session-bound token', async () => {
    const res = await fetch(base + '/api/csrf', { headers: { cookie: session.cookie } })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).csrfToken, session.csrf)
  })

  test('writes need the session-bound CSRF token', async () => {
    const body = { label: 'x', secret: 'JBSWY3DPEHPK3PXP' }
    const noCsrf = await post('/api/accounts', body, { cookie: session.cookie })
    assert.equal(noCsrf.status, 403)

    const forged = 'attacker-chosen-token'
    const forgedRes = await post('/api/accounts', body, {
      cookie: `${session.cookie}; 2fa_csrf=${forged}`,
      'x-csrf-token': forged,
    })
    assert.equal(forgedRes.status, 403)
  })

  test('account creation validates the secret and algorithm', async () => {
    _mock('createAccount', async (userId, rec) => ({
      id: '22222222-2222-4222-8222-222222222222',
      user_id: userId,
      ...rec,
      ciphertext: rec.encryptedSecret.ciphertext,
      iv: rec.encryptedSecret.iv,
      auth_tag: rec.encryptedSecret.authTag,
    }))
    const headers = {
      cookie: `${session.cookie}; 2fa_csrf=${session.csrf}`,
      'x-csrf-token': session.csrf,
    }
    const bad = await post('/api/accounts', { label: 'x', secret: 'JBSW!Y3DPEHPK3PXP' }, headers)
    assert.equal(bad.status, 400)

    const ok = await post(
      '/api/accounts',
      { label: 'x', secret: 'jbsw y3dp ehpk 3pxp', algorithm: 'sha256', digits: 6.4, logo: 'http://x.test/a.png' },
      headers
    )
    assert.equal(ok.status, 201)
    const { account } = await ok.json()
    assert.equal(account.algorithm, 'SHA256')
    assert.equal(account.digits, 6)
    assert.equal(account.logo, '')
  })
})

describe('groups', () => {
  test('keeps a full-size data-URI logo and drops http logos', async () => {
    _mock('createGroup', async (userId, group) => ({ id: 'grp_test', ...group }))
    const headers = {
      cookie: `${session.cookie}; 2fa_csrf=${session.csrf}`,
      'x-csrf-token': session.csrf,
    }
    const logo = 'data:image/png;base64,' + 'A'.repeat(10000)
    const kept = await post('/api/groups', { name: 'Work', logo }, headers)
    assert.equal((await kept.json()).group.logo, logo)
    const dropped = await post('/api/groups', { name: 'Work', logo: 'http://x.test/a.png' }, headers)
    assert.equal((await dropped.json()).group.logo, '')
  })
})

describe('qr-parse', () => {
  function pngHeader(width, height) {
    const buf = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf)
    buf.writeUInt32BE(13, 8)
    buf.write('IHDR', 12, 'latin1')
    buf.writeUInt32BE(width, 16)
    buf.writeUInt32BE(height, 20)
    buf[24] = 8
    buf[25] = 6
    return buf
  }
  const headers = () => ({
    cookie: `${session.cookie}; 2fa_csrf=${session.csrf}`,
    'x-csrf-token': session.csrf,
  })

  test('rejects PNGs that declare huge dimensions before decoding', async () => {
    const dataUri = 'data:image/png;base64,' + pngHeader(60000, 60000).toString('base64')
    const res = await post('/api/qr-parse', { dataUri }, headers())
    assert.equal(res.status, 413)
  })

  test('rejects non-PNG bytes labelled as PNG', async () => {
    const dataUri = 'data:image/png;base64,' + Buffer.from('not a png at all, really').toString('base64')
    const res = await post('/api/qr-parse', { dataUri }, headers())
    assert.equal(res.status, 400)
  })

  test('keeps the full account label when it contains several colons', async () => {
    const uri = 'otpauth://totp/Acme:alice:work?secret=JBSWY3DPEHPK3PXP'
    const res = await post('/api/qr-parse', { uri }, headers())
    assert.equal(res.status, 200)
    const { data } = await res.json()
    assert.equal(data.issuer, 'Acme')
    assert.equal(data.label, 'alice:work')
  })
})

describe('logout', () => {
  test('works without a session and clears both cookies', async () => {
    const res = await post('/api/logout', {})
    assert.equal(res.status, 200)
    assert.equal(res.headers.getSetCookie().length, 2)
  })

  test('requires CSRF when a session exists', async () => {
    const res = await post('/api/logout', {}, { cookie: session.cookie })
    assert.equal(res.status, 403)
  })
})
