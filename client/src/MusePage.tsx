import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { fetchMe, type Me } from './account'
import { SignInSheet } from './landing/SignIn'
import { BEAN_STEP, MUSE_STEP } from './onboarding'
import './landing.css'

// Connect your own AI agent (Meta's Muse) to your HackGT 13 account.
//  - Signed in: a personal, one-time pairing code (10 minutes) as a QR to scan with your
//    phone, or a copy button if Muse is on this device. Your agent trades the code for a
//    real token; this page notices and says you're connected.
//  - Opened from the QR (the code is in the #fragment, so it never reaches a server log):
//    this page redeems the code itself, right away in the phone's own browser, and hands
//    over one line for Muse: a connector URL with the key inside. Muse only registers a
//    URL; it never has to browse, POST or sign in (its browser agent is slow).

const MUSE_URL = 'https://muse.ai'
const PAIR = /^#?(gtqp_[A-Za-z0-9_-]{16,})$/

type Claimed = { prompt: string; connector_url: string }

// redeem each code once, even if the page mounts twice; a reload shows the same result
const claims = new Map<string, Promise<Claimed>>()
function claim(code: string): Promise<Claimed> {
  const key = 'gt.muse.' + code.slice(-12)
  try {
    const saved = sessionStorage.getItem(key)
    if (saved) return Promise.resolve(JSON.parse(saved) as Claimed)
  } catch {
    /* private mode */
  }
  if (!claims.has(code))
    claims.set(
      code,
      fetch('/api/muse/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error ?? 'Could not connect. Make a new code in the app.')
        try {
          sessionStorage.setItem(key, JSON.stringify(body))
        } catch {
          /* fine */
        }
        return body as Claimed
      }),
    )
  return claims.get(code)!
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // older iOS / no permission: fall back to a hidden textarea
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

function CopyButton({ text, primary = true }: { text: string; primary?: boolean }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 2200)
    return () => clearTimeout(t)
  }, [done])
  return (
    <button className={primary ? 'btn btn-primary muse-wide' : 'btn btn-secondary muse-wide'} type="button" onClick={() => copy(text).then(setDone)}>
      {done ? 'Copied. Paste it into Muse' : 'Copy for Muse'}
    </button>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const prev = document.title
    document.title = 'Connect your Muse · HackGT 13'
    return () => {
      document.title = prev
    }
  }, [])
  return (
    <div className="landing muse-page">
      <header className="muse-nav">
        <a className="brand" href="/">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect x="7" y="2" width="18" height="28" rx="9" fill="#3B63C4" />
            <rect x="11.5" y="7.5" width="12" height="8" rx="4" fill="#fff" />
            <circle cx="15.5" cy="11.5" r="1.25" fill="#1B1D24" />
            <circle cx="19.5" cy="11.5" r="1.25" fill="#1B1D24" />
          </svg>
          HackGT 13
        </a>
      </header>
      <main className="muse-main">{children}</main>
    </div>
  )
}

/** Opened from your QR: redeem the code here, then one line for Muse. */
function Scanned({ code }: { code: string }) {
  const [got, setGot] = useState<Claimed | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    claim(code).then(setGot, (e: Error) => setError(e.message))
    // the code is spent; keep it out of the address bar (and screenshots of it)
    history.replaceState(null, '', location.pathname)
  }, [code])
  return (
    <Shell>
      <section className="muse-card">
        <h1>Connect your Muse</h1>
        {error ? (
          <p className="muse-error" role="alert">
            {error}
          </p>
        ) : !got ? (
          <p className="muse-sub">Linking to your account…</p>
        ) : (
          <>
            <p className="muse-sub">Copy this, open Muse, paste it and send. That's all Muse needs.</p>
            <pre className="muse-prompt">{got.prompt}</pre>
            <div className="muse-actions">
              <CopyButton text={got.prompt} />
              <a className="btn btn-secondary muse-wide" href={MUSE_URL} target="_blank" rel="noopener noreferrer">
                Open Muse
              </a>
            </div>
            <p className="muse-fine">The link inside is your personal key: keep it to yourself. You can disconnect it any time in the app.</p>
          </>
        )}
      </section>
    </Shell>
  )
}

type Pair = { code: string; url: string; prompt: string; expires: string }
type Status = { connected: boolean; since?: string; last_used?: string | null; pairing?: boolean }

async function post<T>(path: string): Promise<T> {
  const r = await fetch(path, { method: 'POST', credentials: 'same-origin' })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Something went wrong')
  return r.status === 204 ? (undefined as T) : ((await r.json()) as T)
}

const onboarding = () => new URLSearchParams(location.search).has('onboard')

/** Onboarding: which step this is, and the way on to the next one. */
function Step() {
  return onboarding() ? <p className="muse-step">Step 2 of 3</p> : null
}
function Onward({ connected }: { connected: boolean }) {
  if (!onboarding()) return null
  return connected ? (
    <a className="btn btn-primary muse-wide" href={BEAN_STEP}>
      Next: make your bean
    </a>
  ) : (
    <a className="muse-link" href={BEAN_STEP}>
      Skip for now
    </a>
  )
}

