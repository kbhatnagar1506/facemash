import { useEffect, useRef, useState } from 'react'
import { BEAN_STEP } from './onboarding'

// No Muse? Answer five questions out loud instead, hands-free after one tap.
//  - Each question plays in our voice guide's voice (made once on the server, the same clip
//    for everyone), then the phone listens and stops by itself when you've finished talking.
//  - Each answer goes to the server while the next question plays: it's written down there
//    (ElevenLabs speech to text) and saved into your memory at once, so stopping halfway
//    keeps what you said and there's nothing to wait for at the end.
//  - The recording is never kept, only the words.
// server/voice_ask.go has the other side; QUESTIONS must match its voiceQuestions.

const QUESTIONS = [
  "What are you building this weekend, and what's the part you're most excited about?",
  "What's the one thing you're stuck on right now, the bug or problem you'd love help with?",
  "What's something you're really good at that you could help someone else with here?",
  "What's a niche thing you're into that almost nobody else here shares?",
  'Who would be your dream person to meet this weekend, and why?',
]

// listening: when to stop by itself
const WAIT_FOR_SPEECH_MS = 9000 // nothing said by then: move on
const END_SILENCE_MS = 1600 // quiet this long after speaking: done
const MAX_ANSWER_MS = 60000
const SPEECH_MS = 200 // this much sound counts as speaking (not a cough)

type Phase = 'idle' | 'starting' | 'asking' | 'listening' | 'finishing' | 'done' | 'error'
// per question: not asked yet, being written down, what we heard, or skipped/failed
type Heard = { state: 'todo' | 'sending' | 'ok' | 'skipped' | 'failed'; text: string }

const blank = (): Heard[] => QUESTIONS.map(() => ({ state: 'todo', text: '' }))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported(m)) return m
  return ''
}

