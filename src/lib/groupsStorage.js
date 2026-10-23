import { api } from './api.js'

const GROUPS_STORAGE_KEY = '2fa_vault_custom_groups'
const ACCOUNT_META_KEY = '2fa_vault_account_meta'
const COLLAPSE_KEY = '2fa_vault_group_collapsed'

// Listeners for multi-component reactive sync
const listeners = new Set()
function notify() {
  listeners.forEach((fn) => {
    try {
      fn()
    } catch (e) {
      console.error(e)
    }
  })
}

export function subscribeGroups(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getCustomGroups() {
  try {
    const raw = localStorage.getItem(GROUPS_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      // Drop malformed entries so callers can rely on `g.id` / `g.name` being strings.
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (g) => g && typeof g === 'object' && typeof g.id === 'string' && typeof g.name === 'string'
        )
      }
    }
  } catch (e) {
    console.error('Failed to read custom groups from localStorage', e)
  }
  return []
}

export function saveCustomGroups(groups) {
  try {
    localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groups))
    notify()
  } catch (e) {
    console.error('Failed to save custom groups to localStorage', e)
  }
}

// Merge groups retrieved from database into local cache
// `authoritative` (a full list from GET /api/groups) also drops local groups the
// database no longer has; partial overlays leave local-only groups alone.
export function syncGroupsFromBackend(backendGroups, { authoritative = false } = {}) {
  if (!Array.isArray(backendGroups)) return
  const local = getCustomGroups()
  const map = new Map()
  // An empty list could also mean a missing table, so only prune when non-empty.
  const backendIds = new Set(backendGroups.filter((g) => g && g.id).map((g) => g.id))
  const prune = authoritative && backendIds.size > 0
  // 1. Add local groups
  local.forEach((g) => {
    if (g && g.name && !(prune && !backendIds.has(g.id))) map.set(g.name.toLowerCase(), g)
  })
  // 2. Overlay backend groups
  backendGroups.forEach((g) => {
    if (g && g.name) {
      const existing = map.get(g.name.toLowerCase()) || {}
      map.set(g.name.toLowerCase(), {
        ...existing,
        id: g.id || existing.id || ('grp_' + Date.now()),
        name: g.name,
        logo: g.logo || existing.logo || '',
        createdAt: g.created_at || g.createdAt || new Date().toISOString(),
      })
    }
  })
  const merged = Array.from(map.values())
  saveCustomGroups(merged)
  applyBackendCollapseState(backendGroups)
  return merged
}

export function createCustomGroup(name, logo = '') {
  const trimmed = (name || '').trim()
  if (!trimmed) throw new Error('Group name cannot be empty')
  const groups = getCustomGroups()
  const exists = groups.some((g) => g.name.toLowerCase() === trimmed.toLowerCase())
  if (exists) throw new Error(`Group "${trimmed}" already exists`)

  const newGroup = {
    id: 'grp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    name: trimmed,
    logo: logo || '',
    createdAt: new Date().toISOString(),
  }
  saveCustomGroups([...groups, newGroup])

  // Persist to database in background
  api.createGroup({ id: newGroup.id, name: trimmed, logo }).catch((err) => {
    console.warn('[groupsStorage] Failed to save group to DB:', err?.message)
  })

  return newGroup
}

// `newLogo` distinguishes "leave the icon alone" (undefined/null) from
// "the user explicitly cleared it" (an empty string), so a plain rename does
// not wipe the icon and an icon-only change does not rename anything.
export function renameCustomGroup(groupId, newName, newLogo = null) {
  const trimmed = (newName || '').trim()
  if (!trimmed) throw new Error('Group name cannot be empty')
  const groups = getCustomGroups()
  const target = groups.find((g) => g.id === groupId)
  if (!target) throw new Error('Group not found')

  const duplicate = groups.some(
    (g) => g.id !== groupId && g.name.toLowerCase() === trimmed.toLowerCase()
  )
  if (duplicate) throw new Error(`Group "${trimmed}" already exists`)

  const oldName = target.name
  const wantsLogo = typeof newLogo === 'string'
  const updated = groups.map((g) =>
    g.id === groupId
      ? { ...g, name: trimmed, ...(wantsLogo ? { logo: newLogo } : {}) }
      : g
  )
  saveCustomGroups(updated)

  // Also update account metadata mapped to this old group name
  try {
    const meta = getAllAccountMeta()
    let changed = false
    for (const [accId, data] of Object.entries(meta)) {
      if (data.group === oldName || data.groupId === groupId) {
        meta[accId] = { ...data, group: trimmed, groupId }
        changed = true
      }
    }
    if (changed) {
      localStorage.setItem(ACCOUNT_META_KEY, JSON.stringify(meta))
    }
  } catch (e) {
    console.error('Failed to update account meta on group rename', e)
  }

  // Persist rename (and any icon change) to the database in background.
  // The logo must go to public.groups too — otherwise the next
  // syncGroupsFromBackend() overlays the stale DB value and the icon reverts.
  api
    .updateGroup(groupId, wantsLogo ? { name: trimmed, logo: newLogo } : { name: trimmed })
    .catch((err) => {
      console.warn('[groupsStorage] Failed to rename group in DB:', err?.message)
    })

  notify()
  return trimmed
}

