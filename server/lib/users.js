import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import {
  deriveKek,
  generateSalt,
  generateVaultKey,
  wrapVaultKey,
  encryptedToBlob,
  fromBase64,
  blobToEncrypted,
  unwrapVaultKey,
  PBKDF2_ITERATIONS,
} from './crypto.js'
import { getUserByUsername, createUser, updateUserWrappedKey } from './supabase.js'

const BCRYPT_COST = 12
// A real, valid bcrypt hash (cost 12) of a throwaway string. Comparing against
// it makes "no such user" cost the same as "wrong password"; a malformed hash
// makes bcryptjs return immediately, which would be a timing oracle.
const DUMMY_BCRYPT_HASH = '$2a$12$q8z8jOEHUdD1enHBEk5k9Ox3hvVHtk05TbUhyzRO3rw16ErVKjwZa'

export async function dummyPasswordCheck(password) {
  await bcrypt.compare(password, DUMMY_BCRYPT_HASH)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest()
}

// Constant-time string equality (hashing first hides length differences).
export function safeStringEqual(a, b) {
  return crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)))
}

// ── L2 FIX: Minimum ADMIN_PASS length raised to 16 ───────────────────────────
const ADMIN_PASS_MIN_LEN = 16
// Also enforce a sensible upper bound to prevent DoS via long passwords
const ADMIN_PASS_MAX_LEN = 256

function getAdminUser() {
  return process.env.ADMIN_USER || null
}

function getAdminPass() {
  return process.env.ADMIN_PASS || null
}

export function checkConfig() {
  const user = getAdminUser()
  const pass = getAdminPass()
  const missing = []
  if (!user) missing.push('ADMIN_USER')
  if (!pass) missing.push('ADMIN_PASS')
  if (missing.length) {
    return {
      ok: false,
      message: `Missing required env vars: ${missing.join(', ')}`,
    }
  }
  if (pass.length < ADMIN_PASS_MIN_LEN) {
    return {
      ok: false,
      message: `ADMIN_PASS must be at least ${ADMIN_PASS_MIN_LEN} characters`,
    }
  }
  if (pass.length > ADMIN_PASS_MAX_LEN) {
    return {
      ok: false,
      message: `ADMIN_PASS must be at most ${ADMIN_PASS_MAX_LEN} characters`,
    }
  }
  return { ok: true, username: user }
}

export async function buildWrappedKeyForUser(vaultKey, password) {
  const salt = generateSalt()
  const kek = await deriveKek(password, salt)
  const wrapped = wrapVaultKey(vaultKey, kek)
  return {
    wrappedBlob: encryptedToBlob(wrapped),
    kekSalt: salt.toString('base64'),
    kekIterations: PBKDF2_ITERATIONS,
  }
}

export async function bootstrapUser(username, password) {
  // The very first login creates the vault, so it must prove knowledge of the
  // configured ADMIN_PASS — otherwise anyone who knows ADMIN_USER could claim
  // an unclaimed deployment with a password of their choosing.
  const adminPass = getAdminPass()
  if (!adminPass || !safeStringEqual(password, adminPass)) {
    await dummyPasswordCheck(password)
    return { error: { status: 401, message: 'Invalid credentials' } }
  }
  const existing = await getUserByUsername(username)
  if (existing) return { error: { status: 409, message: 'User already exists' } }
  const bcryptHash = await bcrypt.hash(password, BCRYPT_COST)
  const vaultKey = generateVaultKey()
  const { wrappedBlob, kekSalt, kekIterations } = await buildWrappedKeyForUser(vaultKey, password)
  let user
  try {
    user = await createUser({
      username,
      passwordHash: bcryptHash,
      kekSalt,
      kekIterations,
      wrappedVaultKey: wrappedBlob.ciphertext,
      wrappedVaultIv: wrappedBlob.iv,
      wrappedVaultTag: wrappedBlob.authTag,
    })
  } catch (err) {
    // 23505: a concurrent first login won the race — fall back to a normal login.
    if (err?.code === '23505') return authenticateAndUnlock(username, password)
    throw err
  }
  return { user, vaultKey }
}

export async function authenticateAndUnlock(username, password) {
  const user = await getUserByUsername(username)
  if (!user) {
    // Run a dummy bcrypt to keep the response time similar whether or not
    // the user exists (constant-time login response).
    await dummyPasswordCheck(password)
    return { error: { status: 401, message: 'Invalid credentials' } }
  }
  const ok = await bcrypt.compare(password, user.password_hash)
  if (!ok) return { error: { status: 401, message: 'Invalid credentials' } }
  const saltBytes = fromBase64(user.kek_salt)
  let kek
  try {
    kek = await deriveKek(password, saltBytes, user.kek_iterations)
  } catch {
    return { error: { status: 500, message: 'Vault unlock failed' } }
  }
  let vaultKey
  try {
    vaultKey = unwrapVaultKey(
      blobToEncrypted({
        ciphertext: user.wrapped_vault_key,
        iv: user.wrapped_vault_iv,
        authTag: user.wrapped_vault_tag,
      }),
      kek
    )
  } catch {
    return { error: { status: 500, message: 'Vault unlock failed' } }
  }
  // Re-wrap on each successful login. Rows created with a weaker KDF setting
  // are upgraded to the current iteration count with a fresh salt.
  const upgrade = user.kek_iterations < PBKDF2_ITERATIONS
  const reWrapped = upgrade
    ? await buildWrappedKeyForUser(vaultKey, password)
    : null
  const reBlob = reWrapped?.wrappedBlob ?? encryptedToBlob(wrapVaultKey(vaultKey, kek))
  await updateUserWrappedKey(user.id, {
    wrappedVaultKey: reBlob.ciphertext,
    wrappedVaultIv: reBlob.iv,
    wrappedVaultTag: reBlob.authTag,
    ...(reWrapped
      ? { kekSalt: reWrapped.kekSalt, kekIterations: reWrapped.kekIterations }
      : {}),
  })
  return { user, vaultKey }
}