/** The guide's bean: bounces while a question plays, breathes and follows your voice while it listens. */
function Bean({ phase, beanRef }: { phase: Phase; beanRef: React.RefObject<HTMLDivElement | null> }) {
  const cls = phase === 'asking' ? 'vc-speaking' : phase === 'listening' ? 'vc-listening' : phase === 'finishing' ? 'vc-saving' : 'vc-connecting'
  return (
    <div ref={beanRef} className={'vc-bean ' + cls} aria-hidden="true">
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
  const [error, setError] = useState('')
  const [q, setQ] = useState(-1)
  const [heard, setHeard] = useState<Heard[]>(blank)

  const beanRef = useRef<HTMLDivElement | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const actx = useRef<AudioContext | null>(null)
  const stopped = useRef(false) // the whole run was stopped
  const skipNow = useRef<(() => void) | null>(null) // ends the clip playing or the answer being recorded
  const uploads = useRef<Promise<void>[]>([])

  const mark = (i: number, h: Heard) => setHeard((all) => all.map((x, k) => (k === i ? h : x)))
  // the bean follows the sound level without re-rendering the card
  const setLevel = (v: number) => beanRef.current?.style.setProperty('--lvl', v.toFixed(3))

  const release = () => {
    skipNow.current?.()
    audio.current?.pause()
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    actx.current?.close().catch(() => {})
    actx.current = null
  }

  // leaving the page stops everything (answers already sent are already saved)
  useEffect(() => {
    const leave = () => {
      stopped.current = true
      release()
    }
    addEventListener('pagehide', leave)
    return () => {
      removeEventListener('pagehide', leave)
      leave()
    }
  }, [])

  const play = (src: string) =>
    new Promise<void>((resolve, reject) => {
      const a = audio.current!
      a.onended = () => resolve()
      a.onerror = () => reject(new Error("Couldn't play the question. Check your sound and try again?"))
      a.src = src
      a.play().catch(reject)
      skipNow.current = () => {
        a.pause()
        resolve()
      }
    })

  // record one answer; stops by itself on silence (or when nothing is said), or on skipNow
  const record = (mime: string) =>
    new Promise<{ blob: Blob; secs: number; spoke: boolean }>((resolve) => {
      const s = stream.current!
      const rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined)
      const parts: Blob[] = []
      rec.ondataavailable = (e) => {
        if (e.data.size) parts.push(e.data)
      }
      const an = actx.current!.createAnalyser()
      an.fftSize = 1024
      const src = actx.current!.createMediaStreamSource(s)
      src.connect(an)
      const buf = new Float32Array(an.fftSize)
      const t0 = performance.now()
      let floor = 0.01
      let loud = 0
      let spokeAt = 0
      let quietSince = 0
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearInterval(tick)
        src.disconnect()
        setLevel(0)
        const out = () => resolve({ blob: new Blob(parts, { type: rec.mimeType || mime }), secs: (performance.now() - t0) / 1000, spoke: spokeAt > 0 })
        if (rec.state === 'inactive') return out()
        rec.onstop = out
        rec.stop()
      }
      skipNow.current = finish
      const tick = window.setInterval(() => {
        an.getFloatTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += v * v
        const rms = Math.sqrt(sum / buf.length)
        const now = performance.now()
        const t = now - t0
        if (t < 350) floor = Math.max(floor, rms) // the room's own noise, before they start
        const thr = Math.max(0.02, floor * 2.5)
        setLevel(Math.min(1, rms * 8))
        if (rms > thr) {
          loud += 50
          quietSince = 0
          if (loud >= SPEECH_MS && !spokeAt) spokeAt = now
        } else {
          loud = Math.max(0, loud - 25)
          if (!quietSince) quietSince = now
        }
        if ((spokeAt && quietSince && now - quietSince > END_SILENCE_MS) || (!spokeAt && t > WAIT_FOR_SPEECH_MS) || t > MAX_ANSWER_MS) finish()
      }, 50)
      rec.start(250)
    })

  // send one answer; the server writes it down and saves it into their memory
  const send = async (i: number, run: string, blob: Blob, secs: number) => {
    mark(i, { state: 'sending', text: '' })
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`/api/voice/hear?q=${i}&run=${run}&secs=${Math.round(secs)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': blob.type || 'audio/webm' },
          body: blob,
        })
        const data = (await r.json().catch(() => ({}))) as { text?: string; error?: string }
        if (r.ok) return mark(i, data.text ? { state: 'ok', text: data.text } : { state: 'skipped', text: '' })
        if (![429, 502, 503].includes(r.status)) return mark(i, { state: 'failed', text: data.error ?? '' })
      } catch {
        /* offline for a moment: try again */
      }
      await sleep(1500 * (attempt + 1))
    }
    mark(i, { state: 'failed', text: "Couldn't save that one." })
  }

  const begin = async () => {
    setError('')
    setHeard(blank())
    setQ(-1)
    stopped.current = false
    uploads.current = []
    setPhase('starting')
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices) {
      setError("This browser can't record audio. Try Chrome or Safari, or connect Muse instead.")
      setPhase('error')
      return
    }
    const run = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, '0')).join('')
    // on this tap: unlock sound (one audio element plays every clip) and ask for the mic
    audio.current ??= new Audio()
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    actx.current = new Ctx()
    const intro = play('/api/voice/q/intro')
    intro.catch(() => {}) // awaited below
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      release()
      setError('We need your microphone for this. Allow it in your browser settings, then try again.')
      setPhase('error')
      return
    }
    const mime = pickMime()
    try {
      setPhase('asking')
      await intro
      for (let i = 0; i < QUESTIONS.length && !stopped.current; i++) {
        setQ(i)
        setPhase('asking')
        await play(`/api/voice/q/${i}`)
        if (stopped.current) break
        setPhase('listening')
        const { blob, secs, spoke } = await record(mime)
        if (!spoke || blob.size < 1000) {
          mark(i, { state: 'skipped', text: '' })
          continue
        }
        uploads.current.push(send(i, run, blob, secs)) // written down and saved while the next question plays
      }
    } catch (e) {
      release()
      setError(e instanceof Error && e.message ? e.message : 'Something went wrong. Try again?')
      setPhase('error')
      return
    }
    release()
    setPhase('finishing')
    await Promise.all(uploads.current)
    setPhase('done')
  }

  const stop = () => {
    stopped.current = true
    skipNow.current?.()
  }

  const live = phase === 'starting' || phase === 'asking' || phase === 'listening' || phase === 'finishing'
  const kept = heard.filter((h) => h.state === 'ok')
  const status =
    phase === 'starting'
      ? 'Getting ready…'
      : phase === 'asking'
        ? 'Listen to the question…'
        : phase === 'listening'
          ? 'Go ahead, it moves on when you stop'
          : phase === 'finishing'
            ? 'Saving your last answer…'
            : ''

  if (phase === 'done')
    return (
      <section className="muse-card vc">
        {step && <p className="muse-step">Step 2 of 3</p>}
        <div className="muse-ok" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        {kept.length ? (
          <>
            <h1>Saved. Here's what we heard</h1>
            <ol className="vc-heard">
              {heard.map((h, i) =>
                h.state === 'ok' ? (
                  <li key={i}>
                    <span>{QUESTIONS[i]}</span>
                    <p>{h.text}</p>
                  </li>
                ) : null,
              )}
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
          <button className="btn btn-secondary muse-wide" type="button" onClick={begin}>
            {kept.length ? 'Answer again' : 'Try again'}
          </button>
        </div>
        <p className="muse-fine">This is now your memory here, like a Muse upload. You can delete it any time on this page.</p>
      </section>
    )

  return (
    <section className="muse-card vc">
      {step && <p className="muse-step">Step 2 of 3</p>}
      <h1>{live ? (q >= 0 ? QUESTIONS[q] : 'Five quick questions') : 'Answer five questions out loud'}</h1>
      {!live && (
        <p className="muse-sub">Tap once and just talk: each question plays, and it moves on by itself when you finish. Every answer is saved as you go.</p>
      )}
      {live && (
        <p className="vc-count" aria-live="polite">
          {q >= 0 ? `Question ${q + 1} of 5` : 'Five questions'}
          {kept.length > 0 && ` · ${kept.length} saved`}
        </p>
      )}
      <div className="vc-stage">
        {live ? (
          <Bean phase={phase} beanRef={beanRef} />
        ) : (
          <button className="vc-mic" type="button" onClick={begin} aria-label="Start">
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
        {(phase === 'asking' || phase === 'listening') && (
          <button className="btn btn-secondary muse-wide" type="button" onClick={() => skipNow.current?.()}>
            {phase === 'listening' ? "I'm done, next" : 'Skip ahead'}
          </button>
        )}
        {live && phase !== 'finishing' && (
          <button className="muse-link" type="button" onClick={stop}>
            Stop here (keeps what you've said)
          </button>
        )}
        {!live && (
          <button className="muse-link" type="button" onClick={onBack}>
            I have Muse after all
          </button>
        )}
      </div>
      <p className="muse-fine">
        ElevenLabs writes down what you say. We keep only the words, as text, never the audio. Delete it any time on this page.{' '}
        <a href="/privacy">Privacy</a>
      </p>
    </section>
  )
}
