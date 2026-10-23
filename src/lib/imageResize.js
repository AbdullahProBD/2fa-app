// Client-side image preparation for icon uploads.
//
// The API stores icons inline as `data:` URIs, and the server caps them. A
// logo straight off disk routinely exceeds that cap, and the server used to
// answer oversized payloads with an empty string — the upload appeared to
// succeed and then silently vanished. Shrinking to a square thumbnail here
// keeps every realistic icon far below the limit and looks identical at the
// 24–40px sizes the UI renders.

export const MAX_ICON_DIMENSION = 256

// Anything past this is rejected up front rather than after a pointless decode.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

// Upper bound for the stored data URI. Mirrors the server's MAX_LOGO_DATA_URI;
// anything bigger is silently dropped there, so refuse it here with a message.
export const MAX_ICON_DATA_URI = 512 * 1024

// MIME types the server accepts inside a stored `data:image/...` icon.
const STORABLE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']

export const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/avif',
]

// MIME type of a `data:` URI ('' when absent).
export function dataUrlMime(dataUrl) {
  const m = /^data:([^;,]*)/i.exec(String(dataUrl || ''))
  return m ? m[1].toLowerCase() : ''
}

// FileReader derives the MIME from `file.type`, which is empty for some
// extensions; the server rejects non-image MIMEs, so stamp the right one.
export function withMime(dataUrl, mime) {
  return String(dataUrl).replace(/^data:[^;,]*/i, `data:${mime}`)
}

function mimeFromName(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(name || '')?.[1]?.toLowerCase()
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' }[ext] || ''
  )
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('That file could not be decoded as an image.'))
    img.src = src
  })
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('That file could not be read.'))
    reader.readAsDataURL(file)
  })
}

/**
 * Turns a picked File into a compact `data:` URI suitable for storing.
 * Raster images are downscaled to MAX_ICON_DIMENSION and re-encoded; SVGs are
 * passed through untouched because they are already vector and tiny.
 *
 * @throws {Error} with a user-facing message for unsupported or broken input.
 * @returns {Promise<{ dataUrl: string, width: number, height: number, bytes: number }>}
 */
export async function prepareIconUpload(file) {
  if (!file) throw new Error('No file selected.')

  // Some browsers report an empty type for exotic extensions; fall back to the
  // extension before rejecting so a valid .png is never refused.
  const looksLikeImage =
    (file.type && file.type.startsWith('image/')) ||
    /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file.name || '')
  if (!looksLikeImage) {
    throw new Error('Unsupported file type. Choose a PNG, JPG, WebP, GIF, or SVG.')
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))
    throw new Error(`That image is too large. Please pick one under ${mb} MB.`)
  }

  let raw = await readAsDataUrl(file)
  if (typeof raw !== 'string') {
    throw new Error('That file could not be read.')
  }

  const isSvg = /svg/i.test(file.type) || /\.svg$/i.test(file.name || '')
  const mime = dataUrlMime(raw)
  if (!STORABLE_TYPES.includes(mime)) {
    const guessed = isSvg ? 'image/svg+xml' : mimeFromName(file.name)
    if (guessed) raw = withMime(raw, guessed)
  }

  // SVG is vector — re-encoding it would rasterise and blur it, and the source
  // is already compact.
  if (isSvg) {
    if (raw.length > MAX_ICON_DATA_URI) {
      throw new Error('That SVG is too large. Please use a smaller file.')
    }
    return { dataUrl: raw, width: 0, height: 0, bytes: raw.length }
  }

  const img = await loadImage(raw)

  // Already small enough — keep the original bytes (no lossy re-encode) unless
  // the format isn't storable (e.g. BMP) or the file is too heavy to store.
  if (
    img.naturalWidth <= MAX_ICON_DIMENSION &&
    img.naturalHeight <= MAX_ICON_DIMENSION &&
    STORABLE_TYPES.includes(dataUrlMime(raw)) &&
    raw.length <= MAX_ICON_DATA_URI
  ) {
    return {
      dataUrl: raw,
      width: img.naturalWidth,
      height: img.naturalHeight,
      bytes: raw.length,
    }
  }

  const scale = Math.min(
    1,
    MAX_ICON_DIMENSION / img.naturalWidth,
    MAX_ICON_DIMENSION / img.naturalHeight
  )
  const width = Math.max(1, Math.round(img.naturalWidth * scale))
  const height = Math.max(1, Math.round(img.naturalHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    // Canvas unavailable (very old browser / locked down): keep the original
    // if it is storable.
    if (raw.length > MAX_ICON_DATA_URI || !STORABLE_TYPES.includes(dataUrlMime(raw))) {
      throw new Error('That image could not be converted. Try a PNG or JPEG.')
    }
    return {
      dataUrl: raw,
      width: img.naturalWidth,
      height: img.naturalHeight,
      bytes: raw.length,
    }
  }
  ctx.drawImage(img, 0, 0, width, height)

  // PNG keeps transparency (which logos rely on) and is lossless. `toDataURL`
  // throws on some tainted/oversized sources, so fall back to the original.
  let dataUrl
  try {
    dataUrl = canvas.toDataURL('image/png')
  } catch {
    dataUrl = raw
  }
  if (dataUrl.length > MAX_ICON_DATA_URI || !STORABLE_TYPES.includes(dataUrlMime(dataUrl))) {
    throw new Error('That image is too large to use as an icon. Try a simpler or smaller one.')
  }

  return { dataUrl, width, height, bytes: dataUrl.length }
}

/**
 * Normalises a user-supplied image URL.
 * @throws {Error} with a user-facing message when the value is unusable.
 * @returns {string} the trimmed URL
 */
export function normalizeIconUrl(value) {
  const trimmed = (value || '').trim()
  if (!trimmed) throw new Error('Enter an image URL first.')

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('That does not look like a valid URL.')
  }
  // https only: the server rejects http:// icons and the CSP blocks them as
  // mixed content, so accepting one would make the icon silently vanish.
  if (parsed.protocol !== 'https:') {
    throw new Error('Only https:// image URLs are supported.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Image URLs must not contain a username or password.')
  }
  const normalized = parsed.toString()
  if (normalized.length > 2048) {
    throw new Error('That URL is too long (max 2048 characters).')
  }
  return normalized
}
