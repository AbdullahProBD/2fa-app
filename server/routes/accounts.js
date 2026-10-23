import { Router } from 'express'
import { Secret } from 'otpauth'
import { encryptSecret } from '../lib/crypto.js'
import {
  listAccountsByUser,
  getAccountById,
  createAccount,
  updateAccount,
  deleteAccountById,
  publicAccount,
  serializeAccount,
  reorderAccountsByUser,
} from '../lib/supabase.js'
import { getVaultKeyFromReq, getUserIdFromReq } from '../lib/auth.js'
import { UUID_RE, sanitizeString, normalizeLogo, normalizeBase32Secret } from '../lib/validate.js'

const router = Router()

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function sanitizeInput(body) {
  const {
    label,
    issuer = '',
    secret,
    type = 'totp',
    digits = 6,
    period = 30,
    algorithm = 'SHA1',
    counter = 0,
    group = '',
    group_name = '',
    logo = '',
  } = body || {}
  if (!label || typeof label !== 'string') throw new Error('label is required')
  if (!secret || typeof secret !== 'string') throw new Error('secret is required')

  const cleanLabel = sanitizeString(label).trim().slice(0, 64)
  if (!cleanLabel) throw new Error('label is required')

  const cleanSecret = normalizeBase32Secret(secret)
  if (!cleanSecret) throw new Error('Invalid base32 secret')
  try {
    if (Secret.fromBase32(cleanSecret).buffer.byteLength === 0) throw new Error()
  } catch {
    throw new Error('Invalid base32 secret')
  }
  const alg = String(algorithm).toUpperCase()
  return {
    label: cleanLabel,
    issuer: sanitizeString(issuer).trim().slice(0, 64),
    secret: cleanSecret,
    type: type === 'hotp' ? 'hotp' : 'totp',
    digits: clampInt(digits, 6, 8, 6),
    period: clampInt(period, 15, 60, 30),
    algorithm: ['SHA1', 'SHA256', 'SHA512'].includes(alg) ? alg : 'SHA1',
    counter: clampInt(counter, 0, 1_000_000, 0),
    group_name: sanitizeString(group_name || group || '').trim().slice(0, 64),
    logo: normalizeLogo(logo),
  }
}

// GET /api/accounts — list all accounts for the authenticated user
router.get('/', async (req, res) => {
  const vaultKey = getVaultKeyFromReq(req)
  const userId = getUserIdFromReq(req)
  if (!vaultKey || !userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const rows = await listAccountsByUser(userId)
    return res.status(200).json({ accounts: rows.map(publicAccount) })
  } catch (err) {
    console.error('[accounts] list error:', err?.message)
    return res.status(500).json({ error: 'Failed to list accounts' })
  }
})

// POST /api/accounts — create a new encrypted account
router.post('/', async (req, res) => {
  const vaultKey = getVaultKeyFromReq(req)
  const userId = getUserIdFromReq(req)
  if (!vaultKey || !userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  let input
  try {
    input = sanitizeInput(req.body)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  try {
    const encrypted = encryptSecret(input.secret, vaultKey)
    const row = await createAccount(userId, {
      label: input.label,
      issuer: input.issuer,
      type: input.type,
      digits: input.digits,
      period: input.period,
      algorithm: input.algorithm,
      counter: input.counter,
      group_name: input.group_name,
      logo: input.logo,
      encryptedSecret: {
        ciphertext: encrypted.ciphertext.toString('base64'),
        iv: encrypted.iv.toString('base64'),
        authTag: encrypted.authTag.toString('base64'),
      },
    })
    return res.status(201).json({ account: publicAccount(serializeAccount(row)) })
  } catch (err) {
    console.error('[accounts] create error:', err?.message)
    return res.status(500).json({ error: 'Failed to create account' })
  }
})

// PATCH /api/accounts/reorder — persist a new account order
// Body: { orderedIds: string[] } — full ordered list of account IDs.
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
  // Bound the payload defensively
  if (orderedIds.length > 500) {
    return res.status(400).json({ error: 'Too many items (max 500)' })
  }
  // Validate every entry is a UUID — never trust client input for DB writes
  for (const id of orderedIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return res.status(400).json({ error: 'Invalid account id in orderedIds' })
    }
  }
  try {
    const result = await reorderAccountsByUser(userId, orderedIds)
    return res.status(200).json({ ok: true, updated: result.updated })
  } catch (err) {
    console.error('[accounts] reorder error:', err?.message)
    return res.status(500).json({ error: 'Failed to reorder accounts' })
  }
})

// PATCH /api/accounts/:id — update account metadata (label, issuer, group, logo)
router.patch('/:id', async (req, res) => {
  const vaultKey = getVaultKeyFromReq(req)
  const userId = getUserIdFromReq(req)
  if (!vaultKey || !userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const { id } = req.params
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid account id' })
  }
  try {
    const existing = await getAccountById(userId, id)
    if (!existing) return res.status(404).json({ error: 'Not found' })

    const updates = {}
    const body = req.body || {}
    if (body.label !== undefined) {
      const l = sanitizeString(body.label).trim().slice(0, 64)
      if (!l) return res.status(400).json({ error: 'label cannot be empty' })
      updates.label = l
    }
    if (body.issuer !== undefined) {
      updates.issuer = sanitizeString(body.issuer).trim().slice(0, 64)
    }
    if (body.group_name !== undefined || body.group !== undefined) {
      updates.group_name = sanitizeString(
        body.group_name ?? body.group ?? ''
      )
        .trim()
        .slice(0, 64)
    }
    if (body.logo !== undefined) {
      const lgo = normalizeLogo(body.logo)
      updates.logo = lgo
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' })
    }

    const updated = await updateAccount(userId, id, updates)
    return res.status(200).json({ account: publicAccount(serializeAccount(updated)) })
  } catch (err) {
    console.error('[accounts] patch error:', err?.message)
    return res.status(500).json({ error: 'Failed to update account' })
  }
})

// DELETE /api/accounts/:id — delete an account by ID
router.delete('/:id', async (req, res) => {
  const vaultKey = getVaultKeyFromReq(req)
  const userId = getUserIdFromReq(req)
  if (!vaultKey || !userId) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const { id } = req.params
  // L3 FIX: Validate UUID format
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid account id' })
  }
  try {
    const existing = await getAccountById(userId, id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    await deleteAccountById(userId, id)
    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[accounts] delete error:', err?.message)
    return res.status(500).json({ error: 'Failed to delete account' })
  }
})

export default router
