import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faShieldHalved,
  faEye,
  faEyeSlash,
  faMagnifyingGlass,
  faPlus,
  faCheck,
  faPen,
  faLock,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import { api } from '../lib/api.js'
import AddAccount from '../components/AddAccount.jsx'
import GroupContainer from '../components/GroupContainer.jsx'
import GroupModal from '../components/GroupModal.jsx'
import {
  getCustomGroups,
  createCustomGroup,
  renameCustomGroup,
  deleteCustomGroup,
  subscribeGroups,
  getAllAccountMeta,
  syncGroupsFromBackend,
  getCachedAccountOrder,
  setCachedAccountOrder,
  getCachedGroupOrder,
  setCachedGroupOrder,
  applyCachedOrder,
  getCollapsedMap,
  setGroupCollapsed,
  isDatabaseGroupId,
  saveCustomGroups,
  swapWithinGroup,
  clearVaultCache,
} from '../lib/groupsStorage.js'

const CODE_RETRY_BASE_MS = 3000
const CODE_RETRY_MAX_MS = 60000

// Epoch window index of `period`-second TOTP codes at (server-aligned) time `ms`.
function windowOf(ms, period) {
  return Math.floor(ms / (period * 1000))
}


export default function Dashboard() {
  const [accounts, setAccounts] = useState([])
  const [codes, setCodes] = useState({})
  const [tickerRemaining, setTickerRemaining] = useState({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [addDefaultGroup, setAddDefaultGroup] = useState('')
  const [showNewGroupModal, setShowNewGroupModal] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeGroupFilter, setActiveGroupFilter] = useState('ALL')
  const [masked, setMasked] = useState(false)
  const [customGroups, setCustomGroups] = useState([])
  const [editMode, setEditMode] = useState(false)
  // sectionId -> true when collapsed. Mirrored in localStorage and persisted to
  // the `collapsed` column on public.groups so it survives every login.
  const [collapsedGroups, setCollapsedGroups] = useState({})

  const searchInputRef = useRef()

  // Latest values for handlers/timers that must not close over stale state.
  const accountsRef = useRef([])
  accountsRef.current = accounts
  const customGroupsRef = useRef([])
  customGroupsRef.current = customGroups
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Code bookkeeping (refs: updated from timers/responses, never rendered).
  const clockOffsetsRef = useRef({}) // period -> (server - local) ms
  const codeWindowRef = useRef({}) // account id -> window index of the held code
  const codeAttemptRef = useRef({}) // account id -> { at, fails } for refresh backoff
  const fetchSeqRef = useRef(0)
  const batchInFlightRef = useRef(0)
  const loadSeqRef = useRef(0)
  // Serialises reorder writes so the last one the user made is the last applied.
  const orderChainRef = useRef({ accounts: Promise.resolve(), groups: Promise.resolve() })

  // Sync custom groups from storage
  useEffect(() => {
    setCustomGroups(getCustomGroups())
    // Seed the collapse state from the local mirror so the first paint already
    // shows the right layout; the database overwrites it once groups load.
    setCollapsedGroups(getCollapsedMap())
    const unsubscribe = subscribeGroups(() => {
      setCustomGroups(getCustomGroups())
    })
    return unsubscribe
  }, [])

  // ── Code ingestion ────────────────────────────────────────────────────────
  // Derive the server clock offset from the `remaining` it reports, sampled at
  // the middle of the request so network latency doesn't skew it. Offsets of
  // ±1s are quantisation noise and ignored.
  const learnClockOffset = useCallback((period, remaining, sampledAt) => {
    if (!period || typeof remaining !== 'number') return
    const localSec = Math.floor(sampledAt / 1000)
    const localRem = period - (localSec % period)
    let d = (((localRem - remaining) % period) + period) % period
    if (d > period / 2) d -= period
    clockOffsetsRef.current[period] = Math.abs(d) <= 1 ? 0 : d * 1000
  }, [])

  const applyCode = useCallback(
    (id, res, sampledAt) => {
      if (!res || typeof res.code !== 'string') return
      const period = res.period || 30
      if (typeof res.remaining === 'number') {
        learnClockOffset(period, res.remaining, sampledAt)
        // Derive the window from the server's own `remaining` (its window ends
        // `remaining` seconds from now), so sub-second clock noise can never
        // label a code from the previous window as the current one.
        const endMs =
          sampledAt + (res.remaining - 0.5) * 1000 + (clockOffsetsRef.current[period] || 0)
        const w = Math.round(endMs / (period * 1000)) - 1
        // A slower, older response must never replace a newer code.
        if (codeWindowRef.current[id] !== undefined && codeWindowRef.current[id] > w) return
        codeWindowRef.current[id] = w
      } else {
        codeWindowRef.current[id] = Infinity // HOTP: not time-based
      }
      delete codeAttemptRef.current[id]
      setCodes((prev) => ({ ...prev, [id]: res }))
    },
    [learnClockOffset]
  )

  // ── Fetch codes for all accounts ──────────────────────────────────────────
  const fetchAllCodes = useCallback(
    async (accountList) => {
      if (!accountList || accountList.length === 0) return
      const seq = ++fetchSeqRef.current
      const startedAt = Date.now()
      batchInFlightRef.current++
      try {
        try {
          // 1. Attempt batch code fetch
          const res = await api.getAllCodes()
          if (!mountedRef.current || seq !== fetchSeqRef.current) return
          const sampledAt = (startedAt + Date.now()) / 2
          if (res && res.codes) {
            Object.entries(res.codes).forEach(([id, c]) => applyCode(id, c, sampledAt))
            return
          }
        } catch (e) {
          if (e && e.status === 401) return // the unauthorized handler takes over
        }
        // 2. Fallback: fetch individually in parallel
        const results = await Promise.allSettled(
          accountList.map(async (a) => {
            const t0 = Date.now()
            const r = await api.getCode(a.id)
            return { id: a.id, r, at: (t0 + Date.now()) / 2 }
          })
        )
        if (!mountedRef.current || seq !== fetchSeqRef.current) return
        results.forEach((r) => {
          if (r.status === 'fulfilled') applyCode(r.value.id, r.value.r, r.value.at)
        })
      } finally {
        batchInFlightRef.current--
      }
    },
    [applyCode]
  )

  // ── Load accounts & groups from database ───────────────────────────────────
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    try {
      const [accResult, grpResult] = await Promise.allSettled([
        api.listAccounts(),
        api.listGroups(),
      ])
      if (!mountedRef.current || seq !== loadSeqRef.current) return

      if (accResult.status === 'rejected') {
        throw accResult.reason
      }

      // Sync backend groups into local storage, then apply the cached order
      if (grpResult.status === 'fulfilled' && grpResult.value?.groups) {
        syncGroupsFromBackend(grpResult.value.groups, { authoritative: true })
        const cachedGrpOrder = getCachedGroupOrder()
        if (cachedGrpOrder.length > 0) {
          const local = getCustomGroups()
          const ordered = applyCachedOrder(local, cachedGrpOrder, (g) => g.id)
          // Avoid an extra save() so we don't notify() in a tight loop
          try {
            localStorage.setItem('2fa_vault_custom_groups', JSON.stringify(ordered))
          } catch (e) {
            console.error('Failed to persist ordered groups to localStorage', e)
          }
          setCustomGroups(ordered)
        }
      }

      // Read the collapse map *after* syncing so the values the database sent
      // win over the local cache. If the group fetch failed we still restore
      // whatever the local cache holds.
      setCollapsedGroups(getCollapsedMap())

      const res = accResult.value
      const meta = getAllAccountMeta()

      // The server is the source of truth for group/logo. The local mirror is
      // only a fallback for a response that omits the field entirely, so a
      // change made on another device (or a deleted group) is never shadowed.
      const merged = (res.accounts || []).map((acc) => {
        const local = meta[acc.id]
        let groupVal = ''
        if (typeof acc.group === 'string') {
          const g = acc.group.trim()
          if (g.toLowerCase() !== 'general') groupVal = g
        } else if (local && typeof local.group === 'string') {
          groupVal = local.group.trim()
        }

        let logoVal = ''
        if (typeof acc.logo === 'string') {
          logoVal = acc.logo
        } else if (local && typeof local.logo === 'string') {
          logoVal = local.logo
        }

        return {
          ...acc,
          group: groupVal,
          logo: logoVal,
        }
      })

      // Apply locally-cached order to the merged list, so the user's last
      // drag-and-drop arrangement survives a reload before the server
      // responds with a freshly-ordered list.
      const cachedAccOrder = getCachedAccountOrder()
      const orderedMerged = applyCachedOrder(merged, cachedAccOrder, (a) => a.id)

      // Auto-register any groups from accounts into customGroups if not yet present
      const existingGroups = getCustomGroups()
      const existingNames = new Set(existingGroups.map((g) => g.name.toLowerCase()))
      merged.forEach((a) => {
        if (a.group && a.group.toLowerCase() !== 'general' && !existingNames.has(a.group.toLowerCase())) {
          try {
            createCustomGroup(a.group, a.logo || '')
            existingNames.add(a.group.toLowerCase())
          } catch {
            // ignore duplicates
          }
        }
      })

      setErr('')
      setAccounts(orderedMerged)
      fetchAllCodes(orderedMerged)
    } catch (e) {
      // A 401 is handled globally (back to the login screen).
      if (!e || e.status !== 401) setErr((e && e.message) || 'Failed to load your vault')
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) setLoading(false)
    }
  }, [fetchAllCodes])

  useEffect(() => {
    load()
  }, [load])

  // ── Server-clock-aligned countdown + code rollover ────────────────────────
  useEffect(() => {
    if (accounts.length === 0) return undefined
    const refreshing = new Set()

    function refreshOne(id) {
      refreshing.add(id)
      const prev = codeAttemptRef.current[id] || { at: 0, fails: 0 }
      codeAttemptRef.current[id] = { at: Date.now(), fails: prev.fails }
      const t0 = Date.now()
      api
        .getCode(id)
        .then((res) => {
          if (mountedRef.current) applyCode(id, res, (t0 + Date.now()) / 2)
        })
        .catch((e) => {
          const cur = codeAttemptRef.current[id] || { at: Date.now(), fails: 0 }
          codeAttemptRef.current[id] = { at: Date.now(), fails: cur.fails + 1 }
          console.error('Failed to refresh code', e?.message)
        })
        .finally(() => refreshing.delete(id))
    }

    function tick() {
      const now = Date.now()
      const newRemaining = {}

      accounts.forEach((acc) => {
        if (acc.type === 'hotp') return
        const period = acc.period || 30
        const serverNow = now + (clockOffsetsRef.current[period] || 0)
        newRemaining[acc.id] = period - (Math.floor(serverNow / 1000) % period)

        // Refresh when the held code belongs to an earlier window (rollover,
        // sleep/resume, missed tick) or was never fetched. Failures back off.
        const held = codeWindowRef.current[acc.id]
        if (held !== undefined && held >= windowOf(serverNow, period)) return
        // The initial batch is still in flight; don't duplicate it per account.
        if (held === undefined && batchInFlightRef.current > 0) return
        if (refreshing.has(acc.id)) return
        const attempt = codeAttemptRef.current[acc.id]
        if (attempt) {
          const wait = Math.min(CODE_RETRY_MAX_MS, CODE_RETRY_BASE_MS * 2 ** attempt.fails)
          if (now - attempt.at < wait) return
        }
        refreshOne(acc.id)
      })

      setTickerRemaining(newRemaining)
    }

    tick()
    const timer = setInterval(tick, 1000)

    // Timers are throttled while hidden: resync immediately on return.
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        tick()
        fetchAllCodes(accounts)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [accounts, fetchAllCodes, applyCode])

  // ── Keyboard shortcut: "/" to focus search ────────────────────────────────
  useEffect(() => {
    function handleKeyDown(e) {
      const el = document.activeElement
      const typing =
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      if (
        e.key === '/' &&
        !typing &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !document.querySelector('[role="dialog"]')
      ) {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // A selected group that was renamed or deleted would leave an empty view.
  useEffect(() => {
    if (activeGroupFilter === 'ALL' || activeGroupFilter === 'UNGROUPED') return
    const key = activeGroupFilter.toLowerCase()
    const exists =
      customGroups.some((g) => g.name.toLowerCase() === key) ||
      accounts.some((a) => (a.group || '').toLowerCase() === key)
    if (!exists) setActiveGroupFilter('ALL')
  }, [activeGroupFilter, customGroups, accounts])

  // ── Filtering & Grouping Logic ────────────────────────────────────────────
  const filteredAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return accounts.filter((a) => {
      // 1. Search Query filter
      if (q) {
        const matchLabel = a.label?.toLowerCase().includes(q)
        const matchIssuer = a.issuer?.toLowerCase().includes(q)
        const matchGroup = a.group?.toLowerCase().includes(q)
        if (!matchLabel && !matchIssuer && !matchGroup) return false
      }
      // 2. Active Group Tab filter
      if (activeGroupFilter !== 'ALL') {
        if (activeGroupFilter === 'UNGROUPED') {
          return !a.group
        }
        return (a.group || '').toLowerCase() === activeGroupFilter.toLowerCase()
      }
      return true
    })
  }, [accounts, searchQuery, activeGroupFilter])

  // Group the filtered accounts by group name
  const groupedSections = useMemo(() => {
    const map = new Map()

    // Ensure all custom groups are represented
    customGroups.forEach((g) => {
      map.set(g.name.toLowerCase(), {
        id: g.id,
        name: g.name,
        logo: g.logo,
        accounts: [],
      })
    })

    const ungrouped = []

    filteredAccounts.forEach((acc) => {
      const gName = (acc.group || '').trim()
      if (!gName) {
        ungrouped.push(acc)
      } else {
        const key = gName.toLowerCase()
        if (!map.has(key)) {
          map.set(key, {
            id: 'grp_auto_' + key,
            name: gName,
            logo: acc.logo || '',
            accounts: [acc],
          })
        } else {
          map.get(key).accounts.push(acc)
        }
      }
    })

    const sections = Array.from(map.values())

    // If active filter is set to a specific group, only show that section
    let result = sections
    if (activeGroupFilter !== 'ALL') {
      if (activeGroupFilter === 'UNGROUPED') {
        result = []
      } else {
        result = sections.filter(
          (s) => s.name.toLowerCase() === activeGroupFilter.toLowerCase()
        )
      }
    } else {
      // In "ALL" view, hide empty custom groups if there is a search query
      if (searchQuery.trim()) {
        result = result.filter((s) => s.accounts.length > 0)
      }
    }

    // Add ungrouped section if there are ungrouped accounts
    if (ungrouped.length > 0) {
      if (activeGroupFilter === 'ALL' || activeGroupFilter === 'UNGROUPED') {
        result.push({
          id: 'ungrouped',
          name: 'Ungrouped',
          logo: '',
          accounts: ungrouped,
        })
      }
    }

    return result
  }, [filteredAccounts, customGroups, activeGroupFilter, searchQuery])

  // Count accounts in each group
  const groupCounts = useMemo(() => {
    const counts = { ALL: accounts.length }
    let ungrp = 0
    accounts.forEach((a) => {
      if (!a.group) {
        ungrp++
      } else {
        const k = a.group.toLowerCase()
        counts[k] = (counts[k] || 0) + 1
      }
    })
    counts.UNGROUPED = ungrp
    return counts
  }, [accounts])

  // ── Group Actions ─────────────────────────────────────────────────────────
  // Throws on validation errors (duplicate name, ...) so the GroupModal can show
  // them inline instead of closing on a failed save.
  function handleRenameGroup(groupId, newName, newLogo) {
    const target = customGroups.find((g) => g.id === groupId)
    const oldName = target?.name
    const oldLogo = target?.logo || ''

    // Persists the name AND the icon to localStorage + the database. The icon
    // belongs to the group alone — accounts keep their own logo and fall back
    // to issuer auto-detection.
    const finalName = renameCustomGroup(groupId, newName, newLogo)
    const nameChanged = oldName !== undefined && oldName !== finalName
    const logoChanged = typeof newLogo === 'string' && newLogo !== oldLogo
    if (oldName === undefined) return

    const sameGroup = (a) => (a.group || '').toLowerCase() === oldName.toLowerCase()
    // Only the name is propagated to member accounts. `logo` is deliberately
    // NOT sent: a group's icon must not overwrite each account's own icon.
    // Side effects run here, outside any state updater (StrictMode runs
    // updaters twice).
    const members = accountsRef.current.filter(sameGroup)
    if (nameChanged) {
      members.forEach((a) => {
        api.updateAccount(a.id, { group_name: finalName }).catch((err) =>
          console.error('Failed to sync renamed group on server', err)
        )
      })
    }
    // Undo the damage from an earlier build that stamped the group's icon onto
    // every member account: clear it only where it exactly matches the icon
    // the group used to have, so those rows fall back to issuer detection.
    const clearIconIds = new Set()
    if (logoChanged && oldLogo) {
      members.forEach((a) => {
        if (a.logo !== oldLogo) return
        clearIconIds.add(a.id)
        api.updateAccount(a.id, { logo: '' }).catch((err) =>
          console.error('Failed to clear group icon from account', err)
        )
      })
    }
    if (nameChanged || clearIconIds.size > 0) {
      setAccounts((prev) =>
        prev.map((a) => {
          if (!sameGroup(a)) return a
          return {
            ...a,
            ...(nameChanged ? { group: finalName } : {}),
            ...(clearIconIds.has(a.id) ? { logo: '' } : {}),
          }
        })
      )
    }
  }

  function handleDeleteGroup(groupId) {
    const old = customGroups.find((g) => g.id === groupId)?.name
    deleteCustomGroup(groupId)
    if (!old) return
    const sameGroup = (a) => (a.group || '').toLowerCase() === old.toLowerCase()
    accountsRef.current.filter(sameGroup).forEach((a) => {
      api.updateAccount(a.id, { group_name: '' }).catch((err) =>
        console.error('Failed to clear group on server', err)
      )
    })
    setAccounts((prev) => prev.map((a) => (sameGroup(a) ? { ...a, group: '' } : a)))
  }

  function handleAddAccountToGroup(groupName) {
    setAddDefaultGroup(groupName)
    setShowAdd(true)
  }

  function handleAccountDeleted(id) {
    setAccounts((list) => list.filter((x) => x.id !== id))
    setCodes((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  function handleAccountUpdated(updated) {
    setAccounts((list) =>
      list.map((a) => (a.id === updated.id ? { ...a, ...updated } : a))
    )
  }

  // ── Move-account-within-group via up/down arrow buttons ──────────────────
  // Swaps the source account with the target account inside the group's slice;
  // other groups stay untouched. State, cache and server write all happen here
  // (not inside a state updater, which StrictMode would run twice).
  const persistOrder = useCallback((kind, ids) => {
    const send = kind === 'accounts' ? api.reorderAccounts : api.reorderGroups
    orderChainRef.current[kind] = orderChainRef.current[kind]
      .then(() => send(ids))
      .catch((err) =>
        console.warn(`[Dashboard] Failed to persist ${kind} order`, err?.message)
      )
  }, [])

  const handleMoveAccount = useCallback(
    (group, target, source) => {
      if (!group || !target || !source) return
      const groupName = group.id === 'ungrouped' ? '' : group.name
      const next = swapWithinGroup(accountsRef.current, groupName, source.id, target.id)
      if (!next) return
      accountsRef.current = next
      setAccounts(next)
      const ids = next.map((a) => a.id)
      setCachedAccountOrder(ids)
      persistOrder('accounts', ids)
    },
    [persistOrder]
  )

  // ── Move-group up/down via the header arrows ──────────────────────────────
  // Swaps the group with its neighbour in `customGroups`, persists locally,
  // and pushes the new global order to the server.
  const handleMoveGroup = useCallback(
    (group, direction) => {
      const prev = customGroupsRef.current
      const idx = prev.findIndex((g) => g.id === group.id)
      const targetIdx = idx + direction
      if (idx === -1 || targetIdx < 0 || targetIdx >= prev.length) return
      const next = prev.slice()
      ;[next[idx], next[targetIdx]] = [next[targetIdx], next[idx]]
      customGroupsRef.current = next
      setCustomGroups(next)
      saveCustomGroups(next)
      const ids = next.map((g) => g.id)
      setCachedGroupOrder(ids)
      persistOrder('groups', ids)
    },
    [persistOrder]
  )

  // ── Collapse / expand a group accordion ────────────────────────────────────
  // Writes the local mirror first so the UI reacts instantly, then pushes the
  // new value to the database so the state is restored on the next login.
  const handleGroupCollapseChange = useCallback((group, collapsed) => {
    if (!group || !group.id) return
    const next = Boolean(collapsed)
    setGroupCollapsed(group.id, next)
    setCollapsedGroups((prev) =>
      prev[group.id] === next ? prev : { ...prev, [group.id]: next }
    )
    // Synthetic sections ("Ungrouped", auto-derived issuer groups) have no row
    // in public.groups, so there is nothing to write server-side.
    if (!isDatabaseGroupId(group.id)) return
    api
      .setGroupCollapsed(group.id, next)
      .catch((err) =>
        console.warn(
          '[Dashboard] Failed to persist group collapse state',
          err?.message
        )
      )
  }, [])

  // Memoized map from id → group index in `customGroups`, used to enable/disable
  // the up/down arrows on each group header.
  const groupIndexById = useMemo(() => {
    const m = new Map()
    customGroups.forEach((g, i) => m.set(g.id, i))
    return m
  }, [customGroups])

  async function logout() {
    try {
      await api.logout()
    } catch (e) {
      console.error('Logout request failed', e?.message)
    }
    clearVaultCache()
    window.location.reload()
  }

  return (
    <div className="app-shell">
      {/* ── Top Header Bar ────────────────────────────────────────── */}
      <header className="header">
        <div className="header-inner">
        <div className="logo">
          <div className="vault-brand-icon">
            <FontAwesomeIcon icon={faShieldHalved} style={{ fontSize: 20 }} />
          </div>
          <h1>2FA Vault</h1>
          <span className="badge" title={`${accounts.length} accounts`}>{accounts.length}</span>
        </div>

        <div className="header-actions">
          {/* Privacy Toggle (Mask/Reveal) */}
          <button
            className={`btn-icon header-icon-btn ${masked ? 'active' : ''}`}
            onClick={() => setMasked(!masked)}
            title={masked ? 'Reveal Codes' : 'Mask Codes (Privacy Mode)'}
            aria-label={masked ? 'Reveal codes' : 'Mask codes'}
            aria-pressed={masked}
          >
            {masked ? (
              <FontAwesomeIcon icon={faEyeSlash} style={{ fontSize: 17 }} />
            ) : (
              <FontAwesomeIcon icon={faEye} style={{ fontSize: 17 }} />
            )}
          </button>

          {/* New Group Button */}
          <button
            className="btn header-btn"
            onClick={() => setShowNewGroupModal(true)}
            title="Create a new custom group"
            aria-label="New group"
          >
            <FontAwesomeIcon icon={faPlus} style={{ fontSize: 12 }} /> <span className="btn-label">Group</span>
          </button>

          {/* Edit Position Toggle — reveals up/down arrows on every row and group */}
          <button
            className={`btn header-btn ${editMode ? 'btn-primary' : ''}`}
            onClick={() => setEditMode((v) => !v)}
            title={editMode ? 'Done editing positions' : 'Edit positions of groups and accounts'}
            aria-label={editMode ? 'Done editing' : 'Edit layout'}
            aria-pressed={editMode}
          >
            {editMode ? (
              <><FontAwesomeIcon icon={faCheck} style={{ fontSize: 12 }} /> <span className="btn-label">Done</span></>
            ) : (
              <><FontAwesomeIcon icon={faPen} style={{ fontSize: 12 }} /> <span className="btn-label">Edit</span></>
            )}
          </button>

          {/* Add Account Button */}
          <button
            className="btn btn-primary header-btn header-btn-add"
            title="Add account"
            aria-label="Add account"
            onClick={() => {
              setAddDefaultGroup(activeGroupFilter !== 'ALL' && activeGroupFilter !== 'UNGROUPED' ? activeGroupFilter : '')
              setShowAdd(true)
            }}
          >
            <FontAwesomeIcon icon={faPlus} style={{ fontSize: 12 }} /> <span className="btn-label">Add</span>
          </button>

          {/* Lock Vault Button */}
          <button className="btn header-btn" onClick={logout} title="Lock Vault and sign out" aria-label="Lock vault">
            <FontAwesomeIcon icon={faLock} style={{ fontSize: 12 }} /> <span className="btn-label">Lock</span>
          </button>
        </div>
        </div>
      </header>

      <main className="app">
      {/* ── Search + group filters ────────────────────────────────── */}
      <div className="toolbar">
      <div className="search-bar-container">
        <div className="search-icon">
          <FontAwesomeIcon icon={faMagnifyingGlass} style={{ fontSize: 16 }} />
        </div>
        <input
          ref={searchInputRef}
          type="search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          enterKeyHint="search"
          aria-label="Search accounts"
          className="search-input"
          placeholder="Search by name or issuer..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button
            className="search-clear-btn"
            onClick={() => setSearchQuery('')}
            title="Clear search"
            aria-label="Clear search"
          >
            <FontAwesomeIcon icon={faXmark} style={{ fontSize: 14 }} />
          </button>
        )}
        <span className="search-kbd-shortcut" aria-hidden="true">/</span>
      </div>

      {/* ── Custom Groups Filter Pills ────────────────────────────── */}
      <div className="groups-filter-bar">
        <button
          className={`group-pill ${activeGroupFilter === 'ALL' ? 'active' : ''}`}
          onClick={() => setActiveGroupFilter('ALL')}
        >
          All
          <span className="group-pill-count">{accounts.length}</span>
        </button>

        {customGroups.map((g) => {
          const cnt = groupCounts[g.name.toLowerCase()] || 0
          return (
            <button
              key={g.id}
              className={`group-pill ${activeGroupFilter.toLowerCase() === g.name.toLowerCase() ? 'active' : ''}`}
              onClick={() => setActiveGroupFilter(g.name)}
            >
              {g.name}
              <span className="group-pill-count">{cnt}</span>
            </button>
          )
        })}

        {groupCounts.UNGROUPED > 0 && (
          <button
            className={`group-pill ${activeGroupFilter === 'UNGROUPED' ? 'active' : ''}`}
            onClick={() => setActiveGroupFilter('UNGROUPED')}
          >
            Ungrouped
            <span className="group-pill-count">{groupCounts.UNGROUPED}</span>
          </button>
        )}

        <button
          className="group-pill new-group-pill"
          onClick={() => setShowNewGroupModal(true)}
          title="Create New Group"
        >
          <FontAwesomeIcon icon={faPlus} style={{ fontSize: 11 }} /> New Group
        </button>
      </div>
      </div>

      {err && <div className="error" role="alert">{err}</div>}

      {/* ── Content View ─────────────────────────────────────────── */}
      {loading ? (
        <div className="empty">
          <div className="spinner" style={{ margin: '0 auto 12px' }} />
          Loading encrypted vault…
        </div>
      ) : accounts.length === 0 ? (
        <div className="card empty-state-card">
          <div className="empty-state-icon">
            <FontAwesomeIcon icon={faLock} style={{ fontSize: 48 }} />
          </div>
          <h3 style={{ margin: '0 0 6px', fontSize: 18 }}>Your Vault is Empty</h3>
          <p style={{ color: 'var(--muted)', fontSize: 14, margin: '0 0 18px', maxWidth: 360 }}>
            Securely store and generate live two-factor authentication codes for your accounts.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
              <FontAwesomeIcon icon={faPlus} style={{ fontSize: 12 }} /> Add First Account
            </button>
            <button className="btn" onClick={() => setShowNewGroupModal(true)}>
              <FontAwesomeIcon icon={faPlus} style={{ fontSize: 12 }} /> Create a Group
            </button>
          </div>
        </div>
      ) : filteredAccounts.length === 0 && searchQuery.trim() ? (
        <div className="card empty">
          No accounts found matching &ldquo;{searchQuery.trim()}&rdquo;.
          <div style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setSearchQuery('')}>
              Clear Search
            </button>
          </div>
        </div>
      ) : (
        /* ── Group Sections Container List ─────────────────────── */
        <div className="account-list">
          {groupedSections.map((section) => {
            const isReorderableCustom =
              section.id !== 'ungrouped' &&
              !section.id.startsWith('grp_auto_') &&
              customGroups.some((g) => g.id === section.id)
            const gIndex = isReorderableCustom
              ? groupIndexById.get(section.id) ?? -1
              : -1
            return (
              <div
                key={section.id}
                className={`group-wrapper${editMode ? ' edit-mode' : ''}`}
              >
                <GroupContainer
                  group={section}
                  accounts={section.accounts}
                  codes={codes}
                  tickerRemaining={tickerRemaining}
                  masked={masked}
                  editMode={editMode}
                  collapsed={collapsedGroups[section.id] === true}
                  onCollapseChange={handleGroupCollapseChange}
                  onDeleteAccount={handleAccountDeleted}
                  onUpdateAccount={handleAccountUpdated}
                  onRenameGroup={handleRenameGroup}
                  onDeleteGroup={handleDeleteGroup}
                  onAddAccountToGroup={handleAddAccountToGroup}
                  onMoveAccount={editMode ? handleMoveAccount : undefined}
                  onMoveGroup={editMode ? handleMoveGroup : undefined}
                  canMoveGroupUp={editMode && gIndex > 0}
                  canMoveGroupDown={
                    editMode && gIndex >= 0 && gIndex < customGroups.length - 1
                  }
                  showGroupArrows={editMode && isReorderableCustom}
                />
              </div>
            )
          })}
        </div>
      )}

      {/* ── Add Account Modal ─────────────────────────────────────── */}
      {showAdd && (
        <AddAccount
          defaultGroup={addDefaultGroup}
          onClose={() => {
            setShowAdd(false)
            setAddDefaultGroup('')
          }}
          onCreated={(acc) => {
            // The countdown effect fetches the new account's first code.
            setAccounts((list) => [acc, ...list])
            setShowAdd(false)
            setAddDefaultGroup('')
          }}
        />
      )}

      {/* ── Create New Group Modal ────────────────────────────────── */}
      {showNewGroupModal && (
        <GroupModal
          isOpen={showNewGroupModal}
          onSave={(name, logo) => {
            createCustomGroup(name, logo)
            setActiveGroupFilter(name)
            setShowNewGroupModal(false)
          }}
          onClose={() => setShowNewGroupModal(false)}
        />
      )}
      </main>
    </div>
  )
}
