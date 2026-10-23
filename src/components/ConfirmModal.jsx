import Modal from './Modal.jsx'

export default function ConfirmModal({ title, message, confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true, onConfirm, onCancel }) {
  return (
    <Modal onClose={onCancel} ariaLabel={title} className="modal modal-sm">
      <h2>{title}</h2>
      <p className="confirm-message">{message}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>{cancelLabel}</button>
        <button
          type="button"
          className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`}
          onClick={onConfirm}
          autoFocus
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
