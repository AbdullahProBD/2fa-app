import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLogo, normalizeBase32Secret, sanitizeString } from '../server/lib/validate.js'

const PNG_URI = 'data:image/png;base64,' + 'A'.repeat(5000)

describe('normalizeLogo', () => {
  test('keeps a data URI longer than 2048 chars intact (no truncation)', () => {
    assert.equal(normalizeLogo(PNG_URI), PNG_URI)
  })

  test('rejects oversized data URIs, non-base64 payloads and non-image types', () => {
    assert.equal(normalizeLogo('data:image/png;base64,' + 'A'.repeat(600 * 1024)), '')
    assert.equal(normalizeLogo('data:image/png;base64,@@@'), '')
    assert.equal(normalizeLogo('data:text/html;base64,AAAA'), '')
    assert.equal(normalizeLogo('data:image/png,<script>'), '')
  })

  test('accepts https URLs only', () => {
    assert.equal(normalizeLogo('https://example.com/a.png'), 'https://example.com/a.png')
    assert.equal(normalizeLogo('http://example.com/a.png'), '')
    assert.equal(normalizeLogo('javascript:alert(1)'), '')
    assert.equal(normalizeLogo('https://user:pw@example.com/a.png'), '')
  })

  test('accepts short brand keys and rejects everything else', () => {
    assert.equal(normalizeLogo('github'), 'github')
    assert.equal(normalizeLogo('has space'), '')
    assert.equal(normalizeLogo('x'.repeat(33)), '')
    assert.equal(normalizeLogo(42), '')
  })
})

describe('normalizeBase32Secret', () => {
  test('normalizes case, whitespace, dashes and padding', () => {
    assert.equal(normalizeBase32Secret('jbsw y3dp-ehpk 3pxp===='), 'JBSWY3DPEHPK3PXP')
  })

  test('rejects invalid characters instead of silently stripping them', () => {
    assert.equal(normalizeBase32Secret('JBSWY3DP!HPK3PXP'), null)
    assert.equal(normalizeBase32Secret('JBSWY3DP1HPK3PXP'), null)
  })

  test('rejects too short, too long and non-string input', () => {
    assert.equal(normalizeBase32Secret('ABC'), null)
    assert.equal(normalizeBase32Secret('A'.repeat(257)), null)
    assert.equal(normalizeBase32Secret(undefined), null)
  })
})

test('sanitizeString strips control characters', () => {
  assert.equal(sanitizeString('a\u0000b\u0007c\n'), 'abc\n')
})
