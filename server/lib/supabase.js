import { createClient } from '@supabase/supabase-js'

let _client = null

export function getSupabase() {
  if (_client) return _client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env vars.'
    )
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _client
}

// ── Test-only in-memory mock ──────────────────────────────────────────────────
const mocks = {}
export function _mock(name, fn) {
  mocks[name] = fn
}

export function publicAccount(row) {
  return {
    id: row.id,
    label: row.label,
    issuer: row.issuer,
    type: row.type,
    digits: row.digits,
    period: row.period,
    algorithm: row.algorithm,
    counter: row.counter ?? 0,
    group: row.group_name !== undefined && row.group_name !== null
      ? row.group_name
      : (row.group || ''),
    logo: row.logo || '',
    position: typeof row.position === 'number' ? row.position : 0,
    createdAt: row.created_at,
  }
}

export function serializeAccount(row) {
  return {
    id: row.id,
    label: row.label,
    issuer: row.issuer,
    type: row.type,
    digits: row.digits,
    period: row.period,
    algorithm: row.algorithm,
    counter: row.counter ?? 0,
    group: row.group_name !== undefined && row.group_name !== null
      ? row.group_name
      : (row.group || ''),
    logo: row.logo || '',
    createdAt: row.created_at,
    encryptedSecret: {
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
    },
  }
}


