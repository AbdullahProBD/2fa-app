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
} from '../lib/groupsStorage.js'


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

  // ── Fetch codes for all accounts ──────────────────────────────────────────
  const fetchAllCodes = useCallback(async (accountList) => {
    if (!accountList || accountList.length === 0) return
    try {
      // 1. Attempt batch code fetch
      const res = await api.getAllCodes()
      if (res && res.codes) {
        setCodes(res.codes)
        return
      }
    } catch (e) {
      // 2. Fallback: fetch individually in parallel
      try {
        const results = await Promise.allSettled(
          accountList.map((a) => api.getCode(a.id))
        )
        const batch = {}
        results.forEach((r, idx) => {
          if (r.status === 'fulfilled') {
            batch[accountList[idx].id] = r.value
          }
        })
        setCodes(batch)
      } catch (err) {
        console.error('Failed to fetch TOTP codes', err)
      }
    }
  }, [])

  // ── Load accounts & groups from database ───────────────────────────────────
  const load = useCallback(async () => {
    try {
      const [accResult, grpResult] = await Promise.allSettled([
        api.listAccounts(),
        api.listGroups(),
      ])

      if (accResult.status === 'rejected') {
        throw accResult.reason
      }

      // Sync backend groups into local storage, then apply the cached order
      if (grpResult.status === 'fulfilled' && grpResult.value?.groups) {
        syncGroupsFromBackend(grpResult.value.groups)
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

      // Merge backend accounts with local group/logo metadata
      const merged = (res.accounts || []).map((acc) => {
        const local = meta[acc.id]
        let groupVal = ''
        if (local && typeof local.group === 'string' && local.group.trim()) {
          groupVal = local.group.trim()
        } else if (acc.group && typeof acc.group === 'string') {
          const g = acc.group.trim()
          if (g.toLowerCase() !== 'general') {
            groupVal = g
          }
        }

        let logoVal = ''
        if (local && typeof local.logo === 'string' && local.logo) {
          logoVal = local.logo
        } else if (acc.logo) {
          logoVal = acc.logo
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

      setAccounts(orderedMerged)
      fetchAllCodes(orderedMerged)
    } catch (e) {
      if (e.status === 401) {
        window.location.reload()
      } else {
        setErr(e.message)
      }
    } finally {
      setLoading(false)
    }
  }, [fetchAllCodes])

  useEffect(() => {
    load()
  }, [load])

  // ── Precision Epoch-Synchronized Countdown Timer ──────────────────────────
  useEffect(() => {
    if (accounts.length === 0) return
    const refreshing = new Set()

    function tick() {
      const nowSec = Math.floor(Date.now() / 1000)
      const newRemaining = {}
      const needRefresh = []

      accounts.forEach((acc) => {
        if (acc.type === 'hotp') return
        const period = acc.period || 30
        const rem = period - (nowSec % period)
        newRemaining[acc.id] = rem

        // If code just rolled over (remaining === period), refresh code
        if (rem === period && !refreshing.has(acc.id)) {
          needRefresh.push(acc.id)
          refreshing.add(acc.id)
        }
      })

      setTickerRemaining(newRemaining)

      // Refresh any expired accounts (de-duplicated and guarded against races)
      needRefresh.forEach((id) => {
        api.getCode(id)
          .then((res) => {
            setCodes((prev) => ({ ...prev, [id]: res }))
          })
          .catch((e) => console.error('Failed to refresh code', e))
          .finally(() => refreshing.delete(id))
      })
    }

    tick()
    const timer = setInterval(tick, 1000)

    // Handle tab focus / wake up
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
  }, [accounts, fetchAllCodes])

  // ── Keyboard shortcut: "/" to focus search ────────────────────────────────
  useEffect(() => {
    function handleKeyDown(e) {
      if (
        e.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

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
  function handleRenameGroup(groupId, newName, newLogo) {
    try {
      const target = customGroups.find((g) => g.id === groupId)
      const oldName = target?.name
      const oldLogo = target?.logo || ''
      const nameChanged = oldName !== undefined && oldName !== newName
      const logoChanged = typeof newLogo === 'string' && newLogo !== oldLogo

      // Persists the name AND the icon to localStorage + the database. The icon
      // belongs to the group alone — accounts keep their own logo and fall back
      // to issuer auto-detection.
      renameCustomGroup(groupId, newName, newLogo)

      // Only the name is propagated to member accounts. `logo` is deliberately
      // NOT sent: a group's icon must not overwrite each account's own icon.
      if (nameChanged) {
        setAccounts((prev) =>
          prev.map((a) => {
            if (a.group !== oldName && a.group !== newName) return a
            api.updateAccount(a.id, { group_name: newName }).catch((err) =>
              console.error('Failed to sync renamed group on server', err)
            )
            return { ...a, group: newName }
          })
        )
      }

      // Undo the damage from an earlier build that stamped the group's icon onto
      // every member account: clear it only where it exactly matches the icon
      // the group used to have, so those rows fall back to issuer detection.
      // Accounts carrying their own icon are left untouched.
      if (logoChanged && oldLogo) {
        setAccounts((prev) =>
          prev.map((a) => {
            if (a.group !== (nameChanged ? newName : oldName)) return a
            if (a.logo !== oldLogo) return a
            api.updateAccount(a.id, { logo: '' }).catch((err) =>
              console.error('Failed to clear group icon from account', err)
            )
            return { ...a, logo: '' }
          })
        )
      }
    } catch (e) {
      alert(e.message)
    }
  }

  function handleDeleteGroup(groupId) {
    const old = customGroups.find((g) => g.id === groupId)?.name
    deleteCustomGroup(groupId)
    setAccounts((prev) =>
      prev.map((a) => {
        if (a.group === old) {
          api.updateAccount(a.id, { group_name: '' }).catch((err) =>
            console.error('Failed to clear group on server', err)
          )
          return { ...a, group: '' }
        }
        return a
      })
    )
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
  // Swaps the source account with the target account. We only need to swap
  // positions inside the same group's slice; other groups stay untouched.
  const handleMoveAccount = useCallback((group, target, source) => {
    if (!group || !target || !source || target.id === source.id) return
    setAccounts((prev) => {
      // Build the new ordering for the whole list by rebuilding each group's
      // sub-list individually.
      const next = []
      const groups = new Map()
      for (const acc of prev) {
        const k = (acc.group || '').toLowerCase()
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(acc)
      }
      // Apply the swap inside the relevant group slice.
      const k = (group.name || '').toLowerCase()
      const slice = groups.get(k) || []
      const sIdx = slice.findIndex((a) => a.id === source.id)
      const tIdx = slice.findIndex((a) => a.id === target.id)
      if (sIdx !== -1 && tIdx !== -1) {
        const tmp = slice[sIdx]
        slice[sIdx] = slice[tIdx]
        slice[tIdx] = tmp
      }
      // Re-assemble in the same outer order as before.
      for (const acc of prev) {
        const key = (acc.group || '').toLowerCase()
        const sliceForKey = groups.get(key)
        if (sliceForKey && sliceForKey.length > 0) {
          next.push(sliceForKey.shift())
        }
      }
      // Cache the new global order so a reload shows the same layout
      setCachedAccountOrder(next.map((a) => a.id))
      // Send the new order to the server (global — same list as the cache)
      api
        .reorderAccounts(next.map((a) => a.id))
        .catch((err) =>
          console.warn('[Dashboard] Failed to persist account order', err?.message)
        )
      return next
    })
  }, [])

  // ── Move-group up/down via the header arrows ──────────────────────────────
  // Swaps the group with its neighbour in `customGroups`, persists locally,
  // and pushes the new global order to the server.
  const handleMoveGroup = useCallback((group, direction) => {
    setCustomGroups((prev) => {
      const idx = prev.findIndex((g) => g.id === group.id)
      const targetIdx = idx + direction
      if (idx === -1 || targetIdx < 0 || targetIdx >= prev.length) return prev
      const next = prev.slice()
      const tmp = next[idx]
      next[idx] = next[targetIdx]
      next[targetIdx] = tmp
      try {
        localStorage.setItem(
          '2fa_vault_custom_groups',
          JSON.stringify(next)
        )
      } catch (e) {
        console.error('Failed to persist reordered groups to localStorage', e)
      }
      setCachedGroupOrder(next.map((g) => g.id))
      api
        .reorderGroups(next.map((g) => g.id))
        .catch((err) =>
          console.warn('[Dashboard] Failed to persist group order', err?.message)
        )
      return next
    })
  }, [])

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
      console.error(e)
    }
    window.location.reload()
  }

  return (
    <div className="app">
      {/* ── Top Header Bar ────────────────────────────────────────── */}
      <div className="header">
        <div className="logo">
          <div className="vault-brand-icon">
            <FontAwesomeIcon icon={faShieldHalved} style={{ fontSize: 20 }} />
          </div>
          <h1>2FA Vault</h1>
          <span className="badge">{accounts.length}</span>
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
          >
            <FontAwesomeIcon icon={faPlus} style={{ fontSize: 12 }} /> <span className="btn-label">Group</span>
          </button>

          {/* Edit Position Toggle — reveals up/down arrows on every row and group */}
          <button
            className={`btn header-btn ${editMode ? 'btn-primary' : ''}`}
            onClick={() => setEditMode((v) => !v)}
            title={editMode ? 'Done editing positions' : 'Edit positions of groups and accounts'}
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

      {/* ── Search Bar matching user mockup ───────────────────────── */}
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
          >
            <FontAwesomeIcon icon={faXmark} style={{ fontSize: 14 }} />
          </button>
        )}
        <span className="search-kbd-shortcut">/</span>
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

      {err && <div className="error">{err}</div>}

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
      ) : filteredAccounts.length === 0 ? (
        <div className="card empty">
          No accounts found matching &ldquo;{searchQuery}&rdquo;.
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
            setAccounts((list) => [acc, ...list])
            setShowAdd(false)
            setAddDefaultGroup('')
            // Fetch code for newly created account
            api.getCode(acc.id).then((codeData) => {
              setCodes((prev) => ({ ...prev, [acc.id]: codeData }))
            }).catch((e) => console.error(e))
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
    </div>
  )
}
