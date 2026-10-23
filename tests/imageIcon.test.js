import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeIconUrl,
  MAX_ICON_DIMENSION,
  MAX_UPLOAD_BYTES,
  MAX_ICON_DATA_URI,
  ACCEPTED_IMAGE_TYPES,
  dataUrlMime,
  withMime,
} from '../src/lib/imageResize.js'
import { MAX_LOGO_DATA_URI } from '../server/lib/limits.js'

describe('normalizeIconUrl', () => {
  test('accepts an https URL', () => {
    assert.equal(
      normalizeIconUrl('https://example.com/logo.png'),
      'https://example.com/logo.png'
    )
  })

  // The server's normalizeLogo() drops http:// and the CSP blocks it as mixed
  // content, so the picker must refuse it up front instead of losing the icon.
  test('rejects an http URL', () => {
    assert.throws(() => normalizeIconUrl('http://example.com/logo.png'), /https/)
  })

  test('rejects URLs with embedded credentials', () => {
    assert.throws(() => normalizeIconUrl('https://user:pw@example.com/a.png'), /username or password/)
  })

  test('rejects over-long URLs', () => {
    assert.throws(() => normalizeIconUrl('https://example.com/' + 'a'.repeat(2100)), /too long/)
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

describe('data URI helpers', () => {
  test('MAX_ICON_DATA_URI matches the server cap', () => {
    assert.equal(MAX_ICON_DATA_URI, MAX_LOGO_DATA_URI)
  })

  test('dataUrlMime reads the declared type', () => {
    assert.equal(dataUrlMime('data:image/PNG;base64,AAAA'), 'image/png')
    assert.equal(dataUrlMime('data:;base64,AAAA'), '')
    assert.equal(dataUrlMime('nope'), '')
    assert.equal(dataUrlMime(null), '')
  })

  test('withMime replaces an empty or wrong type', () => {
    assert.equal(withMime('data:application/octet-stream;base64,AAAA', 'image/png'), 'data:image/png;base64,AAAA')
    assert.equal(withMime('data:;base64,AAAA', 'image/svg+xml'), 'data:image/svg+xml;base64,AAAA')
  })
})
