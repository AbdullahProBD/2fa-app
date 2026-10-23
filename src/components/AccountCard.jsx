import { useState, useRef, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCopy, faCheck, faPenToSquare, faXmark } from '@fortawesome/free-solid-svg-icons'
import Countdown from './Countdown.jsx'
import { ServiceLogo } from '../lib/icons.jsx'
import DeleteModal from './DeleteModal.jsx'
import EditAccountModal from './EditAccountModal.jsx'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'

export default function AccountCard({
  account,
  code: liveCode,
  remaining = 30,
  period = 30,
  masked = false,
  editMode = false,
  onDelete,
  onUpdate,
}) {
  const [copied, setCopied] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [hotpCounter, setHotpCounter] = useState(account.counter ?? 0)
  const [manualCode, setManualCode] = useState(null)
  const [loadingCode, setLoadingCode] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copiedTimer = useRef(0)

  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const code = manualCode || liveCode

  async function copyCode(e) {
    if (e) e.stopPropagation()
    if (!code) return
    const ok = await copyText(code)
    setCopied(ok)
    setCopyFailed(!ok)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => {
      setCopied(false)
      setCopyFailed(false)
    }, 1600)
  }

  // Only react to keys pressed on the card itself, not on the nested buttons.
  function onActivateKey(e) {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      copyCode(e)
    }
  }

  async function handleNextHotp(e) {
    e.stopPropagation()
    if (loadingCode) return
    setLoadingCode(true)
    try {
      const nextCounter = Number(hotpCounter) + 1
      const res = await api.getCode(account.id, nextCounter)
      setManualCode(res.code)
      setHotpCounter(nextCounter)
    } catch (err) {
      console.error('Failed to generate next HOTP code', err?.message)
    } finally {
      setLoadingCode(false)
    }
  }

  async function confirmDelete() {
    setDeleting(true)
    try {
      await api.deleteAccount(account.id)
      onDelete(account.id)
      setShowDeleteModal(false)
    } catch (e) {
      alert(e.message || 'Failed to delete account')
    } finally {
      setDeleting(false)
    }
  }

  function formatCode(c) {
    if (!c) return '••••••'
    if (masked) return '••••••'
    if (c.length === 6) return `${c.slice(0, 3)} ${c.slice(3)}`
    if (c.length === 8) return `${c.slice(0, 4)} ${c.slice(4)}`
    return c.match(/.{1,3}/g)?.join(' ') || c
  }

  return (
    <>
      <div
        className={`account-card ${copied ? 'copied-flash' : ''}`}
        onClick={copyCode}
        onKeyDown={onActivateKey}
        role="button"
        tabIndex={0}
        title={copyFailed ? 'Copy failed — select the code manually' : 'Tap to copy code'}
        aria-label={`Copy code for ${account.label}`}
      >
        {/* Left: Logo & Account Info */}
        <div className="account-left">
          <ServiceLogo
            logo={account.logo}
            issuer={account.issuer}
            label={account.label}
            size={40}
          />
          <div className="account-info">
            <div className="account-label-row">
              <span className="account-label" title={account.label}>
                {account.label}
              </span>
              {account.group && (
                <span
                  className="account-group-tag"
                  style={{ cursor: 'pointer' }}
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowEditModal(true)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      e.stopPropagation()
                      setShowEditModal(true)
                    }
                  }}
                  title="Click to change group"
                >
                  {account.group}
                </span>
              )}
            </div>
            <div className="account-meta-text">
              {account.issuer ? `${account.issuer} · ` : ''}
              {String(account.type || 'totp').toUpperCase()} · {account.digits}d · {account.algorithm}
            </div>
          </div>
        </div>

        {/* Right: Live Code & Live Timer & Actions */}
        <div className="code-block" onClick={(e) => e.stopPropagation()}>
          {account.type === 'hotp' ? (
            <div className="hotp-row">
              <div
                className="code"
                onClick={copyCode}
                title="Click to copy code"
                role="button"
                tabIndex={0}
                onKeyDown={onActivateKey}
              >
                {formatCode(code)}
              </div>
              <button
                className="btn btn-sm"
                onClick={handleNextHotp}
                disabled={loadingCode}
                title="Generate next counter code"
              >
                {loadingCode ? '…' : `Next (#${hotpCounter})`}
              </button>
            </div>
          ) : (
            <div className="totp-row">
              <div
                className={`code ${remaining <= 5 ? 'expired' : ''}`}
                onClick={copyCode}
                title="Click to copy code"
                role="button"
                tabIndex={0}
                onKeyDown={onActivateKey}
              >
                {formatCode(code)}
              </div>
              <Countdown remaining={remaining} period={period} size={36} />
            </div>
          )}

          {/* Actions: copy, edit, and (edit-mode-only) inline delete */}
          <div className="card-actions">
            <button
              className={`btn-icon ${copied ? 'success' : ''}`}
              onClick={copyCode}
              title={copied ? 'Copied!' : 'Copy Code'}
              aria-label="Copy code"
            >
              {copied ? (
                <FontAwesomeIcon icon={faCheck} style={{ fontSize: 16 }} />
              ) : (
                <FontAwesomeIcon icon={faCopy} style={{ fontSize: 16 }} />
              )}
            </button>

            {!editMode && (
              <button
                className="btn-icon"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowEditModal(true)
                }}
                title="Edit Account"
                aria-label="Edit account"
              >
                <FontAwesomeIcon icon={faPenToSquare} style={{ fontSize: 15 }} />
              </button>
            )}

            {/* Delete button: visible only in editMode. Opens the 2-step
                delete popup (warning → type `sudo rm 2fa`). */}
            {editMode && (
              <button
                className="btn-icon btn-danger"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowDeleteModal(true)
                }}
                title="Delete account"
                aria-label="Delete account"
              >
                <FontAwesomeIcon icon={faXmark} style={{ fontSize: 16 }} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Two-step delete: warning, then type `sudo rm 2fa` to confirm. */}
      <DeleteModal
        isOpen={showDeleteModal}
        variant="account"
        account={account}
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setShowDeleteModal(false)}
      />

      {/* Edit Modal */}
      <EditAccountModal
        isOpen={showEditModal}
        account={account}
        onClose={() => setShowEditModal(false)}
        onUpdated={(updated) => {
          if (onUpdate) onUpdate(updated)
        }}
      />
    </>
  )
}