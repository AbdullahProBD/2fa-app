import { Router } from 'express'
import {
  listGroupsByUser,
  createGroup,
  updateGroup,
  deleteGroup,
  getGroupById,
  reorderGroupsByUser,
} from '../lib/supabase.js'
import { getVaultKeyFromReq, getUserIdFromReq } from '../lib/auth.js'
import { sanitizeString, normalizeLogo } from '../lib/validate.js'

const router = Router()

// Group IDs are short slugs (client-generated) or default "grp_*" — bound length
const GROUP_ID_RE = /^[A-Za-z0-9_:-]{1,64}$/

function sanitizeGroupId(value) {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!GROUP_ID_RE.test(v)) return null
  return v
}

function sanitizeGroupName(value) {
  return sanitizeString(value).trim()
}

// GET /api/groups — fetch all custom groups for authenticated user
router.get('/', async (req, res) => {
  const vaultKey = getVaultKeyFromReq(req)
  const userId = getUserIdFromReq(req)
  if (!vaultKey || !userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const groups = await listGroupsByUser(userId)
    return res.status(200).json({ groups })
  } catch (err) {
    console.error('[groups] list error:', err?.message)
    return res.status(500).json({ error: 'Failed to list groups' })
  }
})

// POST /api/groups — create a new custom group in Supabase
router.post('/', async (req, res) => {
  const vaultKey = getVaultKeyFromReq(req)
  const userId = getUserIdFromReq(req)
  if (!vaultKey || !userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const { name, logo = '', id } = req.body || {}
  const trimmed = sanitizeGroupName(name).slice(0, 64)
  if (!trimmed) {
    return res.status(400).json({ error: 'Group name is required' })
  }
  const sanitizedLogo = normalizeLogo(logo)
  // Client IDs are accepted only if they match the slug pattern; createGroup
  // falls back to a server ID if one is already taken.
  const safeId = sanitizeGroupId(id)
  try {
    const group = await createGroup(userId, {
      ...(safeId ? { id: safeId } : {}),
      name: trimmed,
      logo: sanitizedLogo,
    })
    return res.status(201).json({ group })
  } catch (err) {
    console.error('[groups] create error:', err?.message)
    return res.status(500).json({ error: 'Failed to create group' })
  }
})

// PATCH /api/groups/reorder — persist a new group order
// Body: { orderedIds: string[] } — full ordered list of group IDs.
router.patch('/reorder', async (req, res) => {
  const vaultKey = getVaultKeyFromReq(req)
  const userId = getUserIdFromReq(req)
  if (!vaultKey || !userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const { orderedIds } = req.body || {}
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return res.status(400).json({ error: 'orderedIds must be a non-empty array' })
  }
  if (orderedIds.length > 500) {
    return res.status(400).json({ error: 'Too many items (max 500)' })
  }
  for (const id of orderedIds) {
    if (typeof id !== 'string' || !sanitizeGroupId(id)) {
      return res.status(400).json({ error: 'Invalid group id in orderedIds' })
    }
  }
  try {
    const result = await reorderGroupsByUser(userId, orderedIds)
    return res.status(200).json({ ok: true, updated: result.updated })
  } catch (err) {
    console.error('[groups] reorder error:', err?.message)
    return res.status(500).json({ error: 'Failed to reorder groups' })
  }
})

// PUT /api/groups/:id — rename, re-logo, or persist the collapsed state of a group
router.put('/:id', async (req, res) => {
  const vaultKey = getVaultKeyFromReq(req)
  const userId = getUserIdFromReq(req)
  if (!vaultKey || !userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const { id } = req.params
  if (!sanitizeGroupId(id)) {
    return res.status(400).json({ error: 'Invalid group id' })
  }
  const { name, logo, collapsed } = req.body || {}
  const updates = {}
  if (name !== undefined) {
    const trimmed = sanitizeGroupName(name).slice(0, 64)
    if (!trimmed) return res.status(400).json({ error: 'Group name is required' })
    updates.name = trimmed
  }
  if (logo !== undefined) updates.logo = normalizeLogo(logo)
  // Accepts only a real boolean — anything else (string "true", 1, null) is
  // rejected so a malformed client can't silently flip the accordion state.
  if (collapsed !== undefined) {
    if (typeof collapsed !== 'boolean') {
      return res.status(400).json({ error: 'collapsed must be a boolean' })
    }
    updates.collapsed = collapsed
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' })
  }
  try {
    const updated = await updateGroup(userId, id, updates)
    return res.status(200).json({ group: updated })
  } catch (err) {
    console.error('[groups] update error:', err?.message)
    return res.status(500).json({ error: 'Failed to update group' })
  }
})

// DELETE /api/groups/:id — delete custom group and clear assignments
router.delete('/:id', async (req, res) => {
  const vaultKey = getVaultKeyFromReq(req)
  const userId = getUserIdFromReq(req)
  if (!vaultKey || !userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const { id } = req.params
  if (!sanitizeGroupId(id)) {
    return res.status(400).json({ error: 'Invalid group id' })
  }
  try {
    // Look up the existing group so we know its canonical name (don't trust
    // the client-supplied `oldName` query/body parameter).
    const existing = await getGroupById(userId, id)
    const oldName = existing?.name || ''
    await deleteGroup(userId, id, oldName)
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[groups] delete error:', err?.message)
    return res.status(500).json({ error: 'Failed to delete group' })
  }
})

export default router
