// Maps an issuer string to a service brand (logo, color, initial).
// Falls back to a hash-derived color for unknown issuers.

const PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e',
]

function hashStr(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

function colorFor(key) {
  return PALETTE[hashStr(key) % PALETTE.length]
}

const SERVICES = {
  github:      { name: 'GitHub',      color: '#24292e' },
  google:      { name: 'Google',      color: '#4285f4' },
  gmail:       { name: 'Gmail',       color: '#ea4335' },
  microsoft:   { name: 'Microsoft',   color: '#00a4ef' },
  outlook:     { name: 'Outlook',     color: '#0078d4' },
  facebook:    { name: 'Facebook',    color: '#1877f2' },
  meta:        { name: 'Meta',        color: '#0866ff' },
  twitter:     { name: 'Twitter',     color: '#1da1f2' },
  x:           { name: 'X',           color: '#000000' },
  instagram:   { name: 'Instagram',   color: '#e4405f' },
  linkedin:    { name: 'LinkedIn',    color: '#0a66c2' },
  discord:     { name: 'Discord',     color: '#5865f2' },
  slack:       { name: 'Slack',       color: '#4a154b' },
  aws:         { name: 'AWS',         color: '#ff9900' },
  amazon:      { name: 'Amazon',      color: '#ff9900' },
  apple:       { name: 'Apple',       color: '#000000' },
  dropbox:     { name: 'Dropbox',     color: '#0061ff' },
  notion:      { name: 'Notion',      color: '#000000' },
  figma:       { name: 'Figma',       color: '#f24e1e' },
  gitlab:      { name: 'GitLab',      color: '#fc6d26' },
  bitbucket:   { name: 'Bitbucket',   color: '#0052cc' },
  digitalocean:{ name: 'DigitalOcean',color: '#0080ff' },
  cloudflare:  { name: 'Cloudflare',  color: '#f38020' },
  heroku:      { name: 'Heroku',      color: '#430098' },
  stripe:      { name: 'Stripe',      color: '#635bff' },
  paypal:      { name: 'PayPal',      color: '#003087' },
  coinbase:    { name: 'Coinbase',    color: '#0052ff' },
  binance:     { name: 'Binance',     color: '#f3ba2f' },
  reddit:      { name: 'Reddit',      color: '#ff4500' },
  twitch:      { name: 'Twitch',      color: '#9146ff' },
  steam:       { name: 'Steam',       color: '#171a21' },
  epic:        { name: 'Epic Games',  color: '#313131' },
  nintendo:    { name: 'Nintendo',    color: '#e60012' },
  playstation: { name: 'PlayStation', color: '#003791' },
  xbox:        { name: 'Xbox',        color: '#107c10' },
  proxmox:     { name: 'Proxmox',     color: '#e57000' },
  nginx:       { name: 'Nginx',       color: '#009639' },
  ubuntu:      { name: 'Ubuntu',      color: '#e95420' },
  docker:      { name: 'Docker',      color: '#2496ed' },
  jetbrains:   { name: 'JetBrains',   color: '#fe315d' },
}

function lookup(issuer) {
  if (!issuer) return null
  const key = issuer.toLowerCase().trim()
  if (Object.prototype.hasOwnProperty.call(SERVICES, key)) return SERVICES[key]
  // Try matching any service name in the issuer string
  for (const [k, v] of Object.entries(SERVICES)) {
    if (key.includes(k)) return v
  }
  return null
}

export function issuerMeta(issuer) {
  const found = lookup(issuer)
  if (found) {
    return { name: found.name, color: found.color, key: issuer.toLowerCase() }
  }
  // Unknown: derive initial + color from the issuer name
  const initial = (issuer || '?').trim().charAt(0).toUpperCase() || '?'
  return { name: issuer || 'Unknown', color: colorFor(issuer || 'unknown'), initial, key: issuer || 'unknown' }
}

export function groupKey(account) {
  return (account.issuer || account.label || 'Ungrouped').trim()
}

export function groupAccounts(accounts) {
  const map = new Map()
  for (const acc of accounts) {
    const key = groupKey(acc)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(acc)
  }
  return Array.from(map.entries())
    .map(([key, items]) => ({
      key,
      meta: issuerMeta(key),
      items: items.sort((a, b) => (a.label || '').localeCompare(b.label || '')),
    }))
    .sort((a, b) => a.meta.name.localeCompare(b.meta.name))
}

export function filterAccounts(accounts, query) {
  const q = (query || '').toLowerCase().trim()
  if (!q) return accounts
  return accounts.filter(
    (a) =>
      (a.label || '').toLowerCase().includes(q) ||
      (a.issuer || '').toLowerCase().includes(q)
  )
}
