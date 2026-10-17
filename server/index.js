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
import { requireSession } from './lib/auth.js'

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
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https://*.supabase.co', 'https://*.vercel-insights.com', 'https://*.vercel-analytics.com', 'https://va.vercel-scripts.com'],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
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
        return cb(new Error('CORS: origin not allowed'))
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    })
  )
}

// ── Body parsers ─────────────────────────────────────────────────────────────
// M1 FIX: 2MB body limit prevents large payload DoS
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: false, limit: '2mb' }))

// ── H1 FIX: Rate limiting on the login endpoint ───────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                    // 5 attempts per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  skipSuccessfulRequests: true, // only count failed attempts
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
app.use('/api/mode', modeRouter)
app.use('/api/login', loginLimiter, loginRouter)

// ── Authenticated routes: session + CSRF enforced ────────────────────────────
app.use('/api', requireSession)
// GET /api/csrf issues a fresh CSRF token — must NOT itself require a
// matching CSRF header (chicken-and-egg), but does require a valid session.
app.use('/api/csrf', csrfRouter)
app.use('/api/logout', logoutRouter)
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
        // Hash-based asset filenames can be cached aggressively
        maxAge: '1y',
        immutable: true,
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
            res.setHeader('Pragma', 'no-cache')
            res.setHeader('Expires', '0')
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
  if (process.env.NODE_ENV !== 'production') {
    console.error('[server] unhandled error:', err?.message)
  }
  if (res.headersSent) return
  res.status(500).json({ error: 'Internal server error' })
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
