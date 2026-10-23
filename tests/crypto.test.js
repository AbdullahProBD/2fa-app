import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveKek,
  generateVaultKey,
  generateIv,
  generateSalt,
  wrapVaultKey,
  unwrapVaultKey,
  encryptSecret,
  decryptSecret,
  encryptedToBlob,
  blobToEncrypted,
} from '../server/lib/crypto.js'

describe('crypto primitives', () => {
  test('PBKDF2 derives a 32-byte key', async () => {
    const salt = generateSalt()
    const key = await deriveKek('correct horse battery staple', salt)
    assert.equal(key.length, 32)
  })

  test('wrap/unwrap round-trips a vault key', () => {
    const vaultKey = generateVaultKey()
    const kek = Buffer.from(generateVaultKey())
    const wrapped = wrapVaultKey(vaultKey, kek)
    const unwrapped = unwrapVaultKey(wrapped, kek)
    assert.equal(Buffer.compare(vaultKey, unwrapped), 0)
  })

  test('tampered ciphertext fails to unwrap (GCM auth tag works)', () => {
    const vaultKey = generateVaultKey()
    const kek = Buffer.from(generateVaultKey())
    const wrapped = wrapVaultKey(vaultKey, kek)
    const blob = encryptedToBlob(wrapped)
    const tampered = {
      ciphertext: Buffer.from(blob.ciphertext, 'base64'),
      iv: Buffer.from(blob.iv, 'base64'),
      authTag: Buffer.alloc(16),
    }
    assert.throws(() => unwrapVaultKey(tampered, kek))
  })

  test('encrypt/decrypt round-trips a TOTP secret', () => {
    const vaultKey = generateVaultKey()
    const secret = 'JBSWY3DPEHPK3PXP'
    const enc = encryptSecret(secret, vaultKey)
    const dec = decryptSecret(enc, vaultKey)
    assert.equal(dec, secret)
  })

  test('encrypt with different IVs produces different ciphertexts', () => {
    const vaultKey = generateVaultKey()
    const secret = 'JBSWY3DPEHPK3PXP'
    const a = encryptSecret(secret, vaultKey)
    const b = encryptSecret(secret, vaultKey)
    assert.notEqual(Buffer.compare(a.iv, b.iv), 0)
    assert.notEqual(Buffer.compare(a.ciphertext, b.ciphertext), 0)
  })

  test('blobToEncrypted / encryptedToBlob are inverse', () => {
    const vaultKey = generateVaultKey()
    const enc = encryptSecret('hello', vaultKey)
    const blob = encryptedToBlob(enc)
    const back = blobToEncrypted(blob)
    assert.equal(Buffer.compare(enc.ciphertext, back.ciphertext), 0)
    assert.equal(Buffer.compare(enc.iv, back.iv), 0)
    assert.equal(Buffer.compare(enc.authTag, back.authTag), 0)
  })

  test('generateIv produces 12 bytes', () => {
    assert.equal(generateIv().length, 12)
  })

  test('generateSalt produces 16 bytes', () => {
    assert.equal(generateSalt().length, 16)
  })

  test('generateVaultKey produces 32 bytes', () => {
    assert.equal(generateVaultKey().length, 32)
  })
})

describe('crypto hardening', () => {
  test('rejects a truncated GCM auth tag', () => {
    const vaultKey = generateVaultKey()
    const enc = encryptSecret('JBSWY3DPEHPK3PXP', vaultKey)
    assert.throws(
      () => decryptSecret({ ...enc, authTag: enc.authTag.subarray(0, 4) }, vaultKey),
      /auth tag length/
    )
  })

  test('rejects an IV of the wrong length', () => {
    const vaultKey = generateVaultKey()
    const enc = encryptSecret('JBSWY3DPEHPK3PXP', vaultKey)
    assert.throws(() => decryptSecret({ ...enc, iv: Buffer.alloc(16) }, vaultKey), /IV length/)
  })

  test('decrypting with the wrong key fails', () => {
    const enc = encryptSecret('JBSWY3DPEHPK3PXP', generateVaultKey())
    assert.throws(() => decryptSecret(enc, generateVaultKey()))
  })

  test('deriveKek honours the iteration count (different counts, different keys)', async () => {
    const salt = generateSalt()
    const a = await deriveKek('pw', salt, 100000)
    const b = await deriveKek('pw', salt, 110000)
    assert.notEqual(Buffer.compare(a, b), 0)
  })

  test('deriveKek rejects weak or absurd iteration counts from the DB', async () => {
    const salt = generateSalt()
    await assert.rejects(deriveKek('pw', salt, 1))
    await assert.rejects(deriveKek('pw', salt, 2 ** 40))
    await assert.rejects(deriveKek('pw', salt, 'abc'))
  })
})
