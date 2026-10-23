import express from 'express'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import cors from 'cors'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

import loginRouter from './routes/login.js'
import logoutRouter from './routes/logout.js'
import accountsRouter from './routes/accounts.js'
import totpRouter from './routes/totp.js'
import qrParseRouter from './routes/qr-parse.js'
import modeRouter from './routes/mode.js'
import groupsRouter from './routes/groups.js'
import csrfRouter from './routes/csrf.js'
import { requireSession, requireCsrfIfSession } from './lib/auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST_DIR = join(__dirname, '..', 'dist')
const PORT = parseInt(process.env.PORT || '3001', 10)
const isDev = process.env.NODE_ENV !== 'production'
const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME

// ── CORS / Origin check: only same-origin requests are accepted for API ─────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const app = express()

// Behind Vercel (or another reverse proxy) req.ip would otherwise be the proxy's
// address, putting every visitor in one rate-limit bucket — an attacker could
// then lock the admin out. Vercel sets X-Forwarded-For itself, so one hop is
// trustworthy there. Elsewhere, set TRUST_PROXY (hop count) only if you run
// behind a proxy; trusting it blindly would let clients spoof their IP.
const TRUST_PROXY = process.env.TRUST_PROXY
if (TRUST_PROXY !== undefined && TRUST_PROXY !== '') {
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? parseInt(TRUST_PROXY, 10) : false)
} else if (isServerless) {
  app.set('trust proxy', 1)
}

// Disable the X-Powered-By header (information leak)
app.disable('x-powered-by')

// Strict HTTPS in production via HSTS — 1 year, include subdomains, preload
if (!isDev) {
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains; preload'
      )
    }
    next()
  })
}

// ── M5 FIX: Helmet — sets secure HTTP headers on every response ───────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://va.vercel-scripts.com'], // Vercel Analytics / Speed Insights
        styleSrc: ["'self'", "'unsafe-inline'"], // needed for Vite's injected styles
        // 'blob:' is required by the QR uploader, which hands a picked File to
        // <img> via URL.createObjectURL. CSP matches on the URL *scheme*, so
        // 'self' does not cover blob: — without it every QR image upload fails
        // with "Failed to load image for scanning".
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", 'https://*.vercel-insights.com', 'https://*.vercel-analytics.com', 'https://va.vercel-scripts.com'],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false, // allow Vite HMR in dev
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hidePoweredBy: true,
    hsts: isDev ? false : {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  })
)

// ── M5 FIX: Additional headers not covered by Helmet defaults ─────────────────
// camera=(self): the page itself may use the camera (in-app QR scanner).
// Microphone / geolocation stay disabled — the app never needs them.
app.use((req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(), geolocation=(), interest-cohort=()'
  )
  next()
})

// ── CORS: Only allow configured origins to call the API ──────────────────────
if (ALLOWED_ORIGINS.length > 0) {
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true)
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true)
        const err = new Error('CORS: origin not allowed')
        err.status = 403
        return cb(err)
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    })
  )
}

// ── API hardening ────────────────────────────────────────────────────────────
// Responses carry codes and vault metadata — never let a browser or CDN cache them.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

// Reject cross-origin state-changing requests outright. SameSite and CSRF
// tokens already block them; this stops them before any handler (incl. login) runs.
// Skipped in dev: Vite's proxy rewrites Host (changeOrigin), so Origin never matches.
app.use('/api', (req, res, next) => {
  if (isDev || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  const origin = req.headers.origin
  if (!origin || ALLOWED_ORIGINS.includes(origin)) return next()
  let sameHost = false
  try {
    sameHost = new URL(origin).host === req.headers.host
  } catch {
    // malformed Origin → treated as cross-origin
  }
  if (sameHost) return next()
  return res.status(403).json({ error: 'Cross-origin request blocked' })
})

// ── Body parsers ─────────────────────────────────────────────────────────────
// 2MB body limit prevents large payload DoS. JSON only: a urlencoded parser
// would let a third-party <form> POST reach the API without a CORS preflight.
app.use(express.json({ limit: '2mb' }))

// ── H1 FIX: Rate limiting on the login endpoint ───────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                    // 5 attempts per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  skipSuccessfulRequests: true, // only count failed attempts
})

// Coarse per-IP ceiling for the whole API (unauthenticated floods included)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
})

// Global write rate limit to slow down enumeration / DoS
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
})

// ── Public probes (no auth) ──────────────────────────────────────────────────
app.use('/api', apiLimiter)
app.use('/api/mode', modeRouter)
app.use('/api/login', loginLimiter, loginRouter)

// ── Authenticated routes: session + CSRF enforced ────────────────────────────
// Logout is handled before requireSession so an expired session can still clear its cookies.
app.use('/api/logout', requireCsrfIfSession, logoutRouter)
app.use('/api', requireSession)
// GET /api/csrf issues a fresh CSRF token — must NOT itself require a
// matching CSRF header (chicken-and-egg), but does require a valid session.
app.use('/api/csrf', csrfRouter)
app.use('/api/accounts', writeLimiter, accountsRouter)
app.use('/api/totp', totpRouter)
app.use('/api/qr-parse', writeLimiter, qrParseRouter)
app.use('/api/groups', writeLimiter, groupsRouter)

// 404 for unknown /api/* routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// ── Static file serving (production) ─────────────────────────────────────────
if (!isDev) {
  if (existsSync(DIST_DIR)) {
    app.use(
      express.static(DIST_DIR, {
        // Only Vite's hash-named /assets files are safe to cache for a year
        setHeaders(res, filePath) {
          if (/[\\/]assets[\\/]/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          } else {
            res.setHeader('Cache-Control', 'no-cache')
          }
        },
      })
    )
    // SPA fallback — serve index.html for all non-API routes
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.sendFile(join(DIST_DIR, 'index.html'))
    })
  } else {
    console.warn(
      '[server] dist/ not found. Run `npm run build` before starting in production.'
    )
  }
}

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  // body-parser / CORS errors carry a 4xx status; anything else is a 500.
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500
  if (status === 500) console.error('[server] unhandled error:', err?.message)
  if (res.headersSent) return
  const messages = { 400: 'Bad request', 403: 'Forbidden', 413: 'Payload too large' }
  res.status(status).json({ error: status === 500 ? 'Internal server error' : messages[status] || 'Bad request' })
})

// Only start the listener when run directly. On serverless platforms
// (Vercel, AWS Lambda), importing this module just exports the app.
if (!isServerless) {
  app.listen(PORT, () => {
    console.log(`[server] 2FA Vault API running on http://localhost:${PORT}`)
    if (isDev) {
      console.log('   Mode: development (no static files — use Vite on :3000)')
    } else {
      console.log(`   Mode: production (serving dist/ on port ${PORT})`)
    }
  })
}

export default app
