// Shared server-side limits.
//
// Kept in their own module so both the accounts and groups routes enforce the
// same ceiling without importing from each other.

/**
 * Upper bound for an inline `data:image/...` icon.
 *
 * Icons are stored as data URIs in Postgres rather than in object storage, so
 * this caps how large a single row can grow. The client downscales uploads to
 * 256x256 before sending, which lands around 60-120 KB base64-encoded, so this
 * is generous headroom rather than a limit users hit in practice.
 *
 * It used to be ~64 KB, which real logo files exceeded — the server then
 * answered with an empty string, so an upload looked successful and the icon
 * silently vanished on the next load.
 */
export const MAX_LOGO_DATA_URI = 512 * 1024
