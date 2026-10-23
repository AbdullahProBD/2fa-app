import { useState, useRef, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faQrcode, faPlus, faCamera, faRotateRight } from '@fortawesome/free-solid-svg-icons'
import jsQR from 'jsqr'
import { api } from '../lib/api.js'
import { getBrand, ServiceLogo, detectService } from '../lib/icons.jsx'
import { getCustomGroups, createCustomGroup, setAccountMeta } from '../lib/groupsStorage.js'
import GroupModal from './GroupModal.jsx'
import IconPickerModal from './IconPickerModal.jsx'
import { normalizeSecret, validateSecret } from '../lib/otp.js'
import Modal from './Modal.jsx'
import Select from './Select.jsx'

const MAX_QR_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_QR_IMAGE_PIXELS = 50_000_000

const QR_DECODE_OPTS = { inversionAttempts: 'attemptBoth' }

// ── Live camera QR scanner (no extra deps — uses getUserMedia + jsQR) ──────
// Mounts the rear camera, scans video frames ~5x/sec, and calls onDetected
// once with the raw QR payload. Unmount to stop the camera.
function CameraScanner({ onDetected }) {
  const videoRef = useRef(null)
  const [status, setStatus] = useState('starting') // starting | scanning | error
  const [errMsg, setErrMsg] = useState('')
  const [attempt, setAttempt] = useState(0)
  const onDetectedRef = useRef(onDetected)
  onDetectedRef.current = onDetected

  useEffect(() => {
    const video = videoRef.current
    let stream = null
    let raf = 0
    let lastRun = 0
    let stopped = false

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            'Camera needs a secure (HTTPS) connection. Open this page via HTTPS or localhost, or use Upload instead.'
          )
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        })
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        if (!video) return
        video.srcObject = stream
        // Set via property: React's `muted` prop only sets the attribute,
        // which some mobile browsers ignore for autoplay policy.
        video.muted = true
        await video.play()
        if (stopped) return
        setStatus('scanning')

        const canvas = document.createElement('canvas')
        const loop = (t) => {
          if (stopped) return
          raf = requestAnimationFrame(loop)
          if (t - lastRun < 200) return // ~5 fps is plenty for QR
          lastRun = t
          const v = videoRef.current
          if (!v || v.readyState < 2 || !v.videoWidth) return
          const scale = Math.min(1, 640 / v.videoWidth)
          const w = Math.round(v.videoWidth * scale)
          const h = Math.round(v.videoHeight * scale)
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w
            canvas.height = h
          }
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(v, 0, 0, w, h)
          try {
            const imageData = ctx.getImageData(0, 0, w, h)
            const code = jsQR(imageData.data, w, h, QR_DECODE_OPTS)
            if (code && code.data) {
              stopped = true
              cancelAnimationFrame(raf)
              stream?.getTracks().forEach((t) => t.stop())
              onDetectedRef.current(code.data)
            }
          } catch {
            // ignore per-frame errors, keep scanning
          }
        }
        raf = requestAnimationFrame(loop)
      } catch (e) {
        if (stopped) return
        setStatus('error')
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
          setErrMsg('Camera permission was denied. Allow camera access in your browser, then try again — or use Upload instead.')
        } else if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) {
          setErrMsg('No camera found on this device. Use Upload instead.')
        } else {
          setErrMsg(e.message || 'Could not start the camera. Use Upload instead.')
        }
      }
    }

    start()
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      if (stream) stream.getTracks().forEach((t) => t.stop())
      if (video) video.srcObject = null
    }
    // `attempt` re-runs the whole startup for the Retry button.
  }, [attempt])

  if (status === 'error') {
    return (
      <div className="scanner-view scanner-error">
        <FontAwesomeIcon icon={faCamera} style={{ fontSize: 32, color: 'var(--muted)', marginBottom: 10 }} />
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Camera unavailable</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>{errMsg}</div>
        <button className="btn" onClick={() => { setErrMsg(''); setStatus('starting'); setAttempt((a) => a + 1); }}>
          <FontAwesomeIcon icon={faRotateRight} style={{ fontSize: 12 }} /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="scanner-view">
      <video ref={videoRef} className="scanner-video" playsInline muted autoPlay />
      <div className="scanner-frame" aria-hidden="true">
        <div className="scanner-box">
          <span className="scan-corner tl" />
          <span className="scan-corner tr" />
          <span className="scan-corner bl" />
          <span className="scan-corner br" />
          {status === 'scanning' && <span className="scanner-laser" />}
        </div>
      </div>
      <div className="scanner-hint">
        {status === 'starting' ? 'Starting camera…' : 'Point your camera at the QR code'}
      </div>
    </div>
  )
}
export default function AddAccount({ onClose, onCreated, defaultGroup = '' }) {
  const [tab, setTab] = useState('qr')
  const [drag, setDrag] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const fileRef = useRef()
  const busyRef = useRef(false)

  const [form, setForm] = useState({
    label: '',
    issuer: '',
    secret: '',
    type: 'totp',
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
    counter: 0,
    group: defaultGroup || '',
    logo: '',
  })
  const [uri, setUri] = useState('')

  // Icon picker popup modal
  const [showIconPicker, setShowIconPicker] = useState(false)

  // Custom Groups state
  const [customGroups, setCustomGroups] = useState([])
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false)

  useEffect(() => {
    setCustomGroups(getCustomGroups())
  }, [])

  function update(k, v) {
    setForm((f) => {
      const next = { ...f, [k]: v }
      if (k === 'issuer' && (!f.logo || getBrand(f.logo))) {
        const auto = detectService(v)
        if (auto) next.logo = auto
      }
      return next
    })
  }

  // Load an image file into an <img> without blocking the main thread
  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        URL.revokeObjectURL(url)
        resolve(img)
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        // Some formats pass the `image/*` MIME check but cannot actually be
        // decoded by the browser (HEIC/HEIF from iPhones, some AVIF/JXL).
        // Say so instead of the opaque "failed to load".
        const type = String(file?.type || '').toLowerCase()
        if (type.includes('heic') || type.includes('heif')) {
          reject(new Error(
            'Your browser cannot read HEIC/HEIF images. Re-save or screenshot it as a PNG or JPEG and try again.'
          ))
          return
        }
        reject(new Error(
          'Could not read that image. Please use a PNG, JPEG, or WebP file.'
        ))
      }
      img.src = url
    })
  }

  // Decode one canvas-sized pass, returns the QR payload or null
  function decodePass(img, sx, sy, sw, sh, dw, dh) {
    const canvas = document.createElement('canvas')
    canvas.width = dw
    canvas.height = dh
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    // White background: screenshots with transparency decode better on white
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, dw, dh)
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh)
    const imageData = ctx.getImageData(0, 0, dw, dh)
    const code = jsQR(imageData.data, dw, dh, QR_DECODE_OPTS)
    return code && code.data ? code.data : null
  }

  // Screenshot-robust QR reader for PNG, JPEG, WebP.
  // Phone screenshots are huge with a (sometimes small) QR inside, so a
  // single full-res decode often fails. We retry at several downscaled
  // sizes plus a center crop, with light/dark inversion attempts each time.
  async function decodeQrClientSide(file) {
    const img = await loadImageElement(file)
    const W = img.naturalWidth || img.width
    const H = img.naturalHeight || img.height
    if (!W || !H) {
      throw new Error('Could not read that image. Please use a PNG, JPEG, or WebP file.')
    }
    if (W * H > MAX_QR_IMAGE_PIXELS) {
      throw new Error('That image is too large to scan. Please use a smaller screenshot.')
    }

    const fit = (maxDim) => {
      const scale = Math.min(1, maxDim / Math.max(W, H))
      return { w: Math.max(1, Math.round(W * scale)), h: Math.max(1, Math.round(H * scale)) }
    }

    const passes = []
    const seen = new Set()
    const pushFit = (maxDim) => {
      const { w, h } = fit(maxDim)
      const key = `${w}x${h}`
      if (seen.has(key)) return
      seen.add(key)
      passes.push({ sx: 0, sy: 0, sw: W, sh: H, dw: w, dh: h })
    }
    // Full frame at descending sizes (big screenshots → small QR)
    pushFit(1400)
    pushFit(900)
    pushFit(480)
    // Center crop (QR small in a busy full-screen screenshot)
    if (Math.min(W, H) > 480) {
      const cw = Math.round(W * 0.62)
      const ch = Math.round(H * 0.62)
      const cx = Math.round((W - cw) / 2)
      const cy = Math.round((H - ch) / 2)
      const scale = Math.min(1, 900 / Math.max(cw, ch))
      passes.push({
        sx: cx, sy: cy, sw: cw, sh: ch,
        dw: Math.max(1, Math.round(cw * scale)),
        dh: Math.max(1, Math.round(ch * scale)),
      })
    }

    for (const p of passes) {
      try {
        const data = decodePass(img, p.sx, p.sy, p.sw, p.sh, p.dw, p.dh)
        if (data) return data
      } catch {
        // try next pass
      }
    }
    throw new Error('No QR code detected in image')
  }

  // Downscaled PNG data URL for the server fallback (server caps at 2 MB
  // and only accepts PNG/JPEG — a resized flat screenshot is tiny).
  function imageToSmallPng(img, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/png')
  }

  async function readFile(file) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErr('Please choose an image file (PNG, JPG, WebP)')
      return
    }
    if (file.size > MAX_QR_IMAGE_BYTES) {
      setErr('That image is too large. Please pick one under 20 MB.')
      return
    }
    if (busyRef.current) return
    busyRef.current = true
    setErr('')
    setLoading(true)

    try {
      let qrContent
      try {
        qrContent = await decodeQrClientSide(file)
      } catch (clientErr) {
        // Server fallback: send a downscaled PNG (original screenshots are
        // often >2 MB or WebP, both of which the server rejects).
        try {
          const img = await loadImageElement(file)
          let dataUri = imageToSmallPng(img, 1200)
          if (dataUri.length > 1.8 * 1024 * 1024) {
            dataUri = imageToSmallPng(img, 800)
          }
          const res = await api.parseQr(dataUri)
          qrContent = res.data
        } catch (e) {
          // Prefer the server's message when it has one — it runs a different
          // decoder, so its failure is usually the more specific explanation.
          // `clientErr || e` always resolved to clientErr and discarded this.
          throw (e && e.message) ? e : clientErr
        }
      }

      if (typeof qrContent === 'string') {
        const res = await api.parseUri(qrContent)
        applyParsedData(res.data)
      } else if (qrContent && typeof qrContent === 'object') {
        applyParsedData(qrContent)
      }
    } catch (e) {
      setErr(e.message || 'Could not scan QR code. Please try pasting the URI or manual entry.')
    } finally {
      busyRef.current = false
      setLoading(false)
      // Clear the input so picking the same file again re-triggers onChange
      // instead of silently doing nothing.
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function applyParsedData(data) {
    const autoLogo = detectService(data.issuer || data.label) || ''
    setForm((f) => ({
      ...f,
      label: data.label || f.label,
      issuer: data.issuer || f.issuer,
      secret: data.secret || '',
      type: data.type === 'hotp' ? 'hotp' : 'totp',
      digits: data.digits || 6,
      period: data.period || 30,
      algorithm: data.algorithm || 'SHA1',
      counter: data.counter || 0,
      // Keep a custom (uploaded / URL) icon the user already picked.
      logo: autoLogo || (f.logo && !getBrand(f.logo) ? f.logo : ''),
    }))
    setErr('')
    setTab('manual')
  }

  async function parseUriNow() {
    if (!uri.trim() || busyRef.current) return
    busyRef.current = true
    setErr('')
    try {
      setLoading(true)
      const res = await api.parseUri(uri.trim())
      applyParsedData(res.data)
    } catch (e) {
      setErr(e.message)
    } finally {
      busyRef.current = false
      setLoading(false)
    }
  }

  // Called once per camera scan with the raw QR payload. On success the
  // form is filled and we jump to Manual Entry (which unmounts the camera).
  // On failure we remount the scanner so the user can try again.
  const [scanKey, setScanKey] = useState(0)
  async function handleScannedData(data) {
    busyRef.current = true
    setErr('')
    setLoading(true)
    try {
      const res = await api.parseUri(String(data).trim())
      applyParsedData(res.data)
    } catch (e) {
      setErr(
        (e.message || 'That QR code is not a valid 2FA code.') +
        ' Point at the 2FA setup QR and hold still.'
      )
      setScanKey((k) => k + 1) // remount scanner for another attempt
    } finally {
      busyRef.current = false
      setLoading(false)
    }
  }

  async function submit(e) {
    if (e) e.preventDefault()
    setErr('')
    if (!form.label.trim()) {
      setErr('Label is required')
      return
    }
    const secret = normalizeSecret(form.secret)
    const secretErr = validateSecret(secret)
    if (secretErr) {
      setErr(secretErr)
      return
    }
    if (busyRef.current) return
    busyRef.current = true

    try {
      setLoading(true)
      const payload = {
        ...form,
        secret,
        label: form.label.trim(),
        issuer: form.issuer.trim(),
        group_name: form.group,
      }
      if (form.type === 'totp') delete payload.counter

      const res = await api.createAccount(payload)
      const createdAcc = res.account

      setAccountMeta(createdAcc.id, {
        group: form.group,
        logo: form.logo,
      })

      onCreated({
        ...createdAcc,
        group: form.group,
        logo: form.logo,
      })
    } catch (e) {
      setErr(e.message)
    } finally {
      busyRef.current = false
      setLoading(false)
    }
  }

  return (
    <>
      <Modal
        onClose={onClose}
        dismissible={!loading}
        ariaLabel="Add 2FA account"
        style={{ maxWidth: 520 }}
        backdropStyle={{ zIndex: 1000 }}
      >
          <h2>Add 2FA Account</h2>
          <div className="tabs" role="tablist" aria-label="Add account method">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'qr'}
              className={`tab ${tab === 'qr' ? 'active' : ''}`}
              onClick={() => setTab('qr')}
            >
              Upload QR Image
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'scan'}
              className={`tab ${tab === 'scan' ? 'active' : ''}`}
              onClick={() => setTab('scan')}
            >
              <FontAwesomeIcon icon={faCamera} style={{ fontSize: 12, marginRight: 4 }} />
              Scan Camera
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'uri'}
              className={`tab ${tab === 'uri' ? 'active' : ''}`}
              onClick={() => setTab('uri')}
            >
              Paste URI
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'manual'}
              className={`tab ${tab === 'manual' ? 'active' : ''}`}
              onClick={() => setTab('manual')}
            >
              Manual Entry
            </button>
          </div>

          {/* QR Upload Tab */}
          {tab === 'qr' && (
            <div
              className={`dropzone ${drag ? 'drag' : ''}`}
              role="button"
              tabIndex={0}
              aria-label="Choose a QR code image"
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  fileRef.current?.click()
                }
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDrag(true)
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDrag(false)
                readFile(e.dataTransfer.files?.[0])
              }}
            >
              <div style={{ marginBottom: 8 }}>
                <FontAwesomeIcon icon={faQrcode} style={{ fontSize: 36, color: 'var(--muted)' }} />
              </div>
              <div style={{ fontWeight: 500, color: 'var(--text)', marginBottom: 4 }}>
                {loading ? 'Scanning QR code…' : 'Drop a QR screenshot here or click to browse'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                Auto-detects QR codes in full-screen screenshots · PNG, JPEG, WebP
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => readFile(e.target.files?.[0])}
              />
            </div>
          )}

          {/* Live Camera Scan Tab (unmount = camera off) */}
          {tab === 'scan' && (
            <div>
              <CameraScanner key={scanKey} onDetected={handleScannedData} />
              <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginTop: 10 }}>
                No camera?{' '}
                <button type="button" className="btn-link" onClick={() => setTab('qr')}>
                  Upload a screenshot instead
                </button>
              </div>
            </div>
          )}

          {/* URI Tab */}
          {tab === 'uri' && (
            <div className="field">
              <label className="label">otpauth:// URI</label>
              <textarea
                className="textarea"
                rows={3}
                placeholder="otpauth://totp/GitHub:KamillyAgent?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary"
                style={{ marginTop: 10 }}
                onClick={parseUriNow}
                disabled={loading || !uri.trim()}
              >
                {loading ? 'Parsing…' : 'Parse URI'}
              </button>
            </div>
          )}

          {/* Manual Entry Tab */}
          {tab === 'manual' && (
            <form onSubmit={submit}>
              {/* Account Icon Trigger via Popup Modal */}
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
                    <ServiceLogo
                      logo={form.logo}
                      issuer={form.issuer}
                      label={form.label}
                      size={40}
                    />
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>
                        {form.logo && getBrand(form.logo)
                          ? getBrand(form.logo).name
                          : form.logo
                          ? 'Custom Logo'
                          : 'Auto / Initials'}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                        Click to choose from 70+ logos or upload
                      </div>
                    </div>
                  </div>
                  <button type="button" className="btn btn-sm">
                    Choose Icon
                  </button>
                </div>
              </div>

              <div className="row">
                <div className="field">
                  <label className="label">Label / Name *</label>
                  <input
                    className="input"
                    value={form.label}
                    onChange={(e) => update('label', e.target.value)}
                    placeholder="e.g. KamillyAgent or user@gmail.com"
                    required
                  />
                </div>
                <div className="field">
                  <label className="label">Issuer (Service)</label>
                  <input
                    className="input"
                    value={form.issuer}
                    onChange={(e) => update('issuer', e.target.value)}
                    placeholder="e.g. GitHub, Google, AWS"
                  />
                </div>
              </div>

              <div className="field">
                <label className="label">Secret (Base32) *</label>
                <input
                  className="input"
                  value={form.secret}
                  onChange={(e) => update('secret', e.target.value)}
                  placeholder="JBSWY3DPEHPK3PXP"
                  required
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  style={{ fontFamily: 'monospace' }}
                />
              </div>

              {/* Group Assignment */}
              <div className="field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label className="label" style={{ margin: 0 }}>Assign to Group</label>
                  <button
                    type="button"
                    className="btn-link"
                    style={{ fontSize: 12 }}
                    onClick={() => setShowCreateGroupModal(true)}
                  >
                    <FontAwesomeIcon icon={faPlus} style={{ fontSize: 11 }} /> Create New Group
                  </button>
                </div>
                <Select
                  value={form.group}
                  onChange={(v) => update('group', v)}
                  ariaLabel="Assign to Group"
                  options={[
                    { value: '', label: '(No Group / Ungrouped)' },
                    ...customGroups.map((g) => ({ value: g.name, label: g.name })),
                  ]}
                />
              </div>

              {/* ── All Types & All Algorithms ──────────────────────── */}
              <div className="row">
                <div className="field">
                  <label className="label">Type</label>
                  <Select
                    value={form.type}
                    onChange={(v) => update('type', v)}
                    ariaLabel="Type"
                    options={[
                      { value: 'totp', label: 'TOTP (Time-based, RFC 6238)' },
                      { value: 'hotp', label: 'HOTP (Counter-based, RFC 4226)' },
                    ]}
                  />
                </div>
                <div className="field">
                  <label className="label">Digits</label>
                  <Select
                    value={form.digits}
                    onChange={(v) => update('digits', Number(v))}
                    ariaLabel="Digits"
                    options={[
                      { value: 6, label: '6 Digits (Standard)' },
                      { value: 7, label: '7 Digits' },
                      { value: 8, label: '8 Digits' },
                    ]}
                  />
                </div>
              </div>

              {form.type === 'totp' ? (
                <div className="row">
                  <div className="field">
                    <label className="label">Period (Seconds)</label>
                    <Select
                      value={form.period}
                      onChange={(v) => update('period', Number(v))}
                      ariaLabel="Period (Seconds)"
                      options={[
                        { value: 15, label: '15 Seconds' },
                        { value: 30, label: '30 Seconds (Default)' },
                        { value: 45, label: '45 Seconds' },
                        { value: 60, label: '60 Seconds' },
                      ]}
                    />
                  </div>
                  <div className="field">
                    <label className="label">Algorithm</label>
                    <Select
                      value={form.algorithm}
                      onChange={(v) => update('algorithm', v)}
                      ariaLabel="Algorithm"
                      options={[
                        { value: 'SHA1', label: 'SHA1 (Default / Most Common)' },
                        { value: 'SHA256', label: 'SHA256 (HMAC-SHA-256)' },
                        { value: 'SHA512', label: 'SHA512 (HMAC-SHA-512)' },
                      ]}
                    />
                  </div>
                </div>
              ) : (
                <div className="row">
                  <div className="field">
                    <label className="label">Initial Counter Value</label>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      value={form.counter}
                      onChange={(e) =>
                      update('counter', Math.max(0, Math.floor(Number(e.target.value)) || 0))
                    }
                    />
                  </div>
                  <div className="field">
                    <label className="label">Algorithm</label>
                    <Select
                      value={form.algorithm}
                      onChange={(v) => update('algorithm', v)}
                      ariaLabel="Algorithm"
                      options={[
                        { value: 'SHA1', label: 'SHA1 (Default)' },
                        { value: 'SHA256', label: 'SHA256' },
                        { value: 'SHA512', label: 'SHA512' },
                      ]}
                    />
                  </div>
                </div>
              )}
            </form>
          )}

          {err && <div className="error" role="alert" style={{ marginTop: 12 }}>{err}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            {tab === 'manual' && (
              <button type="button" className="btn btn-primary" onClick={submit} disabled={loading}>
                {loading ? 'Saving…' : 'Save Account'}
              </button>
            )}
          </div>
      </Modal>

      {/* Icon Picker Popup Modal */}
      <IconPickerModal
        isOpen={showIconPicker}
        currentLogo={form.logo}
        issuer={form.issuer}
        label={form.label}
        onSelect={(newLogo) => update('logo', newLogo)}
        onClose={() => setShowIconPicker(false)}
      />

      {/* Inline Create Group Modal */}
      {showCreateGroupModal && (
        <GroupModal
          isOpen={showCreateGroupModal}
          onSave={(newName, newLogo) => {
            const created = createCustomGroup(newName, newLogo)
            setCustomGroups(getCustomGroups())
            update('group', created.name)
            setShowCreateGroupModal(false)
          }}
          onClose={() => setShowCreateGroupModal(false)}
        />
      )}
    </>
  )
}
