// The agent talk show, full screen: two beans face each other while their agents chat in
// speech bubbles (yours on the left, theirs on the right, no names), then a match prompt or
// a friendly goodbye, and the reveal once you both said yes. Lazy-loaded (see TalkLayer).

import { useEffect, useRef } from 'react'
import { decodeLook, type Look } from '../look'
import type { Talk, TalkStore } from './talkState'
import './talk.css'

export default function TalkOverlay({ store, talk, myLook }: { store: TalkStore; talk: Talk; myLook: string }) {
  const mine = decodeLook(myLook)
  const theirs = decodeLook(talk.bean, '#4f7fd6')
  const chat = useRef<HTMLDivElement>(null)
  const { phase, lines } = talk
  const last = lines[lines.length - 1]
  const speaking = phase === 'talking' && last ? last.from : null

  // keep the newest bubble in view
  useEffect(() => {
    const el = chat.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [lines, phase])

  // a no-match closes itself after a while
  useEffect(() => {
    if (phase !== 'nomatch') return
    const t = setTimeout(() => store.dismiss(talk.id), 12000)
    return () => clearTimeout(t)
  }, [phase, store, talk.id])

  const progress = phase === 'talking' ? Math.min(0.9, 0.08 + lines.length / (lines.length + 8)) : 1
  const title =
    phase === 'talking' ? 'Your agent is talking with theirs'
    : phase === 'match' || phase === 'waiting' ? "It's a match!"
    : phase === 'nomatch' ? 'Not your person this time'
    : phase === 'reveal' ? 'Go say hi'
    : 'Not this time'

  return (
    <div className={`tk-overlay tk-${phase}`} role="dialog" aria-modal="true" aria-label="Agent talk">
      <div className="tk-sheet">
        <header className="tk-head">
          <h2>{title}</h2>
          <div className="tk-progress" aria-hidden>
            <i style={{ transform: `scaleX(${progress})` }} />
          </div>
        </header>

        <div className="tk-stage" aria-hidden>
          <div className={'tk-who mine' + (speaking === 'your_agent' ? ' speaking' : '')}>
            <BeanSvg look={mine} wave={phase === 'nomatch'} />
            <span>Your agent</span>
          </div>
          {(phase === 'match' || phase === 'waiting' || phase === 'reveal') && <div className="tk-spark">✦</div>}
          <div className={'tk-who theirs' + (speaking === 'their_agent' ? ' speaking' : '')}>
            <BeanSvg look={theirs} flip wave={phase === 'nomatch'} />
            <span>Their agent</span>
          </div>
        </div>

        {phase === 'reveal' && talk.reveal ? (
          <RevealCard r={talk.reveal} onDone={() => store.dismiss(talk.id)} />
        ) : (
          <div className="tk-chat" ref={chat} aria-live="polite">
            {lines.map((l) => (
              <div key={l.n} className={l.from === 'your_agent' ? 'tk-b mine' : 'tk-b theirs'}>
                {l.typing && !l.text ? (
                  <span className="tk-dots" aria-label="typing">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  l.text
                )}
              </div>
            ))}
            {lines.length === 0 && <p className="tk-note">Saying hello…</p>}
          </div>
        )}

        <footer className="tk-foot">
          {phase === 'talking' && <p className="tk-note">Names stay hidden unless you both say yes.</p>}
          {phase === 'match' && (
            <>
              {talk.why && <p className="tk-why">{talk.why}</p>}
              <p className="tk-ask">Want to meet them?</p>
              <div className="tk-btns">
                <button type="button" className="tk-btn ghost" disabled={talk.sending} onClick={() => store.decide(talk.id, false)}>
                  Skip
                </button>
                <button type="button" className="tk-btn go" disabled={talk.sending} onClick={() => store.decide(talk.id, true)}>
                  Meet them
                </button>
              </div>
            </>
          )}
          {phase === 'waiting' && (
            <>
              {talk.why && <p className="tk-why">{talk.why}</p>}
              <p className="tk-note">You said yes. Waiting for them to answer…</p>
            </>
          )}
          {phase === 'nomatch' && (
            <>
              <p className="tk-why">Your agents said hi and moved on. Plenty more people to meet.</p>
              <div className="tk-btns">
                <button type="button" className="tk-btn go" onClick={() => store.dismiss(talk.id)}>
                  Back to the game
                </button>
              </div>
            </>
          )}
          {phase === 'closed' && (
            <>
              <p className="tk-why">This one didn't work out. No worries.</p>
              <div className="tk-btns">
                <button type="button" className="tk-btn go" onClick={() => store.dismiss(talk.id)}>
                  Back to the game
                </button>
              </div>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}

function RevealCard({ r, onDone }: { r: NonNullable<Talk['reveal']>; onDone: () => void }) {
  return (
    <div className="tk-card">
      <p className="tk-name">{r.name}</p>
      {r.where && <p className="tk-where">{r.where}</p>}
      {r.line && (
        <div className="tk-field">
          <small>Why you two</small>
          <p>{r.line}</p>
        </div>
      )}
      {r.question && (
        <div className="tk-field ask">
          <small>Ask them</small>
          <p>{r.question}</p>
        </div>
      )}
      <button type="button" className="tk-btn go wide" onClick={onDone}>
        Done
      </button>
    </div>
  )
}

/** A light 2D bean (the 3D one would mean a second WebGL canvas on a phone). */
function BeanSvg({ look, flip, wave }: { look: Look; flip?: boolean; wave?: boolean }) {
  const ink = '#2b2a33'
  const ex = 6 // eyes look toward the other bean
  const eye = (cx: number) => {
    switch (look.eyes) {
      case 'happy':
        return <path d={`M${cx - 5} 58 q5 -7 10 0`} stroke={ink} strokeWidth="3.5" fill="none" strokeLinecap="round" />
      case 'sleepy':
        return <path d={`M${cx - 5} 57 h10`} stroke={ink} strokeWidth="3.5" strokeLinecap="round" />
      case 'shades':
        return <rect x={cx - 8} y="51" width="16" height="10" rx="3" fill={ink} />
      default:
        return <circle cx={cx} cy="56" r="4.5" fill={ink} />
    }
  }
  return (
    <svg className={'tk-bean' + (flip ? ' flip' : '') + (wave ? ' waving' : '')} viewBox="0 0 110 140" width="110" height="140">
      <ellipse cx="55" cy="132" rx="30" ry="6" fill="rgba(0,0,0,.14)" />
      <g className="tk-body">
        <g className="tk-arm">
          <ellipse cx="94" cy="84" rx="8" ry="13" fill={look.body} stroke={ink} strokeWidth="3.5" transform="rotate(-25 94 84)" />
        </g>
        <rect x="16" y="22" width="76" height="104" rx="38" fill={look.body} stroke={ink} strokeWidth="4" />
        {look.pattern !== 'solid' && <ellipse cx="54" cy="96" rx="24" ry="20" fill={look.accent} opacity=".9" />}
        {eye(42 + ex)}
        {eye(64 + ex)}
        <circle cx={34 + ex} cy="68" r="4" fill="#ff8fa3" opacity=".6" />
        <circle cx={74 + ex} cy="68" r="4" fill="#ff8fa3" opacity=".6" />
        <path d={`M${49 + ex} 70 q5 5 10 0`} stroke={ink} strokeWidth="3" fill="none" strokeLinecap="round" />
        <Hat hat={look.hat} accent={look.accent} />
      </g>
    </svg>
  )
}

function Hat({ hat, accent }: { hat: Look['hat']; accent: string }) {
  const ink = '#2b2a33'
  switch (hat) {
    case 'cap':
      return (
        <g>
          <path d="M26 36 q28 -30 58 0 z" fill={accent} stroke={ink} strokeWidth="3.5" />
          <path d="M70 34 h24" stroke={ink} strokeWidth="5" strokeLinecap="round" />
        </g>
      )
    case 'crown':
      return <path d="M34 26 l6 -18 l9 12 l6 -16 l6 16 l9 -12 l6 18 z" fill="#f5b700" stroke={ink} strokeWidth="3.5" strokeLinejoin="round" />
    case 'party':
      return <path d="M42 28 l12 -28 l12 28 z" fill={accent} stroke={ink} strokeWidth="3.5" strokeLinejoin="round" />
    case 'halo':
      return <ellipse cx="54" cy="10" rx="20" ry="5" fill="none" stroke="#f5b700" strokeWidth="4" />
    case 'bunny':
      return (
        <g fill="#fff" stroke={ink} strokeWidth="3.5">
          <ellipse cx="42" cy="12" rx="6" ry="16" />
          <ellipse cx="66" cy="12" rx="6" ry="16" />
        </g>
      )
    default:
      return null
  }
}