/** Signed in: your personal QR, and whether your agent is connected. */
function Pairing() {
  const [pair, setPair] = useState<Pair | null>(null)
  const [qr, setQr] = useState('')
  const [left, setLeft] = useState(0)
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const madeAt = useRef(0)

  const make = useCallback(() => {
    setError('')
    post<Pair>('/api/muse/pair').then(
      (p) => {
        madeAt.current = Date.now()
        // set the clock with the code, so the first frame doesn't read as expired
        setLeft(Math.max(1, Math.round((new Date(p.expires).getTime() - Date.now()) / 1000)))
        setPair(p)
      },
      (e: Error) => setError(e.message),
    )
  }, [])

  // status first: already connected people see that, not a fresh code
  useEffect(() => {
    fetch('/api/muse/status', { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : { connected: false }))
      .then((s) => {
        setStatus(s)
        if (!s.connected) make()
      })
      .catch(() => make())
  }, [make])

  useEffect(() => {
    if (!pair) return
    QRCode.toDataURL(pair.url, { errorCorrectionLevel: 'M', margin: 1, width: 560, color: { dark: '#1b1d24', light: '#ffffff' } }).then(setQr)
    const tick = () => setLeft(Math.max(0, Math.round((new Date(pair.expires).getTime() - Date.now()) / 1000)))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [pair])

  // while a code is out: first it gets scanned (redeemed), then Muse makes its first call
  const [scanned, setScanned] = useState(false)
  useEffect(() => {
    if (!pair || (left === 0 && !scanned)) return
    const t = setInterval(() => {
      fetch('/api/muse/status', { credentials: 'same-origin' })
        .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
        .then((s) => {
          if (!s?.connected || !s.since || new Date(s.since).getTime() < madeAt.current - 5000) return
          setScanned(true)
          if (s.last_used && new Date(s.last_used).getTime() >= new Date(s.since).getTime()) {
            setStatus(s)
            setPair(null)
          }
        })
        .catch(() => {})
    }, 2500)
    return () => clearInterval(t)
  }, [pair, left === 0, scanned]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error)
    return (
      <section className="muse-card">
        <h1>Connect your Muse</h1>
        <p className="muse-error" role="alert">
          {error}
        </p>
        <div className="muse-actions">
          <button className="btn btn-primary muse-wide" type="button" onClick={make}>
            Try again
          </button>
          <Onward connected={false} />
        </div>
      </section>
    )

  if (status?.connected && !pair)
    return (
      <section className="muse-card">
        <div className="muse-ok" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <Step />
        <h1>Your Muse is connected</h1>
        <p className="muse-sub">
          Ask it what's happening at HackGT, what's next, or what your profile says.
          {status.last_used && <> Last used {new Date(status.last_used).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</>}
        </p>
        <div className="muse-actions">
          <Onward connected />
          <a className={onboarding() ? 'btn btn-secondary muse-wide' : 'btn btn-primary muse-wide'} href={MUSE_URL} target="_blank" rel="noopener noreferrer">
            Open Muse
          </a>
          <button className="btn btn-secondary muse-wide" type="button" onClick={make}>
            Connect again
          </button>
          <button
            className="muse-link"
            type="button"
            onClick={() => post('/api/muse/revoke').then(() => setStatus({ connected: false }), (e: Error) => setError(e.message))}
          >
            Disconnect
          </button>
        </div>
      </section>
    )

  if (pair && scanned)
    return (
      <section className="muse-card">
        <Step />
        <div className="muse-ok" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1>Scanned</h1>
        <p className="muse-sub">Now paste it into Muse and send. This turns to connected as soon as Muse checks in.</p>
        <p className="muse-waiting">Waiting for your Muse…</p>
        <Onward connected={false} />
      </section>
    )

  const expired = pair && left === 0
  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  return (
    <section className="muse-card">
      <Step />
      <h1>Connect your Muse</h1>
      <p className="muse-sub">Scan with the phone that has Muse, then paste into Muse. On this device already? Copy it instead.</p>
      <div className={expired ? 'muse-qr expired' : 'muse-qr'} aria-live="polite">
        {qr ? <img src={qr} alt="Your personal pairing QR code" width={280} height={280} /> : <div className="muse-qr-ph" />}
        {expired && (
          <button className="btn btn-primary" type="button" onClick={make}>
            New code
          </button>
        )}
      </div>
      <p className="muse-timer">{!pair ? 'Making your code…' : expired ? 'This code expired.' : `Works once · expires in ${mm}`}</p>
      {pair && !expired && (
        <div className="muse-actions">
          <a className="btn btn-secondary muse-wide" href={'/muse#' + pair.code}>
            Muse is on this device
          </a>
        </div>
      )}
      <p className="muse-waiting">{pair && !expired ? 'Waiting for your Muse…' : ''}</p>
      <Onward connected={false} />
    </section>
  )
}

export function MusePage() {
  const scanned = PAIR.exec(location.hash)?.[1]
  const [me, setMe] = useState<Me | null>(null)
  useEffect(() => {
    if (!scanned) fetchMe().then(setMe)
  }, [scanned])

  if (scanned) return <Scanned code={scanned} />
  if (!me) return <Shell>{null}</Shell>
  if (!me.user)
    return (
      <Shell>
        <section className="muse-card">
          <h1>Connect your Muse</h1>
          {me.googleClientId ? (
            <p className="muse-sub">Sign in first, so your Muse links to your account.</p>
          ) : (
            <p className="muse-sub">Sign-in isn't switched on yet. Check back soon.</p>
          )}
        </section>
        {me.googleClientId && <SignInSheet clientId={me.googleClientId} next={onboarding() ? MUSE_STEP : '/muse'} onClose={() => (location.href = '/')} />}
      </Shell>
    )
  return (
    <Shell>
      <Pairing />
    </Shell>
  )
}
