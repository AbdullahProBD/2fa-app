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

export const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/avif',
]

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

  const raw = await readAsDataUrl(file)
  if (typeof raw !== 'string') {
    throw new Error('That file could not be read.')
  }

  // SVG is vector — re-encoding it would rasterise and blur it, and the source
  // is already compact.
  if (/svg/i.test(file.type) || /\.svg$/i.test(file.name || '')) {
    return { dataUrl: raw, width: 0, height: 0, bytes: raw.length }
  }

  const img = await loadImage(raw)

  // Already small enough — keep the original bytes (no lossy re-encode).
  if (
    img.naturalWidth <= MAX_ICON_DIMENSION &&
    img.naturalHeight <= MAX_ICON_DIMENSION
  ) {
    return {
      dataUrl: raw,
      width: img.naturalWidth,
      height: img.naturalHeight,
      bytes: raw.length,
    }
  }

  const scale = Math.min(
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
    // Canvas unavailable (very old browser / locked down): keep the original.
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
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// image URLs are supported.')
  }
  return parsed.toString()
}
