import { Router } from 'express'
import {
  checkConfig,
  bootstrapUser,
  authenticateAndUnlock,
  dummyPasswordCheck,
  safeStringEqual,
} from '../lib/users.js'
import { createSession, buildCookie, buildCsrfCookie } from '../lib/auth.js'
import { getUserByUsername } from '../lib/supabase.js'
import { sanitizeString } from '../lib/validate.js'

const router = Router()

// Rate limiting is applied in server/index.js on /api/login.

router.post('/', async (req, res) => {
  const cfg = checkConfig()
  if (!cfg.ok) {
    return res.status(500).json({ error: cfg.message })
  }

  const { username, password } = req.body || {}

  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'username is required' })
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'password is required' })
  }

  // Bound credentials size to prevent memory abuse
  if (username.length > 128 || password.length > 1024) {
    return res.status(400).json({ error: 'Invalid credentials' })
  }

  // Strip null bytes / control characters from username to prevent smuggling
  if (sanitizeString(username) !== username) {
    return res.status(400).json({ error: 'Invalid credentials' })
  }

  // Constant-time username check; a mismatch still pays for a bcrypt compare so
  // response time doesn't reveal whether the username was right.
  if (!safeStringEqual(username, cfg.username)) {
    await dummyPasswordCheck(password)
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  try {
    const existing = await getUserByUsername(username)
    let result
    if (!existing) {
      result = await bootstrapUser(username, password)
    } else {
      result = await authenticateAndUnlock(username, password)
    }

    if (result.error) {
      return res.status(result.error.status).json({ error: result.error.message })
    }

    const { user, vaultKey } = result
    const { token, csrfToken } = createSession({ userId: user.id, vaultKey })
    const csrf = buildCsrfCookie(csrfToken)
    res.setHeader('Set-Cookie', [buildCookie(token), csrf.cookie])
    return res.status(200).json({ ok: true, csrfToken: csrf.token })
  } catch (err) {
    console.error('[login] error:', err?.message)
    return res.status(500).json({ error: 'Login failed' })
  }
})

export default router
