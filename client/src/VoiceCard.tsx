import { useEffect, useRef, useState } from 'react'
import type { Conversation } from '@elevenlabs/client'
import { BEAN_STEP } from './onboarding'

// No Muse? Talk for a minute instead. A short call with our ElevenLabs voice guide, who
// asks five questions; what you say becomes your memory here, the same as a Muse upload.
//  - The key stays on our server: it hands this page a signed URL for one call.
//  - The SDK is loaded only once this card opens (it's most of the weight).
//  - When the call ends we ask the server to save it; it fetches the transcript itself and
//    keeps only your side of it. Then we show you what it heard.

type Phase = 'idle' | 'connecting' | 'listening' | 'speaking' | 'saving' | 'done' | 'error'
type Answer = { q: string; a: string }
type Start = { signed_url: string; session: string; first_name: string; questions: string[]; max_seconds: number }

// a phrase from each question that marks the guide asking it (server/voice.go has the same)
const MARKS = [
  ['building this weekend', 'what are you building'],
  ['stuck on', 'love help with'],
  ['really good at', 'help someone else'],
  ['niche', 'nobody else here'],
  ['dream person', 'meet this weekend'],
]
function whichQuestion(msg: string, cur: number) {
  const m = msg.toLowerCase().replace(/’/g, "'")
  for (let q = cur + 1; q < MARKS.length; q++) if (MARKS[q].some((k) => m.includes(k))) return q
  return -1
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function postJSON<T>(path: string, body?: unknown): Promise<{ status: number; data: T & { error?: string } }> {
  const r = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, data: await r.json().catch(() => ({}) as T & { error?: string }) }
}

/** The call's bean: breathes while it listens, bounces with the guide's voice. */
function Bean({ phase, level }: { phase: Phase; level: number }) {
  return (
    <div className={'vc-bean vc-' + phase} style={{ '--lvl': level.toFixed(3) } as React.CSSProperties} aria-hidden="true">
      <svg viewBox="0 0 32 32">
        <rect x="7" y="2" width="18" height="28" rx="9" fill="#3B63C4" />
        <rect x="11.5" y="7.5" width="12" height="8" rx="4" fill="#fff" />
        <circle cx="15.5" cy="11.5" r="1.25" fill="#1B1D24" />
        <circle cx="19.5" cy="11.5" r="1.25" fill="#1B1D24" />
      </svg>
    </div>
  )
}

