import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'

// ── localStorage stub ───────────────────────────────────────────────────────
// Node has no DOM, so we provide the tiny surface groupsStorage.js touches.
// `fetch` is stubbed too so the fire-and-forget API writes never hit the wire.
function installLocalStorage() {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
  return store
}

const fetchCalls = []
globalThis.fetch = async (path, options = {}) => {
  fetchCalls.push({ path, body: options.body })
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  }
}

const store = installLocalStorage()

const {
  getCollapsedMap,
  isGroupCollapsed,
  isDatabaseGroupId,
  setGroupCollapsed,
  forgetGroupCollapsed,
  syncGroupsFromBackend,
  deleteCustomGroup,
  getCustomGroups,
} = await import('../src/lib/groupsStorage.js')

describe('isDatabaseGroupId', () => {
  test('accepts real group ids', () => {
    assert.equal(isDatabaseGroupId('grp_m1x2y3_a8f2'), true)
  })

  test('rejects the synthetic section ids', () => {
    // These sections have no row in public.groups, so writing them would 404.
    assert.equal(isDatabaseGroupId('ungrouped'), false)
    assert.equal(isDatabaseGroupId('all'), false)
    assert.equal(isDatabaseGroupId('grp_auto_github'), false)
    assert.equal(isDatabaseGroupId(''), false)
    assert.equal(isDatabaseGroupId(null), false)
    assert.equal(isDatabaseGroupId(undefined), false)
  })
})

describe('group collapse cache', () => {
  beforeEach(() => {
    store.clear()
    fetchCalls.length = 0
  })

  test('starts empty', () => {
    assert.deepEqual(getCollapsedMap(), {})
  })

  test('remembers a collapsed group', () => {
    setGroupCollapsed('grp_a', true)
    assert.equal(isGroupCollapsed('grp_a'), true)
    assert.equal(isGroupCollapsed('grp_b'), false)
  })

  test('remembers an expanded group (explicit false wins over a stale true)', () => {
    setGroupCollapsed('grp_a', true)
    setGroupCollapsed('grp_a', false)
    assert.equal(isGroupCollapsed('grp_a'), false)
    assert.equal(getCollapsedMap().grp_a, false)
  })

  test('coerces truthy non-booleans', () => {
    setGroupCollapsed('grp_a', 'yes')
    assert.equal(getCollapsedMap().grp_a, true)
  })

  test('forgetGroupCollapsed removes the entry', () => {
    setGroupCollapsed('grp_a', true)
    forgetGroupCollapsed('grp_a')
    assert.deepEqual(getCollapsedMap(), {})
  })

  test('survives a corrupt cache', () => {
    store.set('2fa_vault_group_collapsed', '{not json')
    assert.deepEqual(getCollapsedMap(), {})
    setGroupCollapsed('grp_a', true)
    assert.equal(isGroupCollapsed('grp_a'), true)
  })

  test('ignores a non-object cache value', () => {
    store.set('2fa_vault_group_collapsed', JSON.stringify(['grp_a']))
    assert.deepEqual(getCollapsedMap(), {})
  })
})

describe('syncGroupsFromBackend (collapse state)', () => {
  beforeEach(() => {
    store.clear()
    fetchCalls.length = 0
  })

  test('database values win over the local cache', () => {
    setGroupCollapsed('grp_a', false)
    setGroupCollapsed('grp_b', true)

    syncGroupsFromBackend([
      { id: 'grp_a', name: 'Global', collapsed: true },
      { id: 'grp_b', name: 'Google', collapsed: false },
    ])

    assert.equal(isGroupCollapsed('grp_a'), true)
    assert.equal(isGroupCollapsed('grp_b'), false)
  })

  test('keeps the local value when the row predates the column', () => {
    // `collapsed` is undefined for rows written before the migration ran.
    setGroupCollapsed('grp_a', true)
    syncGroupsFromBackend([{ id: 'grp_a', name: 'Global' }])
    assert.equal(isGroupCollapsed('grp_a'), true)
  })

  test('does not persist collapse state itself', () => {
    syncGroupsFromBackend([{ id: 'grp_a', name: 'Global', collapsed: true }])
    assert.equal(fetchCalls.length, 0)
  })

  test('preserves collapse entries for synthetic sections', () => {
    setGroupCollapsed('ungrouped', true)
    syncGroupsFromBackend([{ id: 'grp_a', name: 'Global', collapsed: false }])
    assert.equal(isGroupCollapsed('ungrouped'), true)
  })
})

describe('deleteCustomGroup', () => {
  beforeEach(() => {
    store.clear()
    fetchCalls.length = 0
  })

  test('drops the remembered collapse state', async () => {
    syncGroupsFromBackend([{ id: 'grp_a', name: 'Global', collapsed: true }])
    assert.equal(isGroupCollapsed('grp_a'), true)

    deleteCustomGroup('grp_a')

    assert.equal(isGroupCollapsed('grp_a'), false)
    assert.deepEqual(getCustomGroups(), [])
  })
})

// ── Server-side updateGroup ─────────────────────────────────────────────────
// Only the empty-payload guard is reachable without a live Supabase client:
// it short-circuits before any network call. Everything past that point is
// covered by the route's own validation.
process.env.SESSION_SECRET = 'a'.repeat(64)
process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-used'

const supabase = await import('../server/lib/supabase.js')

describe('updateGroup (server)', () => {
  after(() => {
    supabase._mock('getGroupById', undefined)
  })

  test('an empty update echoes the existing row', async () => {
    supabase._mock('getGroupById', async (uid, id) => ({
      id,
      user_id: uid,
      name: 'Global',
      collapsed: true,
    }))
    const row = await supabase.updateGroup('user-1', 'grp_a', {})
    assert.deepEqual(row, {
      id: 'grp_a',
      user_id: 'user-1',
      name: 'Global',
      collapsed: true,
    })
  })

  test('an empty update on a missing row returns a stub', async () => {
    supabase._mock('getGroupById', async () => null)
    const row = await supabase.updateGroup('user-1', 'grp_a', {})
    assert.deepEqual(row, { id: 'grp_a' })
  })
})
