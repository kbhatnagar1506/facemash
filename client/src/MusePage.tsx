import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { fetchMe, type Me } from './account'
import { SignInSheet } from './landing/SignIn'
import { BEAN_STEP, MUSE_STEP } from './onboarding'
import { VoiceCard } from './VoiceCard'
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

type Claimed = { prompt: string; connector_url: string; memory_prompt?: string }

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

function savedClaim(code: string): Claimed | null {
  try {
    const s = sessionStorage.getItem('gt.muse.' + code.slice(-12))
    return s ? (JSON.parse(s) as Claimed) : null
  } catch {
    return null
  }
}

/** Opened from your QR: redeem the code on a tap (never on load: QR scanners and link
 *  previews open pages before you do, and would spend the code), then one line for Muse. */
function Scanned({ code }: { code: string }) {
  const [got, setGot] = useState<Claimed | null>(() => savedClaim(code))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const redeem = () => {
    setBusy(true)
    claim(code).then(
      (c) => {
        setGot(c)
        // the code is spent; keep it out of the address bar (and screenshots of it)
        history.replaceState(null, '', location.pathname)
      },
      (e: Error) => {
        setError(e.message)
        setBusy(false)
      },
    )
  }
  return (
    <Shell>
      <section className="muse-card">
        <h1>Connect your Muse</h1>
        {error ? (
          <p className="muse-error" role="alert">
            {error}
          </p>
        ) : !got ? (
          <>
            <p className="muse-sub">Tap to link your Muse to your HackGT 13 account. You'll get one line to paste into Muse.</p>
            <button className="btn btn-primary muse-wide" type="button" onClick={redeem} disabled={busy}>
              {busy ? 'Linking…' : 'Get my Muse link'}
            </button>
          </>
        ) : (
          <>
            <p className="muse-sub">Copy this, open Muse, paste it and send. Muse links to your account and sends what it remembers about you, never anything about other people.</p>
            <pre className="muse-prompt">{got.prompt}</pre>
            <div className="muse-actions">
              <CopyButton text={got.prompt} />
              <a className="btn btn-secondary muse-wide" href={MUSE_URL} target="_blank" rel="noopener noreferrer">
                Open Muse
              </a>
            </div>
            <p className="muse-fine">The link inside is your personal key: keep it to yourself. You can disconnect it any time in the app.</p>
            {got.memory_prompt && (
              <div className="muse-optional">
                <strong>Optional: send what Muse remembers about you</strong>
                <p>It helps HackGT 13 find people you'd want to meet. Muse sends only its notes about you, never about other people. You can see what's stored, and delete it, in the app.</p>
                <CopyButton text={got.memory_prompt} primary={false} />
              </div>
            )}
          </>
        )}
      </section>
    </Shell>
  )
}

type Question = {
  asked_at: string | null
  status?: string
  calls?: number
  what?: string[]
  ask_to_first_call_ms?: number
  ask_to_last_response_ms?: number
  fetch_span_ms?: number
  server_ms?: number
  first_call_at?: string
}

const secs = (ms?: number) => (ms == null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)

/** Latency test: tap as you ask your agent something; see how fast it came to us and got its answer. */
type MemInfo = { stored: boolean; kb?: number; received_at?: string; sections?: string[] }

/** What your agent sent about you (described, never shown), and a way to delete it. */
function Memory() {
  const [m, setM] = useState<MemInfo | null>(null)
  const load = () =>
    fetch('/api/muse/memory', { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<MemInfo>) : null))
      .then(setM)
      .catch(() => {})
  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])
  if (!m?.stored) return null
  return (
    <p className="muse-fine">
      Your memory here: {m.kb} KB ({(m.sections ?? []).join(', ')}), received{' '}
      {new Date(m.received_at!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.{' '}
      <button className="muse-link" type="button" onClick={() => fetch('/api/muse/memory', { method: 'DELETE', credentials: 'same-origin' }).then(load)}>
        Delete it
      </button>
    </p>
  )
}

function Latency() {
  const [qs, setQs] = useState<Question[]>([])
  useEffect(() => {
    const load = () =>
      fetch('/api/muse/latency', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setQs(d.questions ?? []))
        .catch(() => {})
    load()
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [])
  const ask = () => fetch('/api/muse/ask', { method: 'POST', credentials: 'same-origin' }).then(() => setQs((q) => [{ asked_at: new Date().toISOString(), status: 'waiting for the agent' }, ...q]))
  return (
    <div className="lat">
      <div className="lat-head">
        <strong>Latency test</strong>
        <button className="btn btn-secondary btn-sm" type="button" onClick={ask}>
          I'm asking Muse now
        </button>
      </div>
      {qs.length === 0 ? (
        <p className="lat-empty">Tap the button as you send Muse a question. Each question shows up here with its timings.</p>
      ) : (
        <ol className="lat-list">
          {qs.slice(0, 6).map((q, i) => (
            <li key={(q.asked_at ?? q.first_call_at ?? '') + i}>
              <span className="lat-time">{new Date(q.asked_at ?? q.first_call_at ?? Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
              {q.calls == null ? (
                <span className="lat-wait">{q.status}</span>
              ) : (
                <span className="lat-nums">
                  {q.asked_at && (
                    <>
                      <b>{secs(q.ask_to_first_call_ms)}</b> until Muse called · <b>{secs(q.ask_to_last_response_ms)}</b> until it had the answer ·{' '}
                    </>
                  )}
                  {q.calls} call{q.calls === 1 ? '' : 's'} · {secs(q.server_ms)} on our server
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
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
// the latency test is a tool for us, not for attendees: /muse?debug
const DEBUG = new URLSearchParams(location.search).has('debug')

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

/** No Muse: the way to the voice guide instead. */
function VoiceLink({ onVoice }: { onVoice?: () => void }) {
  if (!onVoice) return null
  return (
    <button className="btn btn-secondary muse-wide vc-alt" type="button" onClick={onVoice}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      No Muse? Talk for two minutes instead
    </button>
  )
}

/** Signed in: your personal QR, and whether your agent is connected. */
function Pairing({ onVoice }: { onVoice?: () => void }) {
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
          <VoiceLink onVoice={onVoice} />
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
        <Memory />
        {DEBUG && <Latency />}
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
        {DEBUG && <Latency />}
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
      <div className="muse-actions">
        {pair && !expired && (
          <a className="btn btn-secondary muse-wide" href={'/muse#' + pair.code}>
            Muse is on this device
          </a>
        )}
        <VoiceLink onVoice={onVoice} />
      </div>
      <p className="muse-waiting">{pair && !expired ? 'Waiting for your Muse…' : ''}</p>
      <Onward connected={false} />
      <Memory />
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
        {me.googleClientId && <SignInSheet
            clientId={me.googleClientId}
            next={onboarding() ? MUSE_STEP : '/muse'}
            onClose={() => (location.href = '/')}
            title="Connect your Muse"
            sub="Sign in with Google first, so your Muse links to your account."
          />}
      </Shell>
    )
  return <SignedIn me={me} />
}

// ?voice opens the voice guide straight away (e.g. from a poster or a link)
function SignedIn({ me }: { me: Me }) {
  const [voice, setVoice] = useState(() => !!me.voice && new URLSearchParams(location.search).has('voice'))
  return <Shell>{voice ? <VoiceCard step={onboarding()} onBack={() => setVoice(false)} /> : <Pairing onVoice={me.voice ? () => setVoice(true) : undefined} />}</Shell>
}
