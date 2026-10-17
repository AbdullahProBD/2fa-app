import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

// The QR uploader hands a picked File to <img> via URL.createObjectURL(), which
// produces a blob: URL. CSP matches source expressions on the URL *scheme*, so
// 'self' does not cover blob: — img-src must list it explicitly. It shipped
// without it, and because `npm run dev` serves the page from Vite (which sends
// no CSP header) the failure only appeared in production, on every image.

describe('CSP allows blob: images', () => {
  test('the client actually depends on blob: URLs', () => {
    // Guards the test itself: if the uploader stops using createObjectURL the
    // blob: requirement goes away and these assertions can be revisited.
    assert.match(read('src/components/AddAccount.jsx'), /URL\.createObjectURL/)
  })

  test('vercel.json img-src includes blob:', () => {
    const config = JSON.parse(read('vercel.json'))
    const csp = config.headers
      .flatMap((h) => h.headers || [])
      .find((h) => h.key.toLowerCase() === 'content-security-policy')
    assert.ok(csp, 'vercel.json must set a Content-Security-Policy header')

    const imgSrc = /img-src ([^;]+)/.exec(csp.value)
    assert.ok(imgSrc, `no img-src directive in: ${csp.value}`)
    assert.match(
      imgSrc[1],
      /(^|\s)blob:(\s|$)/,
      `img-src must allow blob: — got "${imgSrc[1]}"`
    )
  })

  test('the Express helmet imgSrc includes blob:', () => {
    const src = read('server/index.js')
    const block = /imgSrc:\s*\[([^\]]+)\]/.exec(src)
    assert.ok(block, 'server/index.js must configure helmet imgSrc')
    assert.match(
      block[1],
      /['"]blob:['"]/,
      `helmet imgSrc must include blob: — got ${block[1]}`
    )
  })

  test('the two CSP definitions stay in sync', () => {
    // Vercel serves the static app and Express serves the API, so a drift
    // between the two silently reintroduces this class of bug in one of them.
    const vercelImg = /img-src ([^;]+)/.exec(
      JSON.parse(read('vercel.json'))
        .headers.flatMap((h) => h.headers || [])
        .find((h) => h.key.toLowerCase() === 'content-security-policy').value
    )[1]
    const expressImg = /imgSrc:\s*\[([^\]]+)\]/.exec(read('server/index.js'))[1]

    // Express writes a JS array; the Vercel header is a space-separated
    // string. Normalise both to a sorted token list.
    const norm = (s) =>
      s
        .replace(/['"]/g, '')
        .split(/[\s,]+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .sort()

    assert.deepEqual(
      norm(expressImg),
      norm(vercelImg),
      'Express and Vercel img-src directives have drifted'
    )
  })
})

describe('QR upload error handling', () => {
  const src = read('src/components/AddAccount.jsx')

  test('does not discard the server fallback error', () => {
    // `throw clientErr || e` always resolved to clientErr and threw away the
    // server's message, which is usually the more specific explanation.
    assert.doesNotMatch(src, /throw clientErr \|\| e/)
  })

  test('explains undecodable formats instead of a generic failure', () => {
    assert.match(src, /heic/i)
    assert.match(src, /Could not read that image/)
  })

  test('resets the file input so the same file can be re-picked', () => {
    assert.match(src, /fileRef\.current\.value = ''/)
  })
})
