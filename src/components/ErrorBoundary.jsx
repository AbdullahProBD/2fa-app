import { Component } from 'react'

// Keeps a render-time crash from leaving a blank page; never shows details
// that could contain account data.
export default class ErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('UI crashed:', error?.message)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="login-page">
        <div className="card login-card" role="alert">
          <h1 style={{ marginTop: 0 }}>Something went wrong</h1>
          <p className="info">The page hit an unexpected error. Reloading usually fixes it.</p>
          <button type="button" className="btn btn-primary" style={{ width: '100%' }} onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
