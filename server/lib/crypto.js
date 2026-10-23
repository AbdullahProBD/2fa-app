import crypto from 'node:crypto'

export const PBKDF2_ITERATIONS = 310000
const PBKDF2_MIN_ITERATIONS = 100000
const PBKDF2_MAX_ITERATIONS = 10_000_000
const PBKDF2_KEYLEN = 32
const PBKDF2_DIGEST = 'sha256'
const SALT_BYTES = 16
const IV_BYTES = 12
const KEY_BYTES = 32
const TAG_BYTES = 16

export function randomBytes(n) {
  return crypto.randomBytes(n)
}

export function toHex(buf) {
  return buf.toString('hex')
}

export function fromHex(hex) {
  return Buffer.from(hex, 'hex')
}

export function toBase64(buf) {
  return buf.toString('base64')
}

export function fromBase64(b64) {
  return Buffer.from(b64, 'base64')
}

// ── M4 FIX: Async PBKDF2 — no longer blocks the event loop ───────────────────
export function deriveKek(password, salt, iterations = PBKDF2_ITERATIONS) {
  return new Promise((resolve, reject) => {
    // The iteration count comes from the DB; refuse values that would weaken
    // the KDF or turn a tampered row into a CPU-exhaustion vector.
    if (
      !Number.isInteger(iterations) ||
      iterations < PBKDF2_MIN_ITERATIONS ||
      iterations > PBKDF2_MAX_ITERATIONS
    ) {
      return reject(new Error('Invalid PBKDF2 iteration count'))
    }
    crypto.pbkdf2(
      password,
      salt,
      iterations,
      PBKDF2_KEYLEN,
      PBKDF2_DIGEST,
      (err, key) => (err ? reject(err) : resolve(key))
    )
  })
}

export function generateVaultKey() {
  return randomBytes(KEY_BYTES)
}

export function generateSalt() {
  return randomBytes(SALT_BYTES)
}

export function generateIv() {
  return randomBytes(IV_BYTES)
}

function gcmEncrypt(plaintext, key) {
  const iv = generateIv()
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { ciphertext, iv, authTag: cipher.getAuthTag() }
}

// Pin IV and tag lengths: Node accepts truncated GCM tags unless told otherwise,
// which would let an attacker with DB write access forge short-tag ciphertexts.
function gcmDecrypt({ ciphertext, iv, authTag }, key) {
  if (!Buffer.isBuffer(iv) || iv.length !== IV_BYTES) throw new Error('Invalid IV length')
  if (!Buffer.isBuffer(authTag) || authTag.length !== TAG_BYTES) {
    throw new Error('Invalid auth tag length')
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export function wrapVaultKey(vaultKey, kek) {
  return gcmEncrypt(vaultKey, kek)
}

export function unwrapVaultKey(blob, kek) {
  return gcmDecrypt(blob, kek)
}

export function encryptSecret(secret, vaultKey) {
  return gcmEncrypt(Buffer.from(secret, 'utf8'), vaultKey)
}

export function decryptSecret(blob, vaultKey) {
  return gcmDecrypt(blob, vaultKey).toString('utf8')
}

export function encryptedToBlob({ ciphertext, iv, authTag }) {
  return {
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
    authTag: toBase64(authTag),
  }
}

export function blobToEncrypted({ ciphertext, iv, authTag }) {
  return {
    ciphertext: fromBase64(ciphertext),
    iv: fromBase64(iv),
    authTag: fromBase64(authTag),
  }
}
