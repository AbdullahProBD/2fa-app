// Minimal browser-environment stubs for unit-testing the client-side storage
// modules under `src/lib/`. Node has no DOM, so these provide the tiny surface
// they actually touch: localStorage and fetch.

const fetchCalls = []

export function installLocalStorage() {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
  return store
}

// Captures every request so tests can assert what the client sent to the API.
// Always returns a success response; failures are the caller's concern.
export function installFetch() {
  globalThis.fetch = async (path, options = {}) => {
    fetchCalls.push({ path, body: options.body, method: options.method })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  return fetchCalls
}

export function getFetchCalls() {
  return fetchCalls
}

// Finds the single captured PUT to /api/groups/:id and returns its parsed body.
export function lastGroupUpdateBody() {
  const call = [...fetchCalls]
    .reverse()
    .find((c) => c.method === 'PUT' && c.path.startsWith('/api/groups/'))
  return call ? JSON.parse(call.body) : null
}

// Runs `fn` with console.error/console.warn silenced so tests that deliberately
// exercise the corrupt-cache and failed-network paths don't spam the reporter.
export async function withSilencedConsole(fn) {
  const { error, warn } = console
  console.error = () => {}
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    console.error = error
    console.warn = warn
  }
}

export function resetStubs(store) {
  fetchCalls.length = 0
  if (store) store.clear()
}
