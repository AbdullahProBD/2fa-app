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
import { MAX_LOGO_DATA_URI } from '../lib/limits.js'

// ── L3 FIX: UUID format validation to prevent malformed IDs reaching DB ───────
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const router = Router()

// Remove null bytes and other ASCII control characters from user input.
// Built with String.fromCharCode so the linter doesn't flag a control-char regex.
const CTRL_CHARS = new RegExp(
  `[${[0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 127].map((n) => `\\x${n.toString(16).padStart(2, '0')}`).join('')}]`,
  'g'
)
function sanitizeString(value) {
  if (typeof value !== 'string') return ''
  return value.replace(CTRL_CHARS, '')
}

// Validate and normalize a logo string. Accepts a known brand key, a
// data: URI, or an http(s) URL. Rejects anything else.
function normalizeLogo(value) {
  const raw = sanitizeString(value).slice(0, 2048).trim()
  if (!raw) return ''
  if (raw.startsWith('data:image/')) {
    // Only allow well-formed image/* data URIs. The client downscales uploads
    // to 256x256, so MAX_LOGO_DATA_URI is generous headroom rather than a
    // ceiling users hit in practice.
    const comma = raw.indexOf(',')
    if (comma === -1) return ''
    if (raw.length > MAX_LOGO_DATA_URI) return ''
    return raw
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      if (!/^https?:$/i.test(u.protocol)) return ''
      return u.toString()
    } catch {
      return ''
    }
  }
  // Otherwise expect a short alphanumeric brand key
  if (/^[a-z0-9_-]{1,32}$/i.test(raw)) return raw
  return ''
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

  const cleanLabel = sanitizeString(label).slice(0, 64)
  if (!cleanLabel) throw new Error('label is required')

  const cleanSecret = secret.replace(/\s+/g, '').toUpperCase()
  try {
    Secret.fromBase32(cleanSecret.replace(/[^A-Z2-7=]/gi, ''))
  } catch {
    try {
      Secret.base32(cleanSecret)
    } catch {
      throw new Error('Invalid base32 secret')
    }
  }
  const t = type === 'hotp' ? 'hotp' : 'totp'
  const d = Number.isFinite(+digits) ? Math.min(8, Math.max(6, +digits)) : 6
  const p = Number.isFinite(+period) ? Math.min(60, Math.max(15, +period)) : 30
  const alg = ['SHA1', 'SHA256', 'SHA512'].includes(algorithm) ? algorithm : 'SHA1'
  const c = Number.isFinite(+counter) ? Math.max(0, Math.min(1_000_000, +counter)) : 0
  const grp = sanitizeString(group_name || group || '').trim().slice(0, 64)
  const lgo = normalizeLogo(logo)
  return {
    label: cleanLabel,
    issuer: sanitizeString(issuer).slice(0, 64),
    secret: cleanSecret,
    type: t,
    digits: d,
    period: p,
    algorithm: alg,
    counter: c,
    group_name: grp,
    logo: lgo,
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
    if (req.body.label !== undefined) {
      const l = sanitizeString(req.body.label).trim().slice(0, 64)
      if (!l) return res.status(400).json({ error: 'label cannot be empty' })
      updates.label = l
    }
    if (req.body.issuer !== undefined) {
      updates.issuer = sanitizeString(req.body.issuer).trim().slice(0, 64)
    }
    if (req.body.group_name !== undefined || req.body.group !== undefined) {
      updates.group_name = sanitizeString(
        req.body.group_name ?? req.body.group ?? ''
      )
        .trim()
        .slice(0, 64)
    }
    if (req.body.logo !== undefined) {
      const lgo = normalizeLogo(req.body.logo)
      updates.logo = lgo
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
