import { useState, useEffect, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faCheck,
  faTriangleExclamation,
  faLock,
  faTrashCan,
  faArrowRight,
  faArrowLeft,
  faXmark,
  faCopy,
} from '@fortawesome/free-solid-svg-icons'
import { ServiceLogo } from '../lib/icons.jsx'
import { copyText } from '../lib/clipboard.js'
import Modal from './Modal.jsx'

// Step-2 typed confirmation phrase per delete target.
// Groups require `sudo rm group`, single 2FA accounts require `sudo rm 2fa`.
const CONFIRM_PHRASES = {
  account: 'sudo rm 2fa',
  group: 'sudo rm group',
}

export default function DeleteModal({
  isOpen,
  account,
  variant = 'account',
  // Legacy / Group deletion props
  title: customTitle,
  message: customMessage,
  itemName,
  onConfirm,
  onCancel,
  loading = false,
}) {
  const CONFIRM_PHRASE = CONFIRM_PHRASES[variant] || CONFIRM_PHRASES.account
  const [step, setStep] = useState(1)
  const [confirmText, setConfirmText] = useState('')
  const [copiedPhrase, setCopiedPhrase] = useState(false)
  const inputRef = useRef(null)
  const copiedTimer = useRef(0)

  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  // Reset whenever modal opens
  useEffect(() => {
    if (isOpen) {
      setStep(1)
      setConfirmText('')
      setCopiedPhrase(false)
    }
  }, [isOpen])

  // Auto-focus input when reaching step 2
  useEffect(() => {
    if (step !== 2) return undefined
    const t = setTimeout(() => inputRef.current?.focus(), 90)
    return () => clearTimeout(t)
  }, [step])

  if (!isOpen) return null

  const isGroupDelete = Boolean(!account && (itemName || customTitle?.toLowerCase().includes('group')))
  const accountName = account?.label || itemName || ''
  const accountIssuer = account?.issuer || ''
  const isConfirmed = confirmText.trim().toLowerCase() === CONFIRM_PHRASE.toLowerCase()

  function handleSubmit(e) {
    e.preventDefault()
    if (step === 1) {
      setStep(2)
      return
    }
    if (step === 2 && isConfirmed && !loading) {
      onConfirm()
    }
  }

  // Clicking the red phrase chip copies it so the user can paste it below
  async function copyPhrase() {
    if (await copyText(CONFIRM_PHRASE)) {
      setCopiedPhrase(true)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopiedPhrase(false), 1600)
    }
  }

  return (
      <Modal
        onClose={onCancel}
        dismissible={!loading}
        ariaLabel={customTitle || (isGroupDelete ? 'Delete group' : 'Delete 2FA account')}
        className="modal delete-modal"
        style={{ maxWidth: 460, border: '1px solid rgba(239, 68, 68, 0.2)' }}
        backdropStyle={{ zIndex: 1200 }}
      >
        {/* Step Indicator */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 18 }}>
          {[1, 2].map((s) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  padding: '3px 10px',
                  borderRadius: 999,
                  background: step === s ? 'rgba(239, 68, 68, 0.18)' : 'var(--panel-2)',
                  color: step === s ? '#ef4444' : 'var(--muted)',
                  border: step === s ? '1px solid rgba(239, 68, 68, 0.35)' : '1px solid transparent',
                  transition: 'all 0.2s',
                }}
              >
                {step > s ? (
                  <FontAwesomeIcon icon={faCheck} style={{ fontSize: 12 }} />
                ) : (
                  `${s}. `
                )}
                {s === 1 ? 'Warning' : 'Confirm'}
              </span>
              {s === 1 && (
                <FontAwesomeIcon
                  icon={faArrowRight}
                  style={{ color: 'var(--muted)', fontSize: 12 }}
                />
              )}
            </div>
          ))}
        </div>

        {/* Danger Icon with glowing border */}
        <div className="delete-modal-icon">
          <FontAwesomeIcon icon={faTriangleExclamation} style={{ fontSize: 24 }} />
        </div>

        {/* ── STEP 1: Warning ── */}
        {step === 1 && (
          <div>
            <h2 style={{ marginBottom: 8, fontSize: 19 }}>
              {customTitle || (isGroupDelete ? 'Delete Group?' : 'Delete 2FA Account?')}
            </h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 16px', lineHeight: 1.55 }}>
              {customMessage ||
                (isGroupDelete
                  ? 'You are about to delete this group. Accounts inside will not be deleted; they will be moved to Ungrouped.'
                  : 'You are about to permanently delete this 2FA account from your vault.')}
            </p>

            {/* Target Item preview card */}
            {(accountName || account) && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 14px',
                  background: 'var(--panel-2)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  marginBottom: 16,
                }}
              >
                {account && (
                  <ServiceLogo logo={account.logo} issuer={account.issuer} label={account.label} size={36} />
                )}
                <div style={{ textAlign: 'left', overflow: 'hidden', flex: 1 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 14,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {accountName}
                  </div>
                  {accountIssuer && (
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{accountIssuer}</div>
                  )}
                  {account?.group && (
                    <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 2 }}>
                      Group: {account.group}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Warning Callout Box with SVG */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                borderRadius: 'var(--radius-sm)',
                padding: '12px 14px',
                textAlign: 'left',
                fontSize: 12.5,
                color: '#fca5a5',
                marginBottom: 20,
                lineHeight: 1.5,
              }}
            >
              <FontAwesomeIcon
                icon={faTriangleExclamation}
                style={{ flexShrink: 0, marginTop: 1, fontSize: 18, color: '#ef4444' }}
              />
              <div>
                <strong>Warning:</strong>{' '}
                {isGroupDelete
                  ? 'Deleting this group cannot be undone. All 2FA accounts inside this group will be moved to Ungrouped.'
                  : 'This action is permanent and cannot be undone. If you lose access to this 2FA secret, you may get locked out of your account.'}
              </div>
            </div>

            <div className="modal-actions" style={{ justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="btn btn-ghost" onClick={onCancel}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger-solid"
                onClick={() => setStep(2)}
              >
                Continue <FontAwesomeIcon icon={faArrowRight} style={{ fontSize: 12 }} />
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2: Type SUDO DELETE ── */}
        {step === 2 && (
          <form onSubmit={handleSubmit}>
            <h2 style={{ marginBottom: 6, fontSize: 19, color: '#ef4444' }}>Final Confirmation</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 12px', lineHeight: 1.55 }}>
              To permanently delete{' '}
              <strong style={{ color: 'var(--text)', overflowWrap: 'anywhere' }}>
                {accountName || (isGroupDelete ? 'this group' : 'this account')}
              </strong>
              , click the phrase to copy it, then type it in the box below:
            </p>

            {/* Click-to-copy phrase chip — single line, never wraps mid-phrase */}
            <button
              type="button"
              className={`delete-phrase-chip ${copiedPhrase ? 'copied' : ''}`}
              onClick={copyPhrase}
              title="Click to copy phrase"
            >
              <code>{CONFIRM_PHRASE}</code>
              <FontAwesomeIcon
                icon={copiedPhrase ? faCheck : faCopy}
                style={{ fontSize: 12 }}
              />
              <span>{copiedPhrase ? 'Copied!' : 'Copy'}</span>
            </button>

            {/* Beautiful Custom Input Field with Left SVG Icon */}
            <div className="delete-input-wrap">
              <div className="delete-input-icon">
                <FontAwesomeIcon
                  icon={faLock}
                  style={{ fontSize: 18, color: isConfirmed ? '#10b981' : '#ef4444' }}
                />
              </div>

              <input
                ref={inputRef}
                type="text"
                className={`delete-confirm-input ${isConfirmed ? 'confirmed' : ''}`}
                placeholder={`Type: ${CONFIRM_PHRASE}`}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            {/* Live validation & status bar */}
            <div className="delete-status-bar">
              <div>
                {confirmText && !isConfirmed && (
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                    {CONFIRM_PHRASE.toLowerCase().startsWith(confirmText.trim().toLowerCase())
                      ? `Keep typing… ${CONFIRM_PHRASE.length - confirmText.trim().length} chars left`
                      : <><FontAwesomeIcon icon={faXmark} style={{ fontSize: 12 }} /> Does not match — must type: {CONFIRM_PHRASE}</>}
                  </span>
                )}
                {isConfirmed && (
                  <span style={{ color: '#10b981', fontWeight: 600, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <FontAwesomeIcon icon={faCheck} style={{ fontSize: 14 }} />
                    Ready to delete
                  </span>
                )}
              </div>

              {/* Status badge pill */}
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'monospace',
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: isConfirmed ? 'rgba(16, 185, 129, 0.15)' : 'var(--panel-2)',
                  color: isConfirmed ? '#10b981' : 'var(--muted)',
                  border: `1px solid ${isConfirmed ? 'rgba(16, 185, 129, 0.3)' : 'var(--border)'}`,
                  transition: 'all 0.2s',
                }}
              >
                {confirmText.trim().length} / {CONFIRM_PHRASE.length}
              </span>
            </div>

            {/* Modal Actions with SVG Trash Icon */}
            <div className="modal-actions" style={{ justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={loading}>
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setStep(1)}
                disabled={loading}
                style={{ borderColor: 'var(--border)' }}
              >
                <FontAwesomeIcon icon={faArrowLeft} style={{ fontSize: 12 }} /> Back
              </button>
              <button
                type="submit"
                className="btn btn-danger-solid"
                disabled={!isConfirmed || loading}
                style={{
                  opacity: !isConfirmed || loading ? 0.55 : 1,
                  cursor: !isConfirmed || loading ? 'not-allowed' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                }}
              >
                {loading ? (
                  <>
                    <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                    <span>Deleting…</span>
                  </>
                ) : (
                  <>
                    {/* Font Awesome Trash Icon */}
                    <FontAwesomeIcon icon={faTrashCan} style={{ fontSize: 15 }} />
                    <span>{isGroupDelete ? 'Delete Group Forever' : 'Delete Forever'}</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </Modal>
  )
}
