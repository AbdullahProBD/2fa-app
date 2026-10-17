import { useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faPlus,
  faPen,
  faTrashCan,
  faChevronUp,
  faChevronDown,
} from '@fortawesome/free-solid-svg-icons'
import AccountCard from './AccountCard.jsx'
import { ServiceLogo } from '../lib/icons.jsx'
import DeleteModal from './DeleteModal.jsx'
import GroupModal from './GroupModal.jsx'

export default function GroupContainer({
  group, // { id, name, logo, count }
  accounts = [],
  codes = {},
  tickerRemaining = {},
  masked = false,
  editMode = false,
  collapsed: collapsedProp,
  onCollapseChange,
  onDeleteAccount,
  onUpdateAccount,
  onRenameGroup,
  onDeleteGroup,
  onAddAccountToGroup,
  onMoveAccount,
  onMoveGroup,
  canMoveGroupUp,
  canMoveGroupDown,
  showGroupArrows = false,
}) {
  // Collapse state is lifted to the Dashboard (which persists it to the DB) when
  // `collapsed` is supplied; otherwise the group manages it locally so the
  // component stays usable on its own.
  const [collapsedLocal, setCollapsedLocal] = useState(false)
  const [showRenameModal, setShowRenameModal] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)

  const isControlled = typeof collapsedProp === 'boolean'
  const collapsed = isControlled ? collapsedProp : collapsedLocal

  function toggleCollapsed() {
    const next = !collapsed
    if (isControlled) {
      if (typeof onCollapseChange === 'function') onCollapseChange(group, next)
    } else {
      setCollapsedLocal(next)
    }
  }

  const isCustomGroup = Boolean(group.id && group.id !== 'ungrouped' && group.id !== 'all')
  const reorderable =
    Boolean(onMoveAccount) && accounts.length > 0 && !collapsed && editMode

  function move(idx, dir) {
    const target = idx + dir
    if (target < 0 || target >= accounts.length) return
    if (typeof onMoveAccount === 'function') {
      onMoveAccount(group, accounts[target], accounts[idx])
    }
  }

  return (
    <div className="group-container">
      {/* Group Header */}
      <div className="group-header" onClick={toggleCollapsed}>
        <div className="group-header-left">
          <ServiceLogo
            logo={group.logo}
            issuer={group.name}
            label={group.name}
            size={24}
            style={{ borderRadius: 6 }}
          />
          <span className="group-title">{group.name}</span>
          <span className="group-count-badge">{accounts.length}</span>
        </div>

        <div className="group-header-right" onClick={(e) => e.stopPropagation()}>
          {/* Add account directly to this group */}
          <button
            className="group-action-btn"
            onClick={() => onAddAccountToGroup(group.name)}
            title={`Add account to ${group.name}`}
          >
            <FontAwesomeIcon icon={faPlus} style={{ fontSize: 14 }} />
          </button>

          {/* Rename group */}
          {isCustomGroup && (
            <button
              className="group-action-btn"
              onClick={() => setShowRenameModal(true)}
              title="Rename Group"
            >
              <FontAwesomeIcon icon={faPen} style={{ fontSize: 13 }} />
            </button>
          )}

          {/* Delete group — visible only in edit mode */}
          {editMode && isCustomGroup && (
            <button
              className="group-action-btn btn-danger"
              onClick={() => setShowDeleteModal(true)}
              title="Delete Group"
            >
              <FontAwesomeIcon icon={faTrashCan} style={{ fontSize: 13 }} />
            </button>
          )}

          {/* Move group up/down (edit mode only, custom groups) */}
          {showGroupArrows && (
            <>
              <button
                className="group-action-btn"
                disabled={!canMoveGroupUp}
                onClick={() => onMoveGroup && onMoveGroup(group, -1)}
                title="Move group up"
                aria-label="Move group up"
              >
                <FontAwesomeIcon icon={faChevronUp} style={{ fontSize: 14 }} />
              </button>
              <button
                className="group-action-btn"
                disabled={!canMoveGroupDown}
                onClick={() => onMoveGroup && onMoveGroup(group, 1)}
                title="Move group down"
                aria-label="Move group down"
              >
                <FontAwesomeIcon icon={faChevronDown} style={{ fontSize: 14 }} />
              </button>
              <span className="group-header-divider" aria-hidden="true" />
            </>
          )}

          {/* Collapse/Expand indicator */}
          <button
            className="group-action-btn"
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand group' : 'Collapse group'}
            aria-expanded={!collapsed}
          >
            <FontAwesomeIcon
              icon={faChevronDown}
              style={{
                fontSize: 14,
                transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s ease',
              }}
            />
          </button>
        </div>
      </div>

      {/* Group Items — smooth slide expand/collapse via grid-rows animation */}
      <div className={`group-collapse ${collapsed ? 'collapsed' : ''}`} aria-hidden={collapsed}>
        <div className="group-collapse-inner">
          <div className="group-items">
          {accounts.length === 0 ? (
            <div className="group-empty-hint">
              No accounts in this group yet.{' '}
              <button
                className="btn-link"
                onClick={() => onAddAccountToGroup(group.name)}
              >
                <FontAwesomeIcon icon={faPlus} style={{ fontSize: 11 }} /> Add one
              </button>
            </div>
          ) : (
            accounts.map((acc, idx) => {
              const codeData = codes[acc.id]
              const rem =
                tickerRemaining[acc.id] ?? codeData?.remaining ?? acc.period
              return (
                <div key={acc.id} className="account-row">
                  <AccountCard
                    account={acc}
                    code={codeData?.code}
                    remaining={rem}
                    period={acc.period}
                    masked={masked}
                    editMode={editMode}
                    onDelete={onDeleteAccount}
                    onUpdate={onUpdateAccount}
                  />
                  {reorderable && (
                    <div className="reorder-controls" aria-label="Reorder account">
                      <button
                        className="reorder-btn"
                        disabled={idx === 0}
                        onClick={() => move(idx, -1)}
                        title="Move up"
                        aria-label="Move up"
                      >
                        <FontAwesomeIcon icon={faChevronUp} style={{ fontSize: 12 }} />
                      </button>
                      <button
                        className="reorder-btn"
                        disabled={idx === accounts.length - 1}
                        onClick={() => move(idx, 1)}
                        title="Move down"
                        aria-label="Move down"
                      >
                        <FontAwesomeIcon icon={faChevronDown} style={{ fontSize: 12 }} />
                      </button>
                    </div>
                  )}
                </div>
              )
            })
          )}
          </div>
        </div>
      </div>

      {/* Rename Modal */}
      {showRenameModal && (
        <GroupModal
          isOpen={showRenameModal}
          initialName={group.name}
          initialLogo={group.logo}
          isEdit={true}
          onSave={(newName, newLogo) => {
            onRenameGroup(group.id, newName, newLogo)
            setShowRenameModal(false)
          }}
          onClose={() => setShowRenameModal(false)}
        />
      )}

      {/* Delete Group Modal */}
      {showDeleteModal && (
        <DeleteModal
          isOpen={showDeleteModal}
          variant="group"
          title="Delete Group"
          message="Are you sure you want to delete this group? Accounts inside will not be deleted; they will be moved to Ungrouped."
          itemName={group.name}
          onConfirm={() => {
            onDeleteGroup(group.id)
            setShowDeleteModal(false)
          }}
          onCancel={() => setShowDeleteModal(false)}
        />
      )}
    </div>
  )
}