export function deleteCustomGroup(groupId) {
  const groups = getCustomGroups()
  const target = groups.find((g) => g.id === groupId)
  if (!target) return
  const oldName = target.name

  const updated = groups.filter((g) => g.id !== groupId)
  saveCustomGroups(updated)

  // Drop the remembered accordion state so a future group that reuses the ID
  // (or name) doesn't inherit a stale "collapsed" flag.
  forgetGroupCollapsed(groupId)

  // Clear group assignment from accounts in this group
  try {
    const meta = getAllAccountMeta()
    let changed = false
    for (const [accId, data] of Object.entries(meta)) {
      if (data.group === oldName || data.groupId === groupId) {
        meta[accId] = { ...data, group: '', groupId: '' }
        changed = true
      }
    }
    if (changed) {
      localStorage.setItem(ACCOUNT_META_KEY, JSON.stringify(meta))
    }
  } catch (e) {
    console.error('Failed to clean account meta on group delete', e)
  }

  // Persist delete to database in background — server looks up the group
  // name from the DB before clearing assignments, so we don't need to send it.
  api.deleteGroup(groupId).catch((err) => {
    console.warn('[groupsStorage] Failed to delete group from DB:', err?.message)
  })

  notify()
}

// ── Group collapse state ─────────────────────────────────────────────────────
// The database is the source of truth (a `collapsed` column on public.groups),
// but we also mirror it in localStorage so the very first render after a login
// shows the correct accordion layout without waiting on the network. Sections
// that have no database row (the "Ungrouped" bucket and auto-derived issuer
// groups) are remembered locally only, since there is nowhere to persist them.
export function getCollapsedMap() {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed
      }
    }
  } catch (e) {
    console.error('Failed to read group collapse state', e)
  }
  return {}
}

function writeCollapsedMap(map) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map))
  } catch (e) {
    console.error('Failed to save group collapse state', e)
  }
  return map
}

// Only real, user-created groups exist as rows in public.groups. The synthetic
// section IDs used by the dashboard must never be written to the API.
export function isDatabaseGroupId(groupId) {
  if (typeof groupId !== 'string' || !groupId) return false
  if (groupId === 'ungrouped' || groupId === 'all') return false
  if (groupId.startsWith('grp_auto_')) return false
  return true
}

export function isGroupCollapsed(groupId, map = getCollapsedMap()) {
  return map[groupId] === true
}

// Record a collapsed/expanded toggle in the local mirror. The caller is
// responsible for pushing the value to the database, so the UI can update
// synchronously without waiting on the network.
export function setGroupCollapsed(groupId, collapsed) {
  const map = getCollapsedMap()
  map[groupId] = Boolean(collapsed)
  return writeCollapsedMap(map)
}

export function forgetGroupCollapsed(groupId) {
  const map = getCollapsedMap()
  if (!Object.prototype.hasOwnProperty.call(map, groupId)) return map
  delete map[groupId]
  return writeCollapsedMap(map)
}

// Overlay the authoritative DB values onto the local cache on login. Groups
// whose row predates the `collapsed` column come back as `undefined`; we keep
// whatever the local cache has in that case so nothing is lost.
function applyBackendCollapseState(backendGroups) {
  const map = getCollapsedMap()
  let changed = false
  backendGroups.forEach((g) => {
    if (!g || !g.id) return
    if (typeof g.collapsed !== 'boolean') return
    if (map[g.id] === g.collapsed) return
    map[g.id] = g.collapsed
    changed = true
  })
  if (changed) writeCollapsedMap(map)
  return map
}