export async function getUserByUsername(username) {
  if (mocks.getUserByUsername) return mocks.getUserByUsername(username)
  const sb = getSupabase()
  const { data, error } = await sb
    .from('users')
    .select('*')
    .eq('username', username)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function createUser(data) {
  if (mocks.createUser) return mocks.createUser(data)
  const sb = getSupabase()
  const { data: row, error } = await sb
    .from('users')
    .insert({
      username: data.username,
      password_hash: data.passwordHash,
      kek_salt: data.kekSalt,
      kek_iterations: data.kekIterations,
      wrapped_vault_key: data.wrappedVaultKey,
      wrapped_vault_iv: data.wrappedVaultIv,
      wrapped_vault_tag: data.wrappedVaultTag,
    })
    .select()
    .single()
  if (error) throw error
  return row
}

export async function updateUserWrappedKey(userId, data) {
  if (mocks.updateUserWrappedKey) return mocks.updateUserWrappedKey(userId, data)
  const sb = getSupabase()
  const { error } = await sb
    .from('users')
    .update({
      wrapped_vault_key: data.wrappedVaultKey,
      wrapped_vault_iv: data.wrappedVaultIv,
      wrapped_vault_tag: data.wrappedVaultTag,
    })
    .eq('id', userId)
  if (error) throw error
}

export async function listAccountsByUser(userId) {
  if (mocks.listAccountsByUser) return mocks.listAccountsByUser(userId)
  const sb = getSupabase()
  const { data, error } = await sb
    .from('accounts')
    .select('*')
    .eq('user_id', userId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function getAccountById(userId, id) {
  if (mocks.getAccountById) return mocks.getAccountById(userId, id)
  const sb = getSupabase()
  const { data, error } = await sb
    .from('accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function createAccount(userId, rec) {
  if (mocks.createAccount) return mocks.createAccount(userId, rec)
  const sb = getSupabase()
  const basePayload = {
    user_id: userId,
    label: rec.label,
    issuer: rec.issuer,
    type: rec.type,
    digits: rec.digits,
    period: rec.period,
    algorithm: rec.algorithm,
    counter: rec.counter,
    ciphertext: rec.encryptedSecret.ciphertext,
    iv: rec.encryptedSecret.iv,
    auth_tag: rec.encryptedSecret.authTag,
  }

  // Attempt insert with group_name and logo if provided
  try {
    const payloadWithMeta = {
      ...basePayload,
      ...(rec.group_name ? { group_name: rec.group_name } : {}),
      ...(rec.logo ? { logo: rec.logo } : {}),
    }
    const { data, error } = await sb
      .from('accounts')
      .insert(payloadWithMeta)
      .select()
      .single()
    if (!error) return data
    // If column doesn't exist in Supabase yet, retry with base payload
    if (error.message?.includes('column') || error.code === '42703') {
      console.warn('[supabase] group_name/logo columns not yet in DB, inserting base payload')
    } else {
      throw error
    }
  } catch (err) {
    if (!err.message?.includes('column') && err.code !== '42703') throw err
  }

  const { data, error } = await sb
    .from('accounts')
    .insert(basePayload)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateAccount(userId, id, updates) {
  if (mocks.updateAccount) return mocks.updateAccount(userId, id, updates)
  const sb = getSupabase()
  const payload = {}
  if (updates.label !== undefined) payload.label = updates.label
  if (updates.issuer !== undefined) payload.issuer = updates.issuer
  if (updates.group_name !== undefined) payload.group_name = updates.group_name
  if (updates.logo !== undefined) payload.logo = updates.logo

  const { data, error } = await sb
    .from('accounts')
    .update(payload)
    .eq('user_id', userId)
    .eq('id', id)
    .select()
    .single()
  if (!error) return data
  if (error.message?.includes('column') || error.code === '42703') {
    // Retry without group_name and logo if columns do not exist
    delete payload.group_name
    delete payload.logo
    if (Object.keys(payload).length > 0) {
      const { data: fallbackData, error: fallbackError } = await sb
        .from('accounts')
        .update(payload)
        .eq('user_id', userId)
        .eq('id', id)
        .select()
        .single()
      if (fallbackError) throw fallbackError
      return fallbackData
    }
    return await getAccountById(userId, id)
  }
  throw error
}


export async function deleteAccountById(userId, id) {
  if (mocks.deleteAccountById) return mocks.deleteAccountById(userId, id)
  const sb = getSupabase()
  const { error } = await sb
    .from('accounts')
    .delete()
    .eq('user_id', userId)
    .eq('id', id)
  if (error) throw error
}

// ── Groups Database Methods ──────────────────────────────────────────────────

export async function getGroupById(userId, groupId) {
  if (mocks.getGroupById) return mocks.getGroupById(userId, groupId)
  const sb = getSupabase()
  try {
    const { data, error } = await sb
      .from('groups')
      .select('*')
      .eq('user_id', userId)
      .eq('id', groupId)
      .maybeSingle()
    if (error) {
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        return null
      }
      throw error
    }
    return data
  } catch (err) {
    if (err.code === '42P01' || err.message?.includes('does not exist')) {
      return null
    }
    throw err
  }
}

export async function listGroupsByUser(userId) {
  if (mocks.listGroupsByUser) return mocks.listGroupsByUser(userId)
  const sb = getSupabase()
  try {
    const { data, error } = await sb
      .from('groups')
      .select('*')
      .eq('user_id', userId)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
    if (!error && Array.isArray(data)) return data
    if (error && (error.code === '42P01' || error.message?.includes('relation') || error.message?.includes('does not exist'))) {
      // Table 'groups' does not exist yet; fall back to extracting groups from accounts
      const accounts = await listAccountsByUser(userId)
      const groupMap = new Map()
      accounts.forEach((acc) => {
        const gName = (acc.group_name || acc.group || '').trim()
        if (gName && gName.toLowerCase() !== 'general' && !groupMap.has(gName.toLowerCase())) {
          groupMap.set(gName.toLowerCase(), {
            id: 'grp_' + gName.toLowerCase().replace(/\s+/g, '_'),
            name: gName,
            logo: acc.logo || '',
            position: typeof acc.position === 'number' ? acc.position : 0,
            collapsed: false,
            created_at: acc.created_at,
          })
        }
      })
      return Array.from(groupMap.values())
    }
    throw error
  } catch (err) {
    if (err.code === '42P01' || err.message?.includes('does not exist')) {
      return []
    }
    throw err
  }
}

export async function createGroup(userId, group) {
  if (mocks.createGroup) return mocks.createGroup(userId, group)
  const sb = getSupabase()
  const safeId =
    (typeof group.id === 'string' && /^[A-Za-z0-9_:-]{1,64}$/.test(group.id) && group.id) ||
    'grp_' +
      Date.now().toString(36) +
      '_' +
      Math.random().toString(36).slice(2, 8)
  const payload = {
    id: safeId,
    user_id: userId,
    name: group.name.trim(),
    logo: group.logo || '',
  }
  try {
    const { data, error } = await sb
      .from('groups')
      .insert(payload)
      .select()
      .single()
    if (!error) return data
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      // Table doesn't exist yet; return payload as fallback
      return { ...payload, created_at: new Date().toISOString() }
    }
    throw error
  } catch (err) {
    if (err.code === '42P01' || err.message?.includes('does not exist')) {
      return { ...payload, created_at: new Date().toISOString() }
    }
    throw err
  }
}

export async function updateGroup(userId, groupId, updates) {
  if (mocks.updateGroup) return mocks.updateGroup(userId, groupId, updates)
  const payload = {}
  if (updates.name !== undefined) payload.name = updates.name.trim()
  if (updates.logo !== undefined) payload.logo = updates.logo
  // Accordion state. The column is NOT NULL with a `false` default, so an
  // explicit write is only needed when the client actually toggles it.
  if (updates.collapsed !== undefined) payload.collapsed = Boolean(updates.collapsed)

  // Nothing to write (e.g. a request that only carried fields the schema does
  // not have yet) — echo the current row instead of issuing an empty UPDATE,
  // which PostgREST rejects.
  if (Object.keys(payload).length === 0) {
    const existing = await getGroupById(userId, groupId)
    if (existing) return existing
    return { id: groupId }
  }

  const sb = getSupabase()
  try {
    const { data, error } = await sb
      .from('groups')
      .update(payload)
      .eq('user_id', userId)
      .eq('id', groupId)
      .select()
      .single()
    if (!error) return data
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return { id: groupId, ...payload }
    }
    throw error
  } catch (err) {
    if (err.code === '42P01' || err.message?.includes('does not exist')) {
      return { id: groupId, ...payload }
    }
    throw err
  }
}

export async function deleteGroup(userId, groupId, oldName) {
  if (mocks.deleteGroup) return mocks.deleteGroup(userId, groupId, oldName)
  const sb = getSupabase()
  try {
    await sb
      .from('groups')
      .delete()
      .eq('user_id', userId)
      .eq('id', groupId)
  } catch (err) {
    // ignore if table doesn't exist
  }

  // Also clear group assignment on all accounts belonging to this group
  if (oldName) {
    try {
      await sb
        .from('accounts')
        .update({ group_name: '' })
        .eq('user_id', userId)
        .eq('group_name', oldName)
    } catch (err) {
      // ignore column error if column does not exist
    }
  }
}

// ── Reorder helpers ──────────────────────────────────────────────────────
// `orderedIds` is the full ordered list of IDs the client wants (a re-ordered
// slice is not accepted — we always assign positions for the whole list, so
// the DB stays in a consistent state even after partial reorders).

// Number of items we are willing to reorder in a single request.
const REORDER_MAX = 500

// Step used to space out positions. Doubles can hold ~15 decimal digits of
// precision; 1000 * 500 = 500 000, so 0.002-step between adjacent rows
// leaves plenty of headroom for new inserts between two existing rows.
const POSITION_STEP = 1000

function assignPositions(count) {
  const out = new Array(count)
  for (let i = 0; i < count; i++) out[i] = (i + 1) * POSITION_STEP
  return out
}

export async function reorderAccountsByUser(userId, orderedIds) {
  if (mocks.reorderAccountsByUser) return mocks.reorderAccountsByUser(userId, orderedIds)
  if (!Array.isArray(orderedIds)) {
    throw new Error('orderedIds must be an array')
  }
  if (orderedIds.length > REORDER_MAX) {
    throw new Error(`Too many items to reorder (max ${REORDER_MAX})`)
  }
  // First, fetch the rows the user owns so we never write a position to an
  // account owned by someone else.
  const sb = getSupabase()
  const { data: rows, error: fetchErr } = await sb
    .from('accounts')
    .select('id')
    .eq('user_id', userId)
  if (fetchErr) throw fetchErr
  const ownedIds = new Set((rows || []).map((r) => r.id))

  // Drop any IDs that don't belong to the user, then dedupe, preserving order.
  const clean = []
  const seen = new Set()
  for (const id of orderedIds) {
    if (typeof id !== 'string') continue
    if (!ownedIds.has(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    clean.push(id)
  }
  if (clean.length === 0) return { updated: 0 }

  const positions = assignPositions(clean.length)

  // Batch update: run each update in parallel. Postgres handles concurrent
  // UPDATEs on the same row correctly because the last write wins, but
  // assigning distinct positions per row means there are no conflicts.
  const results = await Promise.allSettled(
    clean.map((id, idx) =>
      sb.from('accounts')
        .update({ position: positions[idx] })
        .eq('user_id', userId)
        .eq('id', id)
    )
  )
  let updated = 0
  for (const r of results) {
    if (r.status === 'fulfilled' && !r.value.error) updated++
    else if (r.status === 'fulfilled' && r.value.error) {
      // Ignore missing-column errors gracefully — old DBs without `position`
      // will keep working in read-only mode, just without reordering.
      if (!r.value.error.message?.includes('column') && r.value.error.code !== '42703') {
        throw r.value.error
      }
    } else if (r.status === 'rejected') {
      throw r.reason
    }
  }
  return { updated }
}

export async function reorderGroupsByUser(userId, orderedIds) {
  if (mocks.reorderGroupsByUser) return mocks.reorderGroupsByUser(userId, orderedIds)
  if (!Array.isArray(orderedIds)) {
    throw new Error('orderedIds must be an array')
  }
  if (orderedIds.length > REORDER_MAX) {
    throw new Error(`Too many items to reorder (max ${REORDER_MAX})`)
  }
  const sb = getSupabase()
  try {
    const { data: rows, error: fetchErr } = await sb
      .from('groups')
      .select('id')
      .eq('user_id', userId)
    if (fetchErr) {
      if (fetchErr.code === '42P01' || fetchErr.message?.includes('does not exist')) {
        return { updated: 0 }
      }
      throw fetchErr
    }
    const ownedIds = new Set((rows || []).map((r) => r.id))

    const clean = []
    const seen = new Set()
    for (const id of orderedIds) {
      if (typeof id !== 'string') continue
      if (!ownedIds.has(id)) continue
      if (seen.has(id)) continue
      seen.add(id)
      clean.push(id)
    }
    if (clean.length === 0) return { updated: 0 }

    const positions = assignPositions(clean.length)
    const updates = await Promise.allSettled(
      clean.map((id, idx) =>
        sb.from('groups')
          .update({ position: positions[idx] })
          .eq('user_id', userId)
          .eq('id', id)
      )
    )
    let updated = 0
    for (const r of updates) {
      if (r.status === 'fulfilled' && !r.value.error) updated++
      else if (r.status === 'fulfilled' && r.value.error) {
        if (!r.value.error.message?.includes('column') && r.value.error.code !== '42703') {
          throw r.value.error
        }
      } else if (r.status === 'rejected') {
        throw r.reason
      }
    }
    return { updated }
  } catch (err) {
    if (err.code === '42P01' || err.message?.includes('does not exist')) {
      return { updated: 0 }
    }
    throw err
  }
}