export function VoiceCard({ step, onBack }: { step: boolean; onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [q, setQ] = useState(-1)
  const [error, setError] = useState('')
  const [answers, setAnswers] = useState<Answer[]>([])
  const [level, setLevel] = useState(0)
  const conv = useRef<Conversation | null>(null)
  const convId = useRef('')
  const qRef = useRef(-1)
  const finishing = useRef(false)

  // start fetching the SDK as soon as the card is open, so the tap is quick
  const sdk = useRef<Promise<typeof import('@elevenlabs/client')> | null>(null)
  useEffect(() => {
    sdk.current = import('@elevenlabs/client')
    sdk.current.catch(() => {})
    return () => {
      conv.current?.endSession().catch(() => {})
    }
  }, [])

  // the bean follows whoever is talking
  useEffect(() => {
    if (phase !== 'listening' && phase !== 'speaking') return
    let raf = 0
    const tick = () => {
      const c = conv.current
      if (c) setLevel(Math.min(1, phase === 'speaking' ? c.getOutputVolume() * 1.6 : c.getInputVolume() * 2))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase])

  const finish = async () => {
    if (finishing.current) return
    finishing.current = true
    conv.current = null
    setLevel(0)
    if (!convId.current) {
      setError("The call didn't connect. Try again?")
      setPhase('error')
      finishing.current = false
      return
    }
    setPhase('saving')
    // the guide may still be wrapping up for a few seconds: ask again while it does
    for (let i = 0; i < 8; i++) {
      try {
        const { status, data } = await postJSON<{ answers: Answer[] }>('/api/voice/finish', { conversation_id: convId.current })
        if (status === 200) {
          setAnswers(data.answers ?? [])
          setPhase('done')
          return
        }
        if (status !== 409 && status !== 503 && status !== 429) {
          setError(data.error ?? 'Something went wrong saving that.')
          break
        }
      } catch {
        /* offline for a moment: try again */
      }
      await sleep(2500)
    }
    setError((e) => e || "Couldn't save that call just now.")
    setPhase('error')
    finishing.current = false
  }

  const begin = async () => {
    setError('')
    setQ(-1)
    qRef.current = -1
    convId.current = ''
    finishing.current = false
    setPhase('connecting')
    try {
      // ask for the mic first, on this tap, so the prompt comes up right away
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
    } catch {
      setError('We need your microphone for this. Allow it in your browser settings, then try again.')
      setPhase('error')
      return
    }
    try {
      const [{ status, data }, lib] = await Promise.all([postJSON<Start>('/api/voice/start'), sdk.current ?? import('@elevenlabs/client')])
      if (status !== 200) throw new Error(data.error ?? 'The voice guide is busy. Try again in a minute.')
      convId.current = new URL(data.signed_url).searchParams.get('conversation_id') ?? ''
      conv.current = await lib.Conversation.startSession({
        signedUrl: data.signed_url,
        connectionType: 'websocket',
        dynamicVariables: { first_name: data.first_name || 'there', fm_session: data.session },
        onConnect: ({ conversationId }) => {
          if (conversationId) convId.current = conversationId
        },
        onModeChange: ({ mode }) => setPhase((p) => (p === 'saving' || p === 'done' || p === 'error' ? p : mode)),
        onMessage: (m) => {
          if (m.role !== 'agent' && m.source !== 'ai') return
          const n = whichQuestion(m.message, qRef.current)
          if (n >= 0) {
            qRef.current = n
            setQ(n)
          }
        },
        onDisconnect: () => void finish(),
        onError: (msg) => console.warn('voice:', msg),
      })
      if (!convId.current) convId.current = conv.current.getId()
      setPhase((p) => (p === 'connecting' ? 'speaking' : p))
    } catch (e) {
      conv.current = null
      setError(e instanceof Error && e.message ? e.message : "Couldn't reach the voice guide. Try again?")
      setPhase('error')
    }
  }

  const end = () => {
    const c = conv.current
    if (c) c.endSession().catch(() => void finish())
    else void finish()
  }

  const live = phase === 'connecting' || phase === 'listening' || phase === 'speaking'
  const status =
    phase === 'connecting' ? 'Connecting…' : phase === 'speaking' ? 'The guide is talking' : phase === 'listening' ? 'Listening, go ahead' : phase === 'saving' ? 'Saving what you said…' : ''

  if (phase === 'done')
    return (
      <section className="muse-card vc">
        {step && <p className="muse-step">Step 2 of 3</p>}
        <div className="muse-ok" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        {answers.length ? (
          <>
            <h1>Saved. Here's what we heard</h1>
            <ol className="vc-heard">
              {answers.map((a) => (
                <li key={a.q}>
                  <span>{a.q}</span>
                  <p>{a.a}</p>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <>
            <h1>We didn't catch any answers</h1>
            <p className="muse-sub">Nothing was saved. Want another go?</p>
          </>
        )}
        <div className="muse-actions">
          <a className="btn btn-primary muse-wide" href={BEAN_STEP}>
            Next: make your bean
          </a>
          {!answers.length && (
            <button className="btn btn-secondary muse-wide" type="button" onClick={begin}>
              Talk again
            </button>
          )}
        </div>
        <p className="muse-fine">This is now your memory here, like a Muse upload. You can delete it any time on this page.</p>
      </section>
    )

  return (
    <section className="muse-card vc">
      {step && <p className="muse-step">Step 2 of 3</p>}
      <h1>{live || phase === 'saving' ? 'Talking with the guide' : 'Talk for a minute'}</h1>
      {!live && phase !== 'saving' && (
        <p className="muse-sub">Our voice guide asks you five quick questions. What you say becomes your memory here, just like a Muse upload.</p>
      )}
      {(live || phase === 'saving') && (
        <p className="vc-count" aria-live="polite">
          {q >= 0 ? `Question ${q + 1} of 5` : 'Five questions'}
        </p>
      )}
      <div className="vc-stage">
        {live || phase === 'saving' ? (
          <Bean phase={phase} level={level} />
        ) : (
          <button className="vc-mic" type="button" onClick={begin} aria-label="Start talking">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
              <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <p className="vc-status" aria-live="polite">
        {status || (phase === 'error' ? '' : 'Tap to start. About two minutes.')}
      </p>
      {phase === 'error' && (
        <p className="muse-error" role="alert">
          {error}
        </p>
      )}
      <div className="muse-actions">
        {live && (
          <button className="btn btn-secondary muse-wide" type="button" onClick={end}>
            End call
          </button>
        )}
        {!live && phase !== 'saving' && (
          <button className="muse-link" type="button" onClick={onBack}>
            I have Muse after all
          </button>
        )}
      </div>
      <p className="muse-fine">
        ElevenLabs runs the call. We keep only the words you said, as text, never the audio. Delete it any time on this page.{' '}
        <a href="/privacy">Privacy</a>
      </p>
    </section>
  )
}
