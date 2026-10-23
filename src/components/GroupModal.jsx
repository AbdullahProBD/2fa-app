import { useState } from 'react'
import { getBrand, ServiceLogo, detectService } from '../lib/icons.jsx'
import IconPickerModal from './IconPickerModal.jsx'
import Modal from './Modal.jsx'

export default function GroupModal({
  isOpen,
  initialName = '',
  initialLogo = '',
  isEdit = false,
  onSave,
  onClose,
}) {
  const [name, setName] = useState(initialName)
  const [logo, setLogo] = useState(initialLogo)
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [err, setErr] = useState('')

  if (!isOpen) return null

  function handleNameChange(e) {
    const val = e.target.value
    setName(val)
    if (!logo || getBrand(logo)) {
      const auto = detectService(val)
      if (auto) setLogo(auto)
    }
  }

  function submit(e) {
    e.preventDefault()
    setErr('')
    const trimmed = name.trim()
    if (!trimmed) {
      setErr('Group name is required')
      return
    }
    try {
      onSave(trimmed, logo)
      onClose()
    } catch (err) {
      setErr(err.message)
    }
  }

  return (
    <>
      <Modal
        onClose={onClose}
        ariaLabel={isEdit ? 'Rename group' : 'Create new group'}
        style={{ maxWidth: 440 }}
        backdropStyle={{ zIndex: 1000 }}
      >
          <h2>{isEdit ? 'Rename Group' : 'Create New Group'}</h2>

          <form onSubmit={submit}>
            <div className="field">
              <label className="label" htmlFor="group-name-input">Group Name *</label>
              <input
                id="group-name-input"
                className="input"
                autoFocus
                maxLength={64}
                placeholder="e.g. GITHUB, WORK, FINANCE..."
                value={name}
                onChange={handleNameChange}
                required
              />
            </div>

            <div className="field" style={{ marginTop: 16 }}>
              <label className="label">Group Icon (Optional)</label>
              <div
                className="icon-picker-trigger"
                role="button"
                tabIndex={0}
                aria-label="Choose group icon"
                onClick={() => setShowIconPicker(true)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    setShowIconPicker(true)
                  }
                }}
              >
                <div className="icon-picker-trigger-left">
                  <ServiceLogo logo={logo} issuer={name} label={name} size={32} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {logo && getBrand(logo) ? getBrand(logo).name : logo ? 'Custom Icon' : 'Auto / Monogram'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      Click to choose from 70+ icons
                    </div>
                  </div>
                </div>
                <button type="button" className="btn btn-sm">
                  Change Icon
                </button>
              </div>
            </div>

            {err && <div className="error" role="alert" style={{ marginTop: 12 }}>{err}</div>}

            <div className="modal-actions" style={{ marginTop: 22 }}>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                {isEdit ? 'Save Changes' : 'Create Group'}
              </button>
            </div>
          </form>
      </Modal>

      {/* Dedicated Icon Picker Popup */}
      <IconPickerModal
        isOpen={showIconPicker}
        currentLogo={logo}
        issuer={name}
        label={name}
        onSelect={(newLogo) => setLogo(newLogo)}
        onClose={() => setShowIconPicker(false)}
      />
    </>
  )
}
