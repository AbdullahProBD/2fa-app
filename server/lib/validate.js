import { MAX_LOGO_DATA_URI } from './limits.js'

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Built with String.fromCharCode so the linter doesn't flag a control-char regex.
const CTRL_CHARS = new RegExp(
  `[${[0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 127].map((n) => `\\x${n.toString(16).padStart(2, '0')}`).join('')}]`,
  'g'
)

// Remove null bytes and other ASCII control characters from user input.
export function sanitizeString(value) {
  if (typeof value !== 'string') return ''
  return value.replace(CTRL_CHARS, '')
}

const DATA_IMAGE_RE =
  /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/i
const BRAND_KEY_RE = /^[a-z0-9_-]{1,32}$/i

/**
 * Validate and normalize a logo string. Accepts a base64 image data URI, an
 * https URL, or a short brand key; anything else becomes ''.
 *
 * http: is rejected: the CSP blocks it (mixed content) and it would let a
 * third party track the viewer.
 */
export function normalizeLogo(value) {
  if (typeof value !== 'string') return ''
  const raw = sanitizeString(value).trim()
  if (!raw) return ''
  if (/^data:/i.test(raw)) {
    return raw.length <= MAX_LOGO_DATA_URI && DATA_IMAGE_RE.test(raw) ? raw : ''
  }
  if (raw.length > 2048) return ''
  if (/^https:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      if (u.protocol !== 'https:' || u.username || u.password) return ''
      return u.toString()
    } catch {
      return ''
    }
  }
  return BRAND_KEY_RE.test(raw) ? raw : ''
}

/**
 * Normalize a user-entered Base32 TOTP secret: strips whitespace, dashes and
 * padding, upper-cases, and returns null unless it is valid RFC 4648 Base32.
 */
export function normalizeBase32Secret(value) {
  if (typeof value !== 'string') return null
  const s = value.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase()
  if (s.length < 8 || s.length > 256) return null
  return /^[A-Z2-7]+$/.test(s) ? s : null
}
