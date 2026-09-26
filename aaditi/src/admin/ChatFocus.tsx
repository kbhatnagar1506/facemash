import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { hms, spinner, stamp } from '../ui/time'
import { Avatar } from './Avatar'
import { RADIUS_M, USER, type Chat, type User } from './data'
import { chatStart, type Phase } from './timing'

// A chat box expanded to the whole screen: the two people on either side, the agents' live
// conversation in the middle, OpenClaw's monitor on the left and jev's result on the right.

type Props = { c: Chat; p: Phase; now: number; origin: { x: number; y: number }; onClose: () => void }

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const kind = (src: string) => src.split(' · ')[1] ?? src

export function ChatFocus({ c, p, now, origin, onClose }: Props) {
  const [closing, setClosing] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const A = USER[c.a]
  const B = USER[c.b]
  const start = chatStart(c)
  const typing = p.phase === 'live' ? c.msgs[p.visible.length] : undefined
  const withheld = p.visible.filter((m) => !m.src).length
  const lastT = c.msgs.at(-1)!.t

  const close = () => {
    setClosing(true)
    setTimeout(onClose, 180)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useLayoutEffect(() => {
    const el = log.current
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: p.visible.length ? 'smooth' : 'auto' })
  }, [p.visible.length, !!typing])

  return (
    <div className={`focus-scrim${closing ? ' closing' : ''}`} onMouseDown={close}>
      <div
        className="focus"
        role="dialog"
        aria-label={`Agent chat between ${A.name} and ${B.name}`}
        style={{ '--ox': `${origin.x}px`, '--oy': `${origin.y}px` } as CSSProperties}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="f-head">
          <div>
            <div className="f-who">
              muse·{A.name.split(' ')[0]} <span className="dim">⇄</span> muse·{B.name.split(' ')[0]}
            </div>
            <div className="f-sub">
              {c.event} · met within {RADIUS_M} m · started <time title={stamp(start)}>{hms(start)}</time> · {mmss(Math.min(Math.max(p.elapsed, 0), lastT))} talking
            </div>
          </div>
          <span className={`pill big ${p.phase}`}>
            {p.phase === 'live' ? '● LIVE' : p.phase === 'classifying' ? `${spinner(now)} JEV CLASSIFYING` : `MATCH ${c.jev.overall}%`}
          </span>
          <button className="f-close" onClick={close} aria-label="Close full screen chat">
            ✕ <span>esc</span>
          </button>
        </header>

        <div className="f-body">
          <aside className="f-side">
            <Person u={A} side="a" cited={p.visible.filter((m) => m.from === 'a' && m.src).map((m) => kind(m.src!))} />
            <section className="f-card">
              <h3>
                <i className={`dot ${p.phase === 'live' ? 'live' : ''}`} /> OpenClaw monitor
              </h3>
              <dl className="f-stats">
                <dt>status</dt>
                <dd>{p.phase === 'live' ? 'monitoring' : 'closed'}</dd>
                <dt>replies</dt>
                <dd>{p.visible.length}</dd>
                <dt>sourced</dt>
                <dd>{p.visible.length - withheld}</dd>
                <dt>withheld</dt>
                <dd className={withheld ? 'hot' : ''}>{withheld}</dd>
              </dl>
              <p className="f-note">Every reply must trace back to its owner's history. Anything that doesn't is struck out and left out of jev's score.</p>
            </section>
          </aside>

          <main className="f-log" ref={log} onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}>
            {p.visible.length === 0 && <div className="f-empty">{spinner(now)} agents are opening the conversation…</div>}
            {p.visible.map((m, i) => {
              const at = start + m.t * 1000
              const who = (m.from === 'a' ? A : B).name.split(' ')[0]
              return (
                <div key={i} className={`fm ${m.from}${m.src ? '' : ' struck'}`}>
                  <Avatar id={m.from === 'a' ? c.a : c.b} size={40} />
                  <div className="fm-body">
                    <div className="fm-meta">
                      <time title={stamp(at)}>{hms(at)}</time> · muse·{who}
                    </div>
                    <div className="fm-bubble">{m.text}</div>
                    <div className="fm-src">{m.src ? `↳ from ${m.src}` : `⊘ OpenClaw: no source in ${who}'s history, withheld from scoring`}</div>
                  </div>
                </div>
              )
            })}
            {typing && (
              <div className={`fm ${typing.from} typing`}>
                <Avatar id={typing.from === 'a' ? c.a : c.b} size={40} />
                <div className="fm-body">
                  <div className="fm-meta">muse·{(typing.from === 'a' ? A : B).name.split(' ')[0]} is replying</div>
                  <div className="fm-bubble">
                    <span className="bounce">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                </div>
              </div>
            )}
            {p.phase !== 'live' && <div className="f-end">── agents finished · handed to jev ──</div>}
          </main>

          <aside className="f-side">
            <Person u={B} side="b" cited={p.visible.filter((m) => m.from === 'b' && m.src).map((m) => kind(m.src!))} />
            <section className="f-card jev">
              <h3>jev classification</h3>
              {p.phase === 'live' && <p className="dim">Scores the chat once both agents finish.</p>}
              {p.phase === 'classifying' && <p>{spinner(now)} comparing thoughts, career and what they're building…</p>}
              {p.phase === 'matched' && (
                <>
                  <div className="f-score">
                    {c.jev.overall}
                    <small>% match</small>
                  </div>
                  {(['thoughts', 'career', 'building'] as const).map((k) => (
                    <div className="bar" key={k}>
                      <span>{k}</span>
                      <span className="track">
                        <span style={{ width: `${c.jev[k]}%` }} />
                      </span>
                      <span>{c.jev[k]}%</span>
                    </div>
                  ))}
                  <div className="f-topic">
                    <b>suggested first topic</b>
                    {c.jev.topic}
                  </div>
                  <p className="dim small">Sent to {A.name.split(' ')[0]} and {B.name.split(' ')[0]}.</p>
                </>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}

function Person({ u, side, cited }: { u: User; side: 'a' | 'b'; cited: string[] }) {
  const kinds = [...new Set(cited)]
  return (
    <section className={`f-person ${u.active ? 'on' : 'off'} ${side}`}>
      <div className="u-state">{u.active ? '● ACTIVE' : `○ INACTIVE · ${u.lastSeen}`}</div>
      <div className="fp-name">
        <Avatar id={u.id} size={44} />
        {u.name}
      </div>
      <div className="fp-role">{u.role}</div>
      <div className="fp-row">▸ building {u.building}</div>
      <div className="fp-row">
        ⌖ {u.event}
        {u.where ? ` · ${u.where}` : ''}
      </div>
      <div className="fp-row">{u.hours.toFixed(1)} h on Muse to date</div>
      <div className="fp-cited">
        <b>history muse cited</b>
        {kinds.length ? kinds.map((k) => <span key={k}>{k}</span>) : <em>nothing yet</em>}
      </div>
    </section>
  )
}
