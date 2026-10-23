const DEFAULT_TIMEOUT_MS = 15_000
const CSRF_COOKIE_NAME = '2fa_csrf'

// In-memory cache of the CSRF token. Mirrors the value the server has
// already placed in the `2fa_csrf` cookie at login time. Keeping a copy
// here means we can still send the header even in the (rare) case
// where `document.cookie` becomes temporarily empty — for example when
// the browser strips the cookie on certain Vercel preview redirects,
// when a browser extension clears cookies, or when SameSite=Strict
// cookies are dropped in embedded iframes.
let csrfCache = ''

// Read the CSRF token from cookie storage. We rely on the server setting a
// readable cookie (not HttpOnly) named "2fa_csrf" after a successful login.
function getCsrfToken() {
  if (typeof document !== 'undefined') {
    const raw = document.cookie || ''
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.trim().split('=')
      if (k === CSRF_COOKIE_NAME) {
        const v = rest.join('=')
        if (v) csrfCache = v
        return v
      }
    }
  }
  return csrfCache
}

// Fetch a brand-new CSRF token from the server. The server will set a fresh
// `2fa_csrf` cookie AND return the value in the JSON body. The body value
// is the most reliable source because cookie writes from this endpoint may
// race with the very request we are about to retry.
let csrfRefresh = null
function refreshCsrfToken() {
  // Concurrent 403s share one refresh instead of racing each other's cookies.
  if (!csrfRefresh) {
    csrfRefresh = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
      try {
        const res = await fetch('/api/csrf', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        })
        if (!res.ok) {
          throw new Error(`Failed to refresh CSRF token (HTTP ${res.status})`)
        }
        const data = await res.json().catch(() => ({}))
        if (data && typeof data.csrfToken === 'string' && data.csrfToken) {
          csrfCache = data.csrfToken
        }
        // Also pick up whatever cookie the server just set, in case the body
        // field was missing.
        getCsrfToken()
        return csrfCache
      } finally {
        clearTimeout(timer)
      }
    })().finally(() => {
      csrfRefresh = null
    })
  }
  return csrfRefresh
}

// Called once when any request other than login comes back 401 (session
// expired / revoked) so the app can drop back to the login screen.
let unauthorizedHandler = null
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = typeof fn === 'function' ? fn : null
}

// Never surface a raw HTML error page (proxy 502s etc.) or a megabyte of text
// to the user; only short plain messages are shown as-is.
function errorMessageFrom(data, status) {
  const msg = data && typeof data === 'object' ? data.error : ''
  if (typeof msg === 'string' && msg.trim() && msg.length <= 300 && !/<\/?[a-z][\s\S]*>/i.test(msg)) {
    return msg.trim()
  }
  return `Request failed (HTTP ${status})`
}

async function request(path, options = {}) {
  const { headers: extraHeaders, ...fetchOptions } = options
  const method = (options.method || 'GET').toUpperCase()
  const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'

  const buildHeaders = () => {
    const headers = {
      Accept: 'application/json',
      ...(options.body && !(options.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(extraHeaders || {}),
    }
    if (isWrite) {
      const token = getCsrfToken()
      if (token) headers['X-CSRF-Token'] = token
    }
    return headers
  }

  async function sendOnce() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
    try {
      // Spread options first so our headers/signal/credentials always win.
      const res = await fetch(path, {
        ...fetchOptions,
        credentials: 'same-origin',
        headers: buildHeaders(),
        signal: controller.signal,
      })
      const text = await res.text()
      let data
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = { error: text }
      }
      return { res, data }
    } catch (e) {
      const err = new Error(
        e && e.name === 'AbortError'
          ? 'The server took too long to respond. Please try again.'
          : 'Network error — could not reach the server.'
      )
      err.status = 0
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  let { res, data } = await sendOnce()

  // Auto-recover from a CSRF mismatch by re-issuing a token and retrying
  // once. This protects users whose CSRF cookie was lost or never written
  // (e.g. SameSite=Strict cookie dropped after a Vercel preview redirect).
  if (
    isWrite &&
    res.status === 403 &&
    data &&
    typeof data === 'object' &&
    typeof data.error === 'string' &&
    data.error.toLowerCase().includes('csrf')
  ) {
    try {
      await refreshCsrfToken()
      ;({ res, data } = await sendOnce())
    } catch {
      // fall through to error handling below
    }
  }

  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') {
      csrfCache = ''
      if (unauthorizedHandler) unauthorizedHandler()
    }
    const err = new Error(errorMessageFrom(data, res.status))
    err.status = res.status
    throw err
  }
  return data && typeof data === 'object' ? data : {}
}

// Exposed so the Login page can seed the in-memory cache from the value the
// server returned in the login response body (the most reliable source).
export function primeCsrfCache(token) {
  if (typeof token === 'string' && token) csrfCache = token
}

export const api = {
  getMode() {
    return request('/api/mode')
  },
  login(username, password) {
    return request('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  },
  logout() {
    return request('/api/logout', { method: 'POST' })
  },
  listAccounts() {
    return request('/api/accounts')
  },
  createAccount(data) {
    return request('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },
  // Updated: DELETE now uses REST path param /api/accounts/:id
  deleteAccount(id) {
    return request(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  // PATCH /api/accounts/:id
  updateAccount(id, data) {
    return request(`/api/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  },
  // PATCH /api/accounts/reorder — persist new account order to DB
  reorderAccounts(orderedIds) {
    return request('/api/accounts/reorder', {
      method: 'PATCH',
      body: JSON.stringify({ orderedIds }),
    })
  },
  // Updated: GET now uses REST path param /api/totp/:id
  getCode(id, counter) {
    const q = counter != null ? `?counter=${encodeURIComponent(counter)}` : ''
    return request(`/api/totp/${encodeURIComponent(id)}${q}`)
  },
  // GET /api/totp — batch fetch all live codes
  getAllCodes() {
    return request('/api/totp')
  },
  parseQr(dataUri) {
    return request('/api/qr-parse', {
      method: 'POST',
      body: JSON.stringify({ dataUri }),
    })
  },
  parseUri(uri) {
    return request('/api/qr-parse', {
      method: 'POST',
      body: JSON.stringify({ uri }),
    })
  },
  // ── Groups API ──
  listGroups() {
    return request('/api/groups')
  },
  createGroup(data) {
    return request('/api/groups', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },
  updateGroup(id, data) {
    return request(`/api/groups/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },
  deleteGroup(id) {
    return request(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  // PUT /api/groups/:id — persist the accordion (collapsed) state of a group
  setGroupCollapsed(id, collapsed) {
    return request(`/api/groups/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ collapsed: Boolean(collapsed) }),
    })
  },
  // PATCH /api/groups/reorder — persist new group order to DB
  reorderGroups(orderedIds) {
    return request('/api/groups/reorder', {
      method: 'PATCH',
      body: JSON.stringify({ orderedIds }),
    })
  },
}