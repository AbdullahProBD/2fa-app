// Helpers for user-entered OTP secrets.

// Mirrors the server: whitespace/dashes/padding stripped, upper-cased.
export function normalizeSecret(value) {
  return String(value ?? '').replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase()
}

// Returns an error message, or '' when the (normalized) secret is acceptable.
export function validateSecret(normalized) {
  if (!normalized) return 'Secret is required'
  if (!/^[A-Z2-7]+$/.test(normalized)) {
    return 'Secret must be Base32 (letters A–Z and digits 2–7 only)'
  }
  if (normalized.length < 8) {
    return 'Secret is too short — it should be at least 8 Base32 characters'
  }
  return ''
}
