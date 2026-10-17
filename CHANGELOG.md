# Changelog

All notable changes to **2FA Vault** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed
* **QR image upload failed in production with "Failed to load image for scanning".** The uploader passes the picked file to `<img>` via `URL.createObjectURL()`, which yields a `blob:` URL, but `blob:` was missing from the `img-src` CSP directive in both `server/index.js` and `vercel.json`. CSP matches source expressions on the URL *scheme*, so `'self'` does not cover `blob:` — every image was rejected at load time. It went unnoticed because `npm run dev` serves the page from Vite, which sends no CSP header, so only production (Vercel headers / Express) was affected. Added `blob:` to both `img-src` directives; this does not weaken the policy, since it only permits blob URLs the page itself created.
* **The QR server fallback no longer swallows its own error.** `throw clientErr || e` always resolved to `clientErr`, discarding the message from the server decoder, which is usually the more specific explanation.
* **Unreadable images now explain themselves.** Formats that pass the `image/*` MIME check but that the browser cannot decode (HEIC/HEIF from iPhone photos, some AVIF) produced the same opaque failure for the client and server paths alike; they now say so and point at PNG/JPEG. Re-picking the same file after a failure now works too — the file input's value was never cleared, so `onChange` did not re-fire.
* **A group's icon no longer overwrites the icons of its member accounts.** Editing a group sent its logo to every account in the group, so all of them adopted the group icon. The group's icon now belongs to the group alone; accounts keep their own logo and fall back to issuer auto-detection. Accounts stamped by the earlier build are cleaned up on the next group icon change (only where the account's logo exactly matched the group's previous icon).
* **Image upload works.** Two separate bugs: the server silently returned an empty string for any `data:` icon above ~64 KB — which most real logo files exceed, so the upload appeared to succeed and then vanished — and `ServiceLogo`'s error flag never reset when the icon changed, so a single failed image permanently pinned the component to the monogram fallback for every later upload or URL. Uploads are now downscaled to 256×256 in the browser before upload, the server cap is 512 KB, and problems are reported instead of swallowed.
* **Broken image URLs are reported.** The URL tab now validates input as you type (rejecting non-`http(s)` schemes such as `javascript:`/`data:`) and shows an explicit error when the preview fails to load, instead of quietly saving a dead URL. Sites that block hotlinking (pngtree, shutterstock and similar) answer `403` to third-party `<img>` requests and cannot be made to work — use **Upload File** for those.
* **Group collapse state is now remembered in the database.** Whether a group is collapsed or expanded is stored in a new `collapsed boolean not null default false` column on `public.groups`, so the accordion layout you left behind is restored on every login and after every toggle. Run the migration below in the Supabase SQL Editor:

  ```sql
  alter table public.groups add column if not exists collapsed boolean not null default false;
  ```

  `PUT /api/groups/:id` now accepts a `collapsed` boolean alongside `name`/`logo` (it rejects anything that isn't a real boolean, and rejects a request that carries no updatable field). Sections with no database row — the `Ungrouped` bucket and auto-derived issuer groups — have nowhere to persist to and are remembered in `localStorage` under `2fa_vault_group_collapsed` instead. Deleting a group clears its stored state so a future group reusing the name starts expanded.

---

## [2.1.0] - 2026-09-30


### Added
* **Live camera QR scanner.** The Add modal has a new `Scan Camera` tab: rear-camera viewfinder with corner frame + laser animation, ~5 fps `jsQR` scanning, auto-fill + jump to Manual Entry on detect. Handles permission denial, missing camera, and insecure-context (HTTPS/localhost required) with clear errors + retry. No new dependencies.
* **Screenshot-proof QR upload.** Upload now decodes at multiple scales (1400 → 900 → 480 + center crop) with light/dark inversion attempts, so small codes inside full-screen phone screenshots are found. Server fallback sends a downscaled PNG (originals often exceed the 2 MB cap or are WebP), and the server decoder also tries inverted QRs.
* **Fully responsive, mobile-first UI.** Sticky mobile header (icon-only actions under 400px), scroll-snap filter pills, tap-to-copy account cards with 44px touch targets, centered dialogs with safe-area padding, 16px inputs (no iOS zoom), `viewport-fit=cover`, touch tuning, and `prefers-reduced-motion` support.
* **Production metadata & PWA.** SEO/OG/Twitter tags, `theme-color`, `manifest.webmanifest` with 192/512/maskable PNG icons + `apple-touch-icon`, `robots.txt` (`/api/` disallowed), and a README production release checklist.
* **Vercel security headers.** `vercel.json` now sends HSTS, `nosniff`, `DENY` framing, `no-referrer`, `Permissions-Policy` (camera allowed for self), and a CSP mirroring the Express policy — static hosting matches Express hardening.

### Changed
* **Camera is now allowed by site permissions.** `Permissions-Policy` is `camera=(self)` (was `camera=()`, which blocked the scanner) in `server/index.js`, `vercel.json`, and the `index.html` meta tag. Microphone/geolocation stay disabled.
* **CSP allows Vercel Analytics scripts.** `script-src`/`connect-src` include `https://va.vercel-scripts.com` in both Express and Vercel configs.
* **Mobile modals are centered dialogs** instead of bottom sheets, with side-by-side action buttons.

### Fixed
* **Page scroll broken by responsive CSS.** `overflow-x: hidden` on `html/body/#root` created a root scroll container and `overscroll-behavior-y: none` killed touch bounce; replaced with `overflow-x: clip` on `body` only. Removed `touch-action: pan-x` from filter pills, which had disabled vertical swipes starting on a pill.

---

## [2.0.5] - 2026-09-04

### Added
* **Beautiful custom dropdowns.** All native `<select>` elements (group, type, digits, period, algorithm in Add/Edit modals) are replaced by a new dark-themed `Select` component (`src/components/Select.jsx`) with a rotating chevron, animated pop-in menu, hover/selected states, selected check-mark, custom scrollbar, and outside-click / Escape dismissal.

### Changed
* **Smooth slide expand/collapse for groups.** Collapsing a group no longer snaps — items now slide shut/open via a `grid-template-rows` 0fr↔1fr transition with fade, reusing the motion timing system.
* **Group delete (trash) is hidden by default** and only appears in **Edit** mode for custom groups. Rename (pen) stays always visible.
* **Typed delete phrases are now target-specific.** Step 2 of group deletion requires typing `sudo rm group`; step 2 of 2FA account deletion requires `sudo rm 2fa` (comparison is case-insensitive). The old shared `SUDO DELETE` phrase is gone.
* **Account deletion is a true 2-step flow again.** The inline `Confirm` button on an account row now opens the 2-step delete modal (warning → type `sudo rm 2fa`) instead of deleting immediately.
* **Row delete opens the popup directly.** Clicking the `×` delete button on an account row now opens the 2-step delete popup immediately — the intermediate inline Confirm/Cancel cluster on the row (and its CSS) was removed.
* **Fixed broken step-2 delete layout.** The phrase chip no longer sits inline in the sentence (it wrapped mid-phrase and pushed "below:" onto its own line). The phrase is now a standalone single-line chip under the instruction text, and long account names wrap safely with `overflow-wrap: anywhere`.
* **Click-to-copy delete phrase.** Clicking the red phrase chip copies `sudo rm 2fa` / `sudo rm group` to the clipboard with a green "Copied!" confirmation state, so the user can paste it into the box instead of typing.

---

## [2.0.4] - 2026-09-04

### Changed
* **All UI icons migrated to Font Awesome.** Every hand-written inline SVG icon and text/emoji glyph across the dashboard, account rows, group headers, modals, and login page is now a Font Awesome 6 icon rendered via `@fortawesome/react-fontawesome` (vault shield, eye / eye-slash, magnifying glass, copy, check, pen, lock / unlock, trash-can, QR code, image, arrows, x-mark). The 70+ service brand logos in `src/lib/icons.jsx` are unchanged — Font Awesome does not cover those services — and the `Countdown` progress ring stays as functional SVG.

### Fixed
* **Broken up/down reorder arrows.** The account and group reorder buttons used hand-written SVG polylines with invalid point lists (e.g. `18 15 2 15 10 9`), rendering as tiny broken marks. They are now proper `faChevronUp` / `faChevronDown` Font Awesome icons at matching sizes.
* **Group up/down arrows were invisible.** The group-level reorder buttons were absolutely positioned at `left: -36px`, off-canvas outside the centered column, so they never appeared even in edit mode. They now live in the group header (up/chevron-down pair with a divider, before the collapse button), visible in **Edit** mode for custom groups with correct disabled states at the top/bottom of the list. The dead floating-controls CSS was removed.

### Added
* New runtime dependencies: `@fortawesome/fontawesome-svg-core`, `@fortawesome/react-fontawesome`, `@fortawesome/free-solid-svg-icons`, `@fortawesome/free-regular-svg-icons`, `@fortawesome/free-brands-svg-icons`.

---

## [2.0.3] - 2026-09-04

### Changed
* **Reorder UI replaced drag-and-drop with explicit up/down arrows.** Click the new **Edit** button in the top bar to enter position-edit mode — every group header shows up/down arrows (disabled at the top/bottom of the list) and every account row reveals up/down arrows on its right edge. Click **✓ Done** to exit. Reorders are still persisted to the database via the same `/api/accounts/reorder` and `/api/groups/reorder` endpoints and still mirror to localStorage.
* **Group header no longer overlaps the first account row.** The redundant `border-bottom` on `.group-header` was removed so the single hairline separator provided by `.group-items` (background + 1px gap) cleanly separates the header from the first row.
* **Edit-mode-only inline delete button on every account row.** When **Edit** is on, each row reveals a destructive `×` button next to the copy button (the regular pencil/edit button is hidden in edit mode to reduce clutter). First click shows an inline `Confirm / Cancel` cluster that springs in; second click on Confirm deletes via the existing 2-step SUDO DELETE flow. The cluster auto-collapses if the user moves the cursor away.
* **Modernized layout + smooth animations across the dashboard.**
  * Rounded corners bumped from `--radius-lg` to 18px on group containers and 10px on action buttons.
  * Generous padding (16px/20px on account rows, 14px/20px on group headers).
  * All interactive elements use a new `--motion-fast` (140ms) / `--motion-med` (240ms) / `--motion-slow` (380ms) timing system with a unified `--ease-out` / `--ease-spring` cubic-bezier. Buttons lift 1px on hover, scale down 0.94–0.97 on press.
  * Reorder arrows and per-row reorder bars slide in with `opacity` + `width` + `transform` transitions; the delete-confirm cluster uses a spring easing for a satisfying pop.
  * The copy-flash animation is now a 700ms three-stop keyframe that pulses background + a soft outward `box-shadow` ring.
  * Edit-mode group containers gain a faint indigo glow so the user can see at a glance which group is in edit mode.

### Removed
* Native HTML5 drag-and-drop reorder hook (`useDragReorder.js`) and all related CSS (drag handles, drop indicators, dimmed-dragging state).

---

## [2.0.2] - 2026-09-04

### Fixed
* **CSRF false-positive "CSRF token missing or invalid" on Vercel deployments.** The `2fa_csrf` cookie was set with `SameSite=Strict` and was silently dropped by some browsers / Vercel preview-URL redirects right after login, leaving the client with no token to echo back. Three layers of defense are now in place:
  * The CSRF cookie now uses `SameSite=Lax` (CSRF protection still holds — the security property is that the header is not auto-sent cross-site, not the cookie itself).
  * `Secure` is now also added whenever `VERCEL=1`, since Vercel does not set `NODE_ENV=production` by default.
  * The client now caches the CSRF token in memory (primed from the login response body) and, on any 403 CSRF error, transparently calls the new `GET /api/csrf` endpoint to re-issue a fresh token and retries the original request once.

### Added
* `GET /api/csrf` — issues a fresh `2fa_csrf` cookie + returns the token in the JSON body. Requires an authenticated session but is exempt from the CSRF check (no chicken-and-egg).
* **Drag-to-reorder for both custom groups and 2FA accounts inside a group.** Drag the grip handle (visible on hover) on any group header or account row to rearrange; the new order is persisted to the database immediately and also cached in `localStorage` so it survives a reload. Powered by a small dependency-free `useDragReorder` hook with native HTML5 drag-and-drop. *(Superseded in 2.0.3 by explicit up/down arrows.)*
  * `PATCH /api/accounts/reorder` and `PATCH /api/groups/reorder` accept a full ordered `orderedIds` array, validate ownership, then assign evenly-spaced `double precision` positions in a single batch.
  * `public.accounts` and `public.groups` gain a `position double precision` column; new listings order by `position` then `created_at`. The SQL migration is idempotent (`add column if not exists`) so existing databases upgrade in place.
* New tests in `tests/auth.test.js` covering `SameSite=Lax`, Vercel-only (`VERCEL=1`, no `NODE_ENV`) cookie hardening, and the session-cookie attributes.
* New `tests/reorder.test.js` covering the pure `reorderArray` helper (no mutation, no-op on same id, custom `getId`) and the server-side `reorderAccountsByUser` / `reorderGroupsByUser` validation paths.

---

## [2.0.1] - 2026-09-04

### Security
* **CSRF protection**: Double-submit-cookie pattern now required for every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`). Token is constant-time compared and tied to the session.
* **CORS**: Optional `ALLOWED_ORIGINS` env var. By default only same-origin requests are accepted; cross-origin browser requests are rejected.
* **Rate limiting**: Per-endpoint write throttling (`/api/accounts`, `/api/qr-parse`, `/api/groups`) in addition to the existing login limiter.
* **Constant-time login**: Dummy `bcrypt.compare` is now performed for unknown usernames to equalize response time and prevent user enumeration.
* **Information leak fix**: `/api/mode` no longer discloses whether a user row has been created.
* **HSTS** is now set in production (1 year, `includeSubDomains`, `preload`).
* **Input validation**: Strict per-field validation for `/api/qr-parse` (URI cap, secret character class), `/api/totp` (counter range & type), and group IDs (slug format). All control characters and oversized payloads are stripped.
* **Logo URL sanitization**: Custom logos must be a known brand key, an `https://` URL, or a `data:image/*` URI under 64 KB.
* **Error messages**: Supabase / internal errors are logged server-side but never returned to clients.
* **`X-Powered-By` header removed** via `app.disable('x-powered-by')` and Helmet's `hidePoweredBy`.
* **Static file cache headers**: hashed assets get 1-year immutable cache, `index.html` is forced no-cache.
* **Request timeouts**: Frontend now aborts requests after 15s to avoid stuck UI states.

### Fixed
* `App.jsx`: the auth probe previously treated any non-401 response as authenticated; this is now strict.
* `Dashboard.jsx`: `handleRenameGroup` now propagates the new logo to the server; code-refresh tick no longer races on multiple in-flight refreshes.
* `groupsStorage.js`: `deleteGroup` no longer passes a client-supplied `oldName`; the server resolves the canonical name from the DB.
* `parseOtpAuth` now strictly validates the otpauth URL protocol, host, and base32 character set.

### Added
* `tests/crypto.test.js` and `tests/auth.test.js` — node:test suite covering the crypto primitives and CSRF middleware.
* `npm test` script.

---

## [2.0.0] - 2026-09-04

### Added
* **Custom Groups & Categories**: Create, rename, delete custom groups and organize 2FA accounts dynamically.
* **Inline Group Management**: Direct "+ Create New Group" modal trigger within both Add and Edit modals.
* **Redesigned 2-Step Deletion**: Glassmorphic confirmation modal with monospace command input (`SUDO DELETE`), live validation ring, and clean SVG icons.
* **Brand Icon Library**: Built-in picker supporting 70+ popular service logos with auto-detection from issuer names.
* **Vercel Analytics & Speed Insights**: Integrated real-time monitoring and web vitals tracking.
* **Precision Countdown Timer**: Epoch-synchronized countdown indicators with auto-refresh on code rollover.
* **HOTP & TOTP Support**: RFC 6238 and RFC 4226 support with configurable digits (6, 7, 8) and periods (15s to 60s).
* **SVG Favicon**: Scalable vector brand favicon with security shield and keyhole glyph.
* **Community Health Standards**: Added `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue templates, and PR template.

### Fixed
* Fixed group persistence bug where accounts defaulted to `General` and could not be changed or cleared.
* Fixed stale form states in `EditAccountModal` upon reopening.
* Fixed server serializer to properly preserve user-selected groups.
* Removed hardcoded fallback defaults that overwrote client metadata.

### Security
* PBKDF2 iteration hardening (310,000 iterations).
* AES-256-GCM zero-knowledge encryption for TOTP secrets.
* HttpOnly, Secure, SameSite=Strict cookie session management.
* Strict rate limiting on authentication routes.

---

## [1.0.0] - 2026-08-15

### Added
* Initial release of 2FA Vault.
* Node.js + Express backend with Supabase Postgres storage.
* React single-page frontend.
* QR code scanning and manual entry.
* Single-user authentication model.
