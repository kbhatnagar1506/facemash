import { useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { hms, spinner, stamp, useNow } from '../ui/time'
import { CHATS, JEV_DELAY, RADIUS_M, RING, USER, USERS, type Chat } from './data'
import './admin.css'

// Architecture view of the platform: hub in the middle, every lifetime user around it,
// and for active users, the live agent-to-agent chat between them and whoever their muse is talking to.

const LOAD = Date.now()
const HUB = { w: 440, h: 250 }
const UBOX = { w: 230, h: 138 }
const CBOX = { w: 390, h: 400 }
const RING_R = { x: 930, y: 660 }
const CHAT_R = { x: 1400, y: 1010 }

type Pt = { x: number; y: number }
type Box = Pt & { w: number; h: number }

const angle = (i: number) => (i / RING.length) * Math.PI * 2
const onEllipse = (a: number, r: Pt, k = 1): Pt => ({ x: Math.sin(a) * r.x * k, y: -Math.cos(a) * r.y * k })

const userBox: Record<string, Box> = Object.fromEntries(RING.map((id, i) => [id, { ...onEllipse(angle(i), RING_R), ...UBOX }]))
const chatBox: Record<string, Box> = Object.fromEntries(
  CHATS.map((c) => {
    const ia = RING.indexOf(c.a)
    const ib = RING.indexOf(c.b)
    return [c.id, { ...onEllipse((angle(ia) + angle(ib)) / 2, CHAT_R, c.out), ...CBOX }]
  }),
)
const hubBox: Box = { x: 0, y: 0, ...HUB }

// where the line from a box's centre towards `to` leaves the box, so arrowheads sit on the border
function exit(b: Box, to: Pt, pad = 6): Pt {
  const dx = to.x - b.x
  const dy = to.y - b.y
  const t = Math.min((b.w / 2 + pad) / Math.abs(dx || 1e-9), (b.h / 2 + pad) / Math.abs(dy || 1e-9))
  return { x: b.x + dx * t, y: b.y + dy * t }
}

function chatPhase(c: Chat, now: number) {
  const elapsed = (now - (LOAD - c.startedAgo * 1000)) / 1000
  const last = c.msgs.at(-1)!.t
  const phase = elapsed < last ? 'live' : elapsed < last + JEV_DELAY ? 'classifying' : 'matched'
  return { elapsed, phase, visible: c.msgs.filter((m) => m.t <= elapsed) } as const
}

type Sel = { kind: 'user' | 'chat'; id: string } | null

export function Admin() {
  const now = useNow(500)
  const [sel, setSel] = useState<Sel>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 0.3 })
  const port = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const touched = useRef(false)
  const dragged = useRef(false)

  const phases = Object.fromEntries(CHATS.map((c) => [c.id, chatPhase(c, now)]))
  const busy = new Set(CHATS.filter((c) => phases[c.id].phase !== 'matched').flatMap((c) => [c.a, c.b]))

  // stats for the hub
  const lifetime = USERS.length
  const active = USERS.filter((u) => u.active).length
  const liveChats = CHATS.filter((c) => phases[c.id].phase === 'live').length
  const scored = CHATS.filter((c) => phases[c.id].phase === 'matched').length
  const withheld = CHATS.reduce((n, c) => n + phases[c.id].visible.filter((m) => !m.src).length, 0)
  const chatSecs = CHATS.reduce((s, c) => s + Math.min(Math.max(phases[c.id].elapsed, 0), c.msgs.at(-1)!.t) * 2, 0)
  const hours = USERS.reduce((s, u) => s + u.hours, 0) + (active * (now - LOAD)) / 3_600_000 + chatSecs / 3600

  // what to highlight for the current selection
  const related = new Set<string>()
  if (sel?.kind === 'user') {
    related.add(sel.id).add('hub')
    for (const c of CHATS) if (c.a === sel.id || c.b === sel.id) related.add(c.id).add(c.a).add(c.b)
  } else if (sel?.kind === 'chat') {
    const c = CHATS.find((x) => x.id === sel.id)!
    related.add(c.id).add(c.a).add(c.b)
  }
  const dim = (id: string) => (sel && !related.has(id) ? ' faded' : '')

  const fit = () => {
    const el = port.current
    if (!el) return
    const all = [hubBox, ...Object.values(userBox), ...Object.values(chatBox)]
    const minX = Math.min(...all.map((b) => b.x - b.w / 2)) - 40
    const maxX = Math.max(...all.map((b) => b.x + b.w / 2)) + 40
    const minY = Math.min(...all.map((b) => b.y - b.h / 2)) - 40
    const maxY = Math.max(...all.map((b) => b.y + b.h / 2)) + 40
    const k = Math.min(el.clientWidth / (maxX - minX), el.clientHeight / (maxY - minY))
    setView({ k, x: el.clientWidth / 2 - ((minX + maxX) / 2) * k, y: el.clientHeight / 2 - ((minY + maxY) / 2) * k })
  }

  const zoomAt = (factor: number, px: number, py: number) =>
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.12, v.k * factor))
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
    })

  // focus a box: zoom so it fills most of the screen
  const focus = (b: Box) => {
    const el = port.current
    if (!el) return
    touched.current = true
    const k = Math.min(1.4, Math.min(el.clientWidth / (b.w * 2.2), el.clientHeight / (b.h * 1.6)))
    setView({ k, x: el.clientWidth / 2 - b.x * k, y: el.clientHeight / 2 - b.y * k })
  }

  useLayoutEffect(() => {
    fit()
    const el = port.current
    if (!el) return
    const ro = new ResizeObserver(() => !touched.current && fit())
    ro.observe(el)
    const onWheel = (e: WheelEvent) => {
      const log = (e.target as HTMLElement).closest('.chat-log')
      if (log && log.scrollHeight > log.clientHeight && !e.ctrlKey) return
      e.preventDefault()
      touched.current = true
      const r = el.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSel(null)
    window.addEventListener('keydown', onKey)
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const down = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest('.chat-log, button, .overlay')) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
  }
  const move = (e: RPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    if (!d.moved) port.current?.setPointerCapture(e.pointerId)
    d.moved = true
    touched.current = true
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
  }
  const up = (e: RPointerEvent) => {
    const d = drag.current
    drag.current = null
    dragged.current = !!d?.moved
    if (d && !d.moved && e.target === e.currentTarget.firstChild) setSel(null)
  }
  // a click that ended a drag shouldn't select
  const pick = (s: Sel) => () => !dragged.current && setSel((cur) => (cur?.kind === s?.kind && cur?.id === s?.id ? null : s))

  return (
    <div className="adm">
      <div
        className="port"
        ref={port}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${28 * view.k}px ${28 * view.k}px` }}
      >
        <div className="grid-hit" />
        <div className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="edges" width="1" height="1" aria-hidden>
            <defs>
              {['w', 'g'].map((c) => (
                <marker key={c} id={`arrow-${c}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0 L10 5 L0 10 z" className={`arrowhead ${c}`} />
                </marker>
              ))}
            </defs>

            {/* hub to every lifetime user */}
            {USERS.map((u) => {
              const b = userBox[u.id]
              const p1 = exit(hubBox, b, 2)
              const p2 = exit(b, hubBox, 2)
              return <line key={u.id} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className={`e-hub ${u.active ? 'on' : 'off'}${dim(u.id)}`} />
            })}

            {/* active user -> chat -> the account on the other end */}
            {CHATS.map((c) => {
              const cb = chatBox[c.id]
              const ph = phases[c.id].phase
              const cls = `e-chat ${ph === 'matched' ? 'done' : 'live'}${sel ? (related.has(c.id) ? '' : ' faded') : ''}`
              const marker = `url(#arrow-${ph === 'matched' ? 'g' : 'w'})`
              const a1 = exit(userBox[c.a], cb)
              const a2 = exit(cb, userBox[c.a])
              const b1 = exit(cb, userBox[c.b])
              const b2 = exit(userBox[c.b], cb)
              return (
                <g key={c.id}>
                  <line x1={a1.x} y1={a1.y} x2={a2.x} y2={a2.y} className={cls} markerEnd={marker} />
                  <line x1={b1.x} y1={b1.y} x2={b2.x} y2={b2.y} className={cls} markerEnd={marker} />
                </g>
              )
            })}
          </svg>

          <Place b={hubBox} className={`hub${sel ? (related.has('hub') ? '' : ' faded') : ''}`}>
            <div className="hub-title">
              <span>MUSE PLATFORM</span>
              <span className="dim">admin · all events</span>
            </div>
            <div className="hub-stats">
              <Stat n={1} v={lifetime.toLocaleString()} k="lifetime users to date" />
              <Stat n={2} v={hours.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} unit="h" k="hours of activity to date" />
              <Stat n={3} v={String(active)} k="active users now" />
            </div>
            <div className="hub-foot">
              <span>
                <i className="dot live" /> {liveChats} agent chats live
              </span>
              <span>OpenClaw monitoring · {withheld} claims withheld</span>
              <span>jev scored {scored}</span>
            </div>
          </Place>

          {USERS.map((u) => (
            <Place key={u.id} b={userBox[u.id]} className={`user ${u.active ? 'on' : 'off'}${sel?.id === u.id ? ' selected' : ''}${dim(u.id)}`} onClick={pick({ kind: 'user', id: u.id })}>
              <div className="u-top">
                <span className={`u-state ${u.active ? 'on' : 'off'}`}>{u.active ? (busy.has(u.id) ? '● IN AGENT CHAT' : '● ACTIVE') : `○ INACTIVE · ${u.lastSeen}`}</span>
              </div>
              <div className="u-name">{u.name}</div>
              <div className="u-role">{u.role}</div>
              <div className="u-row">▸ building {u.building}</div>
              <div className="u-row">
                ⌖ {u.active ? '' : 'last: '}
                {u.event}
                {u.where && u.active ? ` · ${u.where}` : ''}
              </div>
              <div className="u-foot">
                {u.hours.toFixed(1)} h to date · {CHATS.filter((c) => c.a === u.id || c.b === u.id).length} chats today
              </div>
            </Place>
          ))}

          {CHATS.map((c) => (
            <ChatCard key={c.id} c={c} b={chatBox[c.id]} now={now} p={phases[c.id]} cls={`${sel?.id === c.id ? ' selected' : ''}${sel ? (related.has(c.id) ? '' : ' faded') : ''}`} onPick={pick({ kind: 'chat', id: c.id })} onFocus={() => focus(chatBox[c.id])} />
          ))}
        </div>
      </div>

      <div className="overlay title-card">
        <div className="t">Muse · admin architecture</div>
        <ol className="pipeline">
          <li>People pass within {RADIUS_M} m at an event</li>
          <li>Their muse agents talk, several at once</li>
          <li>OpenClaw monitors and withholds unsourced claims</li>
          <li>jev classifies the finished chat</li>
          <li>Match % and a first topic go to both people</li>
        </ol>
      </div>

      <div className="overlay legend">
        <div>
          <span className="sw on" /> active user
        </div>
        <div>
          <span className="sw off" /> inactive user
        </div>
        <div>
          <span className="ln live" /> live agent chat
        </div>
        <div>
          <span className="ln done" /> chat scored by jev
        </div>
        <div>
          <span className="ln spoke" /> lifetime link to platform
        </div>
      </div>

      <div className="overlay zoom">
        <button onClick={() => { touched.current = true; zoomAt(1 / 1.25, (port.current?.clientWidth ?? 0) / 2, (port.current?.clientHeight ?? 0) / 2) }} aria-label="Zoom out">
          −
        </button>
        <button onClick={() => { touched.current = false; setSel(null); fit() }}>fit</button>
        <button onClick={() => { touched.current = true; zoomAt(1.25, (port.current?.clientWidth ?? 0) / 2, (port.current?.clientHeight ?? 0) / 2) }} aria-label="Zoom in">
          +
        </button>
      </div>
    </div>
  )
}