// ── Account metadata (Group + Logo per account) ───────────────────────────
export function getAllAccountMeta() {
  try {
    const raw = localStorage.getItem(ACCOUNT_META_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    }
  } catch (e) {
    console.error('Failed to read account metadata', e)
  }
  return {}
}

export function getAccountMeta(accountId) {
  const all = getAllAccountMeta()
  const own = Object.prototype.hasOwnProperty.call(all, accountId) ? all[accountId] : null
  return own && typeof own === 'object' ? own : { group: '', logo: '' }
}

export function setAccountMeta(accountId, meta) {
  try {
    const all = getAllAccountMeta()
    const prev = Object.prototype.hasOwnProperty.call(all, accountId) ? all[accountId] : null
    all[accountId] = {
      ...(prev && typeof prev === 'object' ? prev : {}),
      ...meta,
    }
    localStorage.setItem(ACCOUNT_META_KEY, JSON.stringify(all))
    notify()
  } catch (e) {
    console.error('Failed to save account metadata', e)
  }
}

// ── Custom-order cache ──────────────────────────────────────────────────────
// When the user drags items around, the new order is persisted to the
// database, but we also mirror it in localStorage so the very next render
// (before the API call returns) can use the same order. This keeps things
// consistent across reloads even when the network round-trip is slow.
const ACCOUNT_ORDER_KEY = '2fa_vault_account_order'
const GROUP_ORDER_KEY = '2fa_vault_group_order'

function readOrder(key) {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed
    }
  } catch {
    /* ignore corrupt cache */
  }
  return []
}

function writeOrder(key, ids) {
  try {
    localStorage.setItem(key, JSON.stringify(ids))
  } catch (e) {
    console.error('Failed to persist order cache', e)
  }
}

export function getCachedAccountOrder() {
  return readOrder(ACCOUNT_ORDER_KEY)
}

export function setCachedAccountOrder(ids) {
  if (!Array.isArray(ids)) return
  writeOrder(ACCOUNT_ORDER_KEY, ids)
}

export function getCachedGroupOrder() {
  return readOrder(GROUP_ORDER_KEY)
}

export function setCachedGroupOrder(ids) {
  if (!Array.isArray(ids)) return
  writeOrder(GROUP_ORDER_KEY, ids)
}

// Returns a new list with `sourceId` and `targetId` swapped inside the section
// whose group name is `groupName` ('' = ungrouped). Accounts in other sections
// keep their exact positions. Returns null when there is nothing to swap.
export function swapWithinGroup(accounts, groupName, sourceId, targetId) {
  if (!Array.isArray(accounts) || sourceId === targetId) return null
  const key = (groupName || '').toLowerCase()
  const keyOf = (a) => (a.group || '').toLowerCase()
  const slice = accounts.filter((a) => keyOf(a) === key)
  const sIdx = slice.findIndex((a) => a.id === sourceId)
  const tIdx = slice.findIndex((a) => a.id === targetId)
  if (sIdx === -1 || tIdx === -1) return null
  const swapped = slice.slice()
  swapped[sIdx] = slice[tIdx]
  swapped[tIdx] = slice[sIdx]
  let i = 0
  return accounts.map((a) => (keyOf(a) === key ? swapped[i++] : a))
}

// Wipes every per-user cache kept in localStorage. Called on logout / session
// expiry so the next person on a shared browser doesn't see this vault's
// group names, icons or layout. The database remains the source of truth.
export function clearVaultCache() {
  try {
    for (const k of [
      GROUPS_STORAGE_KEY,
      ACCOUNT_META_KEY,
      COLLAPSE_KEY,
      ACCOUNT_ORDER_KEY,
      GROUP_ORDER_KEY,
    ]) {
      localStorage.removeItem(k)
    }
  } catch (e) {
    console.error('Failed to clear vault cache', e)
  }
}

// Apply a cached order to a freshly-fetched list of items. Items not present
// in the cache (e.g. just-created accounts) are appended at the end, preserving
// their existing relative order.
export function applyCachedOrder(items, cachedIds, getId = (x) => x.id) {
  if (!Array.isArray(items) || items.length === 0) return items
  if (!Array.isArray(cachedIds) || cachedIds.length === 0) return items
  const byId = new Map(items.map((it) => [getId(it), it]))
  const ordered = []
  const used = new Set()
  for (const id of cachedIds) {
    if (byId.has(id) && !used.has(id)) {
      ordered.push(byId.get(id))
      used.add(id)
    }
  }
  for (const it of items) {
    const id = getId(it)
    if (!used.has(id)) ordered.push(it)
  }
  return ordered
}
