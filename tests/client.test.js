import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installLocalStorage, withSilencedConsole } from './helpers/dom.js'

const store = installLocalStorage()

const { normalizeSecret, validateSecret } = await import('../src/lib/otp.js')
const storage = await import('../src/lib/groupsStorage.js')
const { api, primeCsrfCache, setUnauthorizedHandler } = await import('../src/lib/api.js')

// A scripted fetch: each call shifts the next response off the queue.
function scriptFetch(responses) {
  const calls = []
  globalThis.fetch = async (path, options = {}) => {
    calls.push({ path, options })
    const r = responses.shift()
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => body, json: async () => JSON.parse(body) }
  }
  return calls
}

describe('secret normalisation', () => {
  test('strips spaces, dashes and padding and upper-cases', () => {
    assert.equal(normalizeSecret(' jbsw y3dp-ehpk 3pxp=== '), 'JBSWY3DPEHPK3PXP')
  })

  test('validateSecret flags bad input', () => {
    assert.match(validateSecret(''), /required/)
    assert.match(validateSecret('ABC1DEFGH'), /Base32/)
    assert.match(validateSecret('ABCDEF'), /too short/)
    assert.equal(validateSecret('JBSWY3DPEHPK3PXP'), '')
  })
})

describe('swapWithinGroup', () => {
  const list = [
    { id: 'a', group: 'Work' },
    { id: 'b', group: '' },
    { id: 'c', group: 'work' },
    { id: 'd', group: '' },
  ]

  test('swaps inside a group and leaves other slots untouched', () => {
    const out = storage.swapWithinGroup(list, 'Work', 'a', 'c')
    assert.deepEqual(out.map((x) => x.id), ['c', 'b', 'a', 'd'])
  })

  test('works for the ungrouped section (empty name)', () => {
    const out = storage.swapWithinGroup(list, '', 'b', 'd')
    assert.deepEqual(out.map((x) => x.id), ['a', 'd', 'c', 'b'])
  })

  test('returns null when nothing can be swapped', () => {
    assert.equal(storage.swapWithinGroup(list, 'Work', 'a', 'a'), null)
    assert.equal(storage.swapWithinGroup(list, 'Work', 'a', 'b'), null)
  })
})

describe('local cache hygiene', () => {
  beforeEach(() => store.clear())

  test('getCustomGroups drops malformed entries', async () => {
    store.set('2fa_vault_custom_groups', JSON.stringify([null, 3, { id: 'x' }, { id: 'g', name: 'Ok' }]))
    assert.deepEqual(storage.getCustomGroups().map((g) => g.id), ['g'])
  })

  test('clearVaultCache removes every per-user key', () => {
    for (const k of [
      '2fa_vault_custom_groups',
      '2fa_vault_account_meta',
      '2fa_vault_group_collapsed',
      '2fa_vault_account_order',
      '2fa_vault_group_order',
    ]) store.set(k, '[]')
    storage.clearVaultCache()
    assert.equal(store.size, 0)
  })

  test('forgetGroupCollapsed ignores inherited property names', () => {
    storage.setGroupCollapsed('g1', true)
    storage.forgetGroupCollapsed('constructor')
    assert.equal(storage.getCollapsedMap().g1, true)
  })

  test('authoritative sync prunes groups the database no longer has', async () => {
    await withSilencedConsole(async () => {
      storage.syncGroupsFromBackend([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
      storage.syncGroupsFromBackend([{ id: 'a', name: 'A' }], { authoritative: true })
    })
    assert.deepEqual(storage.getCustomGroups().map((g) => g.id), ['a'])
  })

  test('an empty authoritative list never wipes local groups', () => {
    storage.syncGroupsFromBackend([{ id: 'a', name: 'A' }])
    storage.syncGroupsFromBackend([], { authoritative: true })
    assert.equal(storage.getCustomGroups().length, 1)
  })
})

describe('api client', () => {
  beforeEach(() => {
    primeCsrfCache('tok-1')
    setUnauthorizedHandler(null)
  })

  test('writes send the CSRF header and same-origin credentials', async () => {
    const calls = scriptFetch([{ status: 200, body: { ok: true } }])
    await api.createGroup({ name: 'x' })
    assert.equal(calls[0].options.headers['X-CSRF-Token'], 'tok-1')
    assert.equal(calls[0].options.credentials, 'same-origin')
    assert.ok(calls[0].options.signal)
  })

  test('reads do not send the CSRF header', async () => {
    const calls = scriptFetch([{ status: 200, body: { accounts: [] } }])
    await api.listAccounts()
    assert.equal(calls[0].options.headers['X-CSRF-Token'], undefined)
  })

  test('a CSRF 403 refreshes the token and retries once', async () => {
    const calls = scriptFetch([
      { status: 403, body: { error: 'CSRF token missing or invalid' } },
      { status: 200, body: { csrfToken: 'tok-2' } },
      { status: 200, body: { ok: true } },
    ])
    const out = await api.deleteGroup('g')
    assert.deepEqual(out, { ok: true })
    assert.equal(calls.length, 3)
    assert.equal(calls[2].options.headers['X-CSRF-Token'], 'tok-2')
  })

  test('a non-CSRF 403 is not retried', async () => {
    const calls = scriptFetch([{ status: 403, body: { error: 'Forbidden' } }])
    await assert.rejects(api.deleteGroup('g'), /Forbidden/)
    assert.equal(calls.length, 1)
  })

  test('401 fires the unauthorized handler, except for login', async () => {
    let fired = 0
    setUnauthorizedHandler(() => fired++)
    scriptFetch([{ status: 401, body: { error: 'Unauthorized' } }])
    await assert.rejects(api.listAccounts(), (e) => e.status === 401)
    assert.equal(fired, 1)
    scriptFetch([{ status: 401, body: { error: 'Invalid credentials' } }])
    await assert.rejects(api.login('u', 'p'), /Invalid credentials/)
    assert.equal(fired, 1)
  })

  test('HTML error pages are not shown to the user', async () => {
    scriptFetch([{ status: 502, body: '<html><body>Bad gateway</body></html>' }])
    await assert.rejects(api.listAccounts(), (e) => e.message === 'Request failed (HTTP 502)' && e.status === 502)
  })

  test('non-object JSON bodies do not crash error handling', async () => {
    scriptFetch([{ status: 500, body: 'null' }])
    await assert.rejects(api.listAccounts(), /HTTP 500/)
  })

  test('network failures become a friendly error', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed')
    }
    await assert.rejects(api.listAccounts(), (e) => /Network error/.test(e.message) && e.status === 0)
  })

  test('the HOTP counter is URL-encoded', async () => {
    const calls = scriptFetch([{ status: 200, body: {} }])
    await api.getCode('id', 5)
    assert.equal(calls[0].path, '/api/totp/id?counter=5')
  })
})
