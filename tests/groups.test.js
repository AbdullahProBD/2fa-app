import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  installLocalStorage,
  installFetch,
  getFetchCalls,
  lastGroupUpdateBody,
} from './helpers/dom.js'

const store = installLocalStorage()
installFetch()

const {
  renameCustomGroup,
  createCustomGroup,
  syncGroupsFromBackend,
  getCustomGroups,
} = await import('../src/lib/groupsStorage.js')

function seedGroup(overrides = {}) {
  syncGroupsFromBackend([
    {
      id: 'grp_a',
      name: 'GITHUB',
      logo: 'github',
      ...overrides,
    },
  ])
}

describe('group icon changes', () => {
  beforeEach(() => {
    store.clear()
    getFetchCalls().length = 0
  })

  test('the icon change reaches the database', () => {
    seedGroup()
    renameCustomGroup('grp_a', 'GITHUB', 'gitlab')

    // Regression: the logo used to be dropped here, so public.groups.logo kept
    // the old value and syncGroupsFromBackend reverted the icon on reload.
    assert.deepEqual(lastGroupUpdateBody(), { name: 'GITHUB', logo: 'gitlab' })
  })

  test('the icon change reaches the local cache', () => {
    seedGroup()
    renameCustomGroup('grp_a', 'GITHUB', 'gitlab')

    assert.equal(getCustomGroups()[0].logo, 'gitlab')
  })

  test('a custom image URL is persisted', () => {
    seedGroup()
    const dataUri = 'data:image/png;base64,iVBORw0KGgo='
    renameCustomGroup('grp_a', 'GITHUB', dataUri)

    assert.equal(getCustomGroups()[0].logo, dataUri)
    assert.equal(lastGroupUpdateBody().logo, dataUri)
  })

  test('clearing the icon persists an empty string', () => {
    seedGroup()
    renameCustomGroup('grp_a', 'GITHUB', '')

    assert.equal(getCustomGroups()[0].logo, '')
    assert.deepEqual(lastGroupUpdateBody(), { name: 'GITHUB', logo: '' })
  })

  test('a rename without a logo keeps the existing icon', () => {
    seedGroup()
    // GroupModal always passes a logo, but other callers may not — an absent
    // logo must never wipe the icon.
    renameCustomGroup('grp_a', 'WORK', undefined)

    assert.equal(getCustomGroups()[0].logo, 'github')
    assert.deepEqual(lastGroupUpdateBody(), { name: 'WORK' })
  })

  test('renaming and re-iconing in one go persists both', () => {
    seedGroup()
    renameCustomGroup('grp_a', 'WORK', 'briefcase')

    assert.deepEqual(getCustomGroups()[0], {
      id: 'grp_a',
      name: 'WORK',
      logo: 'briefcase',
      createdAt: getCustomGroups()[0].createdAt,
    })
    assert.deepEqual(lastGroupUpdateBody(), { name: 'WORK', logo: 'briefcase' })
  })

  test('the icon survives a reload round-trip', () => {
    seedGroup()
    renameCustomGroup('grp_a', 'GITHUB', 'gitlab')

    // Simulate the next login: the DB row now reports the new logo, so the
    // merge must not resurrect the old one.
    store.clear()
    syncGroupsFromBackend([{ id: 'grp_a', name: 'GITHUB', logo: 'gitlab' }])

    assert.equal(getCustomGroups()[0].logo, 'gitlab')
  })

  test('the database still wins when the local cache disagrees', () => {
    // Local cache says gitlab, but the DB never got the write.
    store.clear()
    syncGroupsFromBackend([{ id: 'grp_a', name: 'GITHUB', logo: 'github' }])

    assert.equal(getCustomGroups()[0].logo, 'github')
  })
})

describe('renameCustomGroup validation', () => {
  beforeEach(() => {
    store.clear()
    getFetchCalls().length = 0
  })

  test('rejects an empty name', () => {
    seedGroup()
    assert.throws(() => renameCustomGroup('grp_a', '   ', 'github'), /cannot be empty/)
  })

  test('rejects an unknown group', () => {
    assert.throws(() => renameCustomGroup('nope', 'WORK', 'github'), /not found/)
  })

  test('rejects a duplicate name', () => {
    seedGroup()
    syncGroupsFromBackend([{ id: 'grp_b', name: 'Google' }])
    assert.throws(
      () => renameCustomGroup('grp_a', 'GOOGLE', 'github'),
      /already exists/
    )
  })
})

describe('createCustomGroup', () => {
  beforeEach(() => {
    store.clear()
    getFetchCalls().length = 0
  })

  test('persists the icon on create', () => {
    createCustomGroup('GitLab', 'gitlab')
    assert.deepEqual(lastGroupUpdateBody(), null) // create is a POST, not a PUT
    const post = getFetchCalls().find((c) => c.method === 'POST')
    assert.equal(JSON.parse(post.body).logo, 'gitlab')
    assert.equal(getCustomGroups()[0].logo, 'gitlab')
  })
})
