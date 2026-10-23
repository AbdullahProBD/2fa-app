import { useState, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPlus } from '@fortawesome/free-solid-svg-icons'
import { getBrand, ServiceLogo, detectService } from '../lib/icons.jsx'
import {
  getCustomGroups,
  createCustomGroup,
  setAccountMeta,
  subscribeGroups,
} from '../lib/groupsStorage.js'
import { api } from '../lib/api.js'
import IconPickerModal from './IconPickerModal.jsx'
import GroupModal from './GroupModal.jsx'
import Modal from './Modal.jsx'
import Select from './Select.jsx'

export default function EditAccountModal({
  isOpen,
  account,
  onClose,
  onUpdated,
}) {
  const [label, setLabel] = useState(account?.label || '')
  const [issuer, setIssuer] = useState(account?.issuer || '')
  const [group, setGroup] = useState(account?.group || '')
  const [logo, setLogo] = useState(account?.logo || '')
  const [customGroups, setCustomGroups] = useState([])
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  // Sync state whenever modal is opened or target account changes
  useEffect(() => {
    if (isOpen && account) {
      setLabel(account.label || '')
      setIssuer(account.issuer || '')
      setGroup(account.group || '')
      setLogo(account.logo || '')
      setCustomGroups(getCustomGroups())
      setErr('')
    }
  }, [isOpen, account])

  // Reactively track groups created or renamed. Only while open: every account
  // card mounts one of these, so an always-on subscription re-parses
  // localStorage once per card on each change.
  useEffect(() => {
    if (!isOpen) return undefined
    setCustomGroups(getCustomGroups())
    return subscribeGroups(() => {
      setCustomGroups(getCustomGroups())
    })
  }, [isOpen])

  if (!isOpen || !account) return null

  // Ensure current group is selectable even if not yet saved in customGroups
  const groupExistsInList =
    !group || customGroups.some((g) => g.name.toLowerCase() === group.toLowerCase())

  function handleIssuerChange(e) {
    const val = e.target.value
    setIssuer(val)
    if (!logo || getBrand(logo)) {
      const auto = detectService(val)
      if (auto) setLogo(auto)
    }
  }

  async function submit(e) {
    e.preventDefault()
    setErr('')
    if (loading) return
    if (!label.trim()) {
      setErr('Account label is required')
      return
    }

    setLoading(true)
    const payload = {
      label: label.trim(),
      issuer: issuer.trim(),
      group_name: group,
      logo: logo,
    }

    try {
      const res = await api.updateAccount(account.id, payload)
      setAccountMeta(account.id, { group, logo })
      const merged = {
        ...account,
        ...(res?.account || {}),
        group,
        logo,
      }
      onUpdated(merged)
      onClose()
    } catch (e) {
      // Keep the dialog open and local state untouched so the UI never shows
      // changes the server rejected (or never received).
      setErr(e.message || 'Failed to save changes')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Modal
        onClose={onClose}
        dismissible={!loading}
        ariaLabel="Edit 2FA account"
        style={{ maxWidth: 480 }}
        backdropStyle={{ zIndex: 1000 }}
      >
          <h2>Edit 2FA Account</h2>

          <form onSubmit={submit}>
            {/* Account Icon Trigger */}
            <div className="field" style={{ marginBottom: 16 }}>
              <label className="label">Icon / Logo</label>
              <div
                className="icon-picker-trigger"
                role="button"
                tabIndex={0}
                aria-label="Choose icon"
                onClick={() => setShowIconPicker(true)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    setShowIconPicker(true)
                  }
                }}
              >
                <div className="icon-picker-trigger-left">
                  <ServiceLogo logo={logo} issuer={issuer} label={label} size={42} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>
                      {logo && getBrand(logo) ? getBrand(logo).name : logo ? 'Custom Logo' : 'Auto Initials'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      Click to choose from 70+ logos or upload
                    </div>
                  </div>
                </div>
                <button type="button" className="btn btn-sm">
                  Change Icon
                </button>
              </div>
            </div>

            <div className="row">
              <div className="field">
                <label className="label" htmlFor="edit-account-label">Label / Name *</label>
                <input
                  id="edit-account-label"
                  className="input"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="edit-account-issuer">Issuer (Service)</label>
                <input
                  id="edit-account-issuer"
                  className="input"
                  value={issuer}
                  onChange={handleIssuerChange}
                  placeholder="e.g. GitHub, Google"
                />
              </div>
            </div>

            {/* Group / Category Selector with inline Create Group */}
            <div className="field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label className="label" style={{ margin: 0 }}>Group / Category</label>
                <button
                  type="button"
                  className="btn-link"
                  style={{ fontSize: 12, padding: 0 }}
                  onClick={() => setShowCreateGroupModal(true)}
                >
                  <FontAwesomeIcon icon={faPlus} style={{ fontSize: 11 }} /> Create New Group
                </button>
              </div>
              <Select
                value={group}
                onChange={setGroup}
                ariaLabel="Group / Category"
                options={[
                  { value: '', label: '(No Group / Ungrouped)' },
                  ...(!groupExistsInList
                    ? [{ value: group, label: `${group} (Current)` }]
                    : []),
                  ...customGroups.map((g) => ({ value: g.name, label: g.name })),
                ]}
              />
            </div>

            <div className="field" style={{ padding: '10px 14px', background: 'var(--bg)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                <strong>Algorithm:</strong> {account.algorithm} &nbsp;|&nbsp; <strong>Type:</strong> {account.type.toUpperCase()} &nbsp;|&nbsp; <strong>Digits:</strong> {account.digits}d
              </div>
            </div>

            {err && <div className="error" role="alert">{err}</div>}

            <div className="modal-actions" style={{ marginTop: 20 }}>
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </form>
      </Modal>

      {/* Dedicated Icon Picker Modal */}
      <IconPickerModal
        isOpen={showIconPicker}
        currentLogo={logo}
        issuer={issuer}
        label={label}
        onSelect={(newLogo) => setLogo(newLogo)}
        onClose={() => setShowIconPicker(false)}
      />

      {/* Inline Create Group Modal */}
      {showCreateGroupModal && (
        <GroupModal
          isOpen={showCreateGroupModal}
          onSave={(newName, newLogo) => {
            const created = createCustomGroup(newName, newLogo)
            setCustomGroups(getCustomGroups())
            setGroup(created.name)
            setShowCreateGroupModal(false)
          }}
          onClose={() => setShowCreateGroupModal(false)}
        />
      )}
    </>
  )
}
