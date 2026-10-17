import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeIconUrl,
  MAX_ICON_DIMENSION,
  MAX_UPLOAD_BYTES,
  ACCEPTED_IMAGE_TYPES,
} from '../src/lib/imageResize.js'
import { MAX_LOGO_DATA_URI } from '../server/lib/limits.js'

describe('normalizeIconUrl', () => {
  test('accepts an https URL', () => {
    assert.equal(
      normalizeIconUrl('https://example.com/logo.png'),
      'https://example.com/logo.png'
    )
  })

  test('accepts an http URL', () => {
    assert.equal(
      normalizeIconUrl('http://example.com/logo.png'),
      'http://example.com/logo.png'
    )
  })

  test('trims surrounding whitespace', () => {
    assert.equal(
      normalizeIconUrl('  https://example.com/a.png  '),
      'https://example.com/a.png'
    )
  })

  test('accepts a query string', () => {
    const url = 'https://example.com/a.png?size=64&v=2'
    assert.equal(normalizeIconUrl(url), url)
  })

  test('rejects an empty value', () => {
    assert.throws(() => normalizeIconUrl(''), /Enter an image URL/)
    assert.throws(() => normalizeIconUrl('   '), /Enter an image URL/)
    assert.throws(() => normalizeIconUrl(null), /Enter an image URL/)
  })

  test('rejects a malformed URL', () => {
    assert.throws(() => normalizeIconUrl('not a url'), /valid URL/)
    assert.throws(() => normalizeIconUrl('example.com/logo.png'), /valid URL/)
  })

  test('rejects non-http protocols', () => {
    // Guards against javascript:/data: being smuggled into an <img src>.
    assert.throws(() => normalizeIconUrl('javascript:alert(1)'), /http/)
    assert.throws(() => normalizeIconUrl('data:image/png;base64,AAAA'), /http/)
    assert.throws(() => normalizeIconUrl('ftp://example.com/a.png'), /http/)
  })
})

describe('icon limits', () => {
  test('the server cap has headroom over a downscaled PNG', () => {
    // A 256x256 PNG re-encoded to a data URI lands roughly 60-120 KB.
    assert.ok(MAX_ICON_DIMENSION >= 256, 'dimension floor')
    assert.ok(
      MAX_LOGO_DATA_URI > 256 * 1024,
      'server cap must clear a 256px PNG'
    )
  })

  test('the server cap stays a real bound', () => {
    // Guards against the cap being lifted to "unlimited" and bloating rows.
    assert.ok(MAX_LOGO_DATA_URI <= 1024 * 1024)
  })

  test('the client upload cap is bounded', () => {
    assert.ok(MAX_UPLOAD_BYTES > 0 && MAX_UPLOAD_BYTES <= 20 * 1024 * 1024)
  })

  test('accepts the documented image types', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']) {
      assert.ok(ACCEPTED_IMAGE_TYPES.includes(t), `missing ${t}`)
    }
  })
})
