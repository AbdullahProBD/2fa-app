import { Router } from 'express'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import { getVaultKeyFromReq } from '../lib/auth.js'
import { sanitizeString } from '../lib/validate.js'

// ── M1 FIX: Max allowed dataUri size (2 MB) ───────────────────────────────────
const MAX_DATA_URI_BYTES = 2 * 1024 * 1024 // 2 MB
const MAX_OTP_URI_BYTES = 4096
// A tiny PNG can declare enormous dimensions (decompression bomb); pngjs would
// allocate width*height*4 bytes. Check the IHDR before decoding.
const MAX_PNG_DIMENSION = 4096
const MAX_PNG_PIXELS = 12_000_000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const router = Router()

function parseOtpAuth(uri) {
  if (!uri || typeof uri !== 'string') {
    throw new Error('Not an otpauth URI')
  }
  if (uri.length > MAX_OTP_URI_BYTES) {
    throw new Error('URI too long')
  }
  if (!uri.startsWith('otpauth://')) {
    throw new Error('Not an otpauth URI')
  }
  let url
  try {
    url = new URL(uri)
  } catch {
    throw new Error('Invalid otpauth URI')
  }
  if (url.protocol !== 'otpauth:') {
    throw new Error('Invalid otpauth URI protocol')
  }
  if (url.host !== 'totp' && url.host !== 'hotp') {
    throw new Error('Unsupported OTP type')
  }
  const type = url.host === 'hotp' ? 'hotp' : 'totp'
  let label
  try {
    label = decodeURIComponent(url.pathname.slice(1))
  } catch {
    throw new Error('Invalid otpauth URI')
  }
  const params = url.searchParams
  const secret = (params.get('secret') || '').replace(/\s+/g, '').toUpperCase()
  if (!secret) throw new Error('No secret in URI')
  if (!/^[A-Z2-7]+=*$/.test(secret)) throw new Error('Invalid secret in URI')
  let issuer = params.get('issuer') || ''
  if (issuer.length > 128) issuer = issuer.slice(0, 128)
  const digits = params.get('digits') ? parseInt(params.get('digits'), 10) : 6
  const period = params.get('period') ? parseInt(params.get('period'), 10) : 30
  const algorithm = (params.get('algorithm') || 'SHA1').toUpperCase()
  const counter = params.get('counter') ? parseInt(params.get('counter'), 10) : 0
  let accountLabel = label
  // String#split's limit discards the remainder, so split on the first separator by hand.
  const sep = label.includes(':') ? ':' : label.includes(' - ') ? ' - ' : null
  if (sep) {
    const i = label.indexOf(sep)
    if (!issuer) issuer = label.slice(0, i).trim()
    accountLabel = label.slice(i + sep.length).trim()
  }
  return {
    label: sanitizeString(accountLabel).slice(0, 64),
    issuer: sanitizeString(issuer).slice(0, 64),
    secret,
    type,
    digits: Number.isFinite(digits) ? Math.min(8, Math.max(6, digits)) : 6,
    period: Number.isFinite(period) ? Math.min(60, Math.max(15, period)) : 30,
    algorithm: ['SHA1', 'SHA256', 'SHA512'].includes(algorithm) ? algorithm : 'SHA1',
    counter: Number.isFinite(counter) ? Math.min(1_000_000, Math.max(0, counter)) : 0,
  }
}

function checkPngHeader(buf) {
  // 8-byte signature, then the IHDR chunk: length(4) 'IHDR'(4) width(4) height(4)
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Failed to decode PNG')
  }
  if (buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('Failed to decode PNG')
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (
    width === 0 ||
    height === 0 ||
    width > MAX_PNG_DIMENSION ||
    height > MAX_PNG_DIMENSION ||
    width * height > MAX_PNG_PIXELS
  ) {
    throw new Error('Image dimensions too large')
  }
}

function readPngPixels(base64) {
  const buf = Buffer.from(base64, 'base64')
  checkPngHeader(buf)
  return new Promise((resolve, reject) => {
    new PNG().parse(buf, (err, data) => {
      if (err) return reject(err)
      resolve(data)
    })
  })
}

router.post('/', async (req, res) => {
  const vaultKey = getVaultKeyFromReq(req)
  if (!vaultKey) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { dataUri, uri } = req.body || {}

  // Handle plain otpauth:// URI
  if (uri) {
    try {
      const parsed = parseOtpAuth(uri)
      return res.status(200).json({ data: parsed })
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }
  }

  if (!dataUri) {
    return res.status(400).json({ error: 'Provide dataUri or uri' })
  }

  // ── M1 FIX: Reject oversized payloads before any processing ─────────────────
  if (typeof dataUri !== 'string' || dataUri.length > MAX_DATA_URI_BYTES) {
    return res.status(413).json({ error: 'Image too large (max 2 MB)' })
  }

  const match = dataUri.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/)
  if (!match) {
    return res
      .status(400)
      .json({ error: 'Only PNG/JPEG data URIs supported for image upload' })
  }
  const mime = match[1]
  const b64 = match[2]

  let imageData
  if (mime === 'png') {
    try {
      imageData = await readPngPixels(b64)
    } catch (e) {
      const tooBig = e.message === 'Image dimensions too large'
      return res
        .status(tooBig ? 413 : 400)
        .json({ error: tooBig ? e.message : 'Failed to decode PNG' })
    }
  } else {
    return res.status(400).json({
      error:
        'JPEG support requires canvas; please use PNG or paste the otpauth URI instead',
    })
  }

  if (!imageData) {
    return res.status(400).json({ error: 'PNG decoder not available' })
  }

  // attemptBoth: also catches light-on-dark QRs (dark-mode screenshots)
  const code = jsQR(
    new Uint8ClampedArray(
      imageData.data.buffer,
      imageData.data.byteOffset,
      imageData.data.byteLength
    ),
    imageData.width,
    imageData.height,
    { inversionAttempts: 'attemptBoth' }
  )
  if (!code) return res.status(400).json({ error: 'No QR code detected in image' })

  try {
    const parsed = parseOtpAuth(code.data)
    return res.status(200).json({ data: parsed })
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
})

export default router