function Place({ b, className, children, onClick }: { b: Box; className: string; children: ReactNode; onClick?: () => void }) {
  return (
    <div className={`node ${className}`} style={{ left: b.x - b.w / 2, top: b.y - b.h / 2, width: b.w, height: b.h }} onClick={onClick}>
      {children}
    </div>
  )
}

function Stat({ n, v, k, unit }: { n: number; v: string; k: string; unit?: string }) {
  return (
    <div className="stat">
      <span className="stat-n">{n}</span>
      <div className="stat-v">
        {v}
        {unit && <small> {unit}</small>}
      </div>
      <div className="stat-k">{k}</div>
    </div>
  )
}

type ChatProps = { c: Chat; b: Box; now: number; p: ReturnType<typeof chatPhase>; cls: string; onPick: () => void; onFocus: () => void }

function ChatCard({ c, b, now, p, cls, onPick, onFocus }: ChatProps) {
  const log = useRef<HTMLDivElement>(null)
  const start = LOAD - c.startedAgo * 1000
  const A = USER[c.a].name.split(' ')[0]
  const B = USER[c.b].name.split(' ')[0]
  const typing = p.phase === 'live' ? c.msgs[p.visible.length] : undefined
  const withheld = p.visible.filter((m) => !m.src).length

  useLayoutEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [p.visible.length, p.phase])

  return (
    <Place b={b} className={`chat ${p.phase}${cls}`} onClick={onPick}>
      <header className="c-head">
        <div className="c-who">
          muse·{A} <span className="dim">⇄</span> muse·{B}
        </div>
        <span className={`pill ${p.phase}`}>
          {p.phase === 'live' ? '● LIVE' : p.phase === 'classifying' ? `${spinner(now)} JEV` : `MATCH ${c.jev.overall}%`}
        </span>
      </header>
      <div className="c-sub">
        {c.event} · started <time title={stamp(start)}>{hms(start)}</time>
      </div>
      <div className="c-sub monitor">
        <i className={`dot ${p.phase === 'live' ? 'live' : ''}`} /> OpenClaw {p.phase === 'live' ? 'monitoring' : 'closed'} · {p.visible.length} replies · {withheld} withheld
        <button className="c-zoom" onClick={(e) => (e.stopPropagation(), onFocus())} title="zoom to this chat">
          ⤢
        </button>
      </div>

      <div className="chat-log" ref={log}>
        {p.visible.map((m, i) => {
          const at = start + m.t * 1000
          const who = m.from === 'a' ? A : B
          return (
            <div key={i} className={`m ${m.from}${m.src ? '' : ' struck'}`}>
              <div className="m-meta">
                <time title={stamp(at)}>[{hms(at)}]</time> muse·{who}
              </div>
              <div className="m-text">{m.text}</div>
              <div className="m-src">{m.src ? `↳ from ${m.src}` : `⊘ OpenClaw: no source in ${who}'s history, withheld from scoring`}</div>
            </div>
          )
        })}
        {typing && (
          <div className="m typing">
            {spinner(now)} muse·{typing.from === 'a' ? A : B} is replying…
          </div>
        )}
      </div>

      <footer className="c-jev">
        {p.phase === 'live' && <span className="dim">jev scores this chat when the agents finish</span>}
        {p.phase === 'classifying' && (
          <span>
            {spinner(now)} jev classifying: thoughts, career, building…
          </span>
        )}
        {p.phase === 'matched' && (
          <>
            <div className="bars">
              <Bar k="thoughts" v={c.jev.thoughts} />
              <Bar k="career" v={c.jev.career} />
              <Bar k="building" v={c.jev.building} />
            </div>
            <div className="topic">
              <b>first topic</b> {c.jev.topic}
            </div>
          </>
        )}
      </footer>
    </Place>
  )
}

function Bar({ k, v }: { k: string; v: number }) {
  return (
    <div className="bar">
      <span>{k}</span>
      <span className="track">
        <span style={{ width: `${v}%` }} />
      </span>
      <span>{v}%</span>
    </div>
  )
}

export default Admin
