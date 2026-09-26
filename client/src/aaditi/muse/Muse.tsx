import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { EVENT, MY_DATA, PEOPLE, matchLabel, type Person, type SourceId } from './data'
import { Panel, type Selection } from './Panel'
import { T0, UNSCORED_R, dataPos, personPos, phase, shownTurns } from './timeline'
import './muse.css'

const FIT_R = 480 // world radius that should fit on screen at zoom 1
const PANEL_W = 460

type Cam = { x: number; y: number; z: number }

export function Muse() {
  const [t, setT] = useState(() => (Date.now() - T0) / 1000)
  const [sel, setSel] = useState<Selection>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [size, setSize] = useState({ w: 1200, h: 800 })
  const wrap = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const cam = useRef<Cam>({ x: 0, y: 0, z: 1 })
  const target = useRef<Cam>({ x: 0, y: 0, z: 1 })
  const drag = useRef<{ x: number; y: number; cam: Cam; moved: boolean } | null>(null)

  // one clock drives the chats, the classification and the camera easing
  useEffect(() => {
    let id = 0
    let last = 0
    const loop = (ms: number) => {
      const c = cam.current
      const g = target.current
      c.x += (g.x - c.x) * 0.12
      c.y += (g.y - c.y) * 0.12
      c.z += (g.z - c.z) * 0.12
      if (ms - last > 32) {
        last = ms
        setT((Date.now() - T0) / 1000)
      }
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    const el = wrap.current!
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const wide = size.w > 900
  const fit = Math.min(size.w - (sel && wide ? PANEL_W : 0), size.h - (sel && !wide ? size.h * 0.62 : 0)) / (2 * FIT_R)
  const scale = Math.max(0.2, fit) * cam.current.z

  // keep the selected node (and you) in the part of the screen the panel doesn't cover
  const focus = (x: number, y: number, z: number) => {
    target.current = { x, y, z }
  }
  useEffect(() => {
    if (!sel) return focus(0, 0, 1)
    if (sel.kind === 'person') {
      const i = PEOPLE.findIndex((p) => p.id === sel.id)
      const pos = personPos(PEOPLE[i], i, (Date.now() - T0) / 1000)
      focus(pos.x * 0.55, pos.y * 0.55, 1.45)
    } else focus(0, 0, sel.kind === 'me' ? 1.6 : 1.9)
  }, [sel])

  useEffect(() => {
    const el = svg.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const z = Math.min(4, Math.max(0.5, target.current.z * Math.exp(-e.deltaY * 0.0015)))
      target.current = { ...target.current, z }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSel(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // screen centre shifts left (or up) when the panel is open
  const offX = sel && wide ? -PANEL_W / 2 : 0
  const offY = sel && !wide ? -size.h * 0.31 : 0
  const c = cam.current
  const vw = size.w / scale
  const vh = size.h / scale
  const viewBox = `${c.x - vw / 2 - offX / scale} ${c.y - vh / 2 - offY / scale} ${vw} ${vh}`

  const people = PEOPLE.map((p, i) => ({ p, i, ph: phase(p, t), pos: personPos(p, i, t) })).filter((n) => n.ph !== 'hidden')
  const data = MY_DATA.map((d, j) => ({ d, pos: dataPos(j, MY_DATA.length, t) }))
  const dataById = Object.fromEntries(data.map((n) => [n.d.id, n]))

  const selPerson = sel?.kind === 'person' ? people.find((n) => n.p.id === sel.id) : undefined
  const citedBy = (p: Person) => new Set(shownTurns(p, t).flatMap((x) => (x.src ? [x.src] : [])))
  const selCites = selPerson ? citedBy(selPerson.p) : new Set<SourceId>()
  const selData = sel?.kind === 'data' ? sel.id : null
  const usesSelData = (p: Person) => !!selData && citedBy(p).has(selData)

  const counts = {
    range: people.length,
    talking: people.filter((n) => n.ph === 'talking' || n.ph === 'handshake').length,
    matched: people.filter((n) => n.ph === 'matched' && n.p.score.overall >= 55).length,
  }
  const top = people
    .filter((n) => n.ph === 'matched')
    .sort((a, b) => b.p.score.overall - a.p.score.overall)
    .slice(0, 4)

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, cam: { ...target.current }, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || !e.buttons) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      d.moved = true
      svg.current?.setPointerCapture(e.pointerId)
    }
    if (!d.moved) return
    const next = { x: d.cam.x - dx / scale, y: d.cam.y - dy / scale, z: d.cam.z }
    target.current = next
    cam.current = { ...next }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (d && !d.moved && e.target === svg.current) setSel(null)
  }
  const pick = (s: Selection) => (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation()
    if (drag.current?.moved) return
    setSel(s)
  }
  const keyPick = (s: Selection) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setSel(s)
    }
  }

  const ping = (t % 4) / 4

  return (
    <div className={`muse${sel ? ' has-sel' : ''}`} ref={wrap}>
      <svg
        ref={svg}
        className="web"
        viewBox={viewBox}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="img"
        aria-label="Web of people your muse agent talked to"
      >
        <defs>
          <radialGradient id="me-glow">
            <stop offset="0" stopColor="#fff" stopOpacity="0.9" />
            <stop offset="0.35" stopColor="#a5f3fc" stopOpacity="0.35" />
            <stop offset="1" stopColor="#a5f3fc" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="node-glow">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.45" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* similarity rings: distance from you = how alike you are */}
        <g className="rings">
          {[90, 70, 50, 30].map((s) => {
            const r = 118 + (100 - s) * 3.3
            return (
              <g key={s}>
                <circle r={r} />
                <text x={4} y={-r - 4}>
                  {s}%
                </text>
              </g>
            )
          })}
          <circle r={UNSCORED_R} className="unscored" />
          <text x={4} y={-UNSCORED_R - 4}>
            in range · not scored yet
          </text>
          <circle r={UNSCORED_R * ping} className="ping" style={{ opacity: 0.5 * (1 - ping) }} />
        </g>

        {/* you → each person */}
        {people.map(({ p, ph, pos }) => {
          const live = ph === 'talking' || ph === 'handshake'
          const label = matchLabel(p.score.overall)
          const dim = (selPerson && selPerson.p.id !== p.id) || (selData && !usesSelData(p))
          return (
            <line
              key={p.id}
              x1={0}
              y1={0}
              x2={pos.x}
              y2={pos.y}
              className={`edge ${live ? 'live' : ph === 'matched' ? label : ph}${dim ? ' dim' : ''}${selPerson?.p.id === p.id || usesSelData(p) ? ' hot' : ''}`}
              style={live ? { strokeDashoffset: -t * 40 } : undefined}
            />
          )
        })}

        {/* selected person → the pieces of your history muse cited */}
        {selPerson &&
          [...selCites].map((id) => {
            const d = dataById[id].pos
            const mx = (d.x + selPerson.pos.x) / 2 + (selPerson.pos.y - d.y) * 0.18
            const my = (d.y + selPerson.pos.y) / 2 - (selPerson.pos.x - d.x) * 0.18
            return <path key={id} className="cite-edge" d={`M${selPerson.pos.x},${selPerson.pos.y} Q${mx},${my} ${d.x},${d.y}`} style={{ strokeDashoffset: -t * 24 }} />
          })}

        {/* your data */}
        {data.map(({ d, pos }) => {
          const hot = selCites.has(d.id) || selData === d.id
          const out = pos.a
          return (
            <g
              key={d.id}
              className={`data${hot ? ' hot' : ''}${hover === d.id ? ' hover' : ''}`}
              transform={`translate(${pos.x} ${pos.y})`}
              onClick={pick({ kind: 'data', id: d.id })}
              onKeyDown={keyPick({ kind: 'data', id: d.id })}
              onPointerEnter={() => setHover(d.id)}
              onPointerLeave={() => setHover(null)}
              role="button"
              tabIndex={0}
              aria-label={`Your ${d.label}`}
            >
              <line x1={0} y1={0} x2={-pos.x} y2={-pos.y} className="spoke" />
              <circle r={hot ? 7.5 : 5.5} />
              <text x={Math.cos(out) * 13} y={Math.sin(out) * 13 + 3} textAnchor={Math.cos(out) > 0.3 ? 'start' : Math.cos(out) < -0.3 ? 'end' : 'middle'}>
                {d.label}
              </text>
            </g>
          )
        })}

        {/* you */}
        <g
          className={`me${sel?.kind === 'me' ? ' sel' : ''}`}
          onClick={pick({ kind: 'me' })}
          onKeyDown={keyPick({ kind: 'me' })}
          role="button"
          tabIndex={0}
          aria-label="You and your data"
        >
          <circle r={58} fill="url(#me-glow)" />
          <circle r={24} className="core" />
          <text y={4} className="me-label">
            you
          </text>
          <text y={42} className="me-sub">
            muse · {MY_DATA.length} sources
          </text>
        </g>

        {/* people */}
        {people.map(({ p, ph, pos }) => {
          const isSel = selPerson?.p.id === p.id
          const label = matchLabel(p.score.overall)
          const cls = ph === 'matched' ? label : ph
          const r = (7 + p.score.overall / 11) * (isSel ? 1.5 : 1)
          const dim = (selPerson && !isSel) || (selData && !usesSelData(p))
          const first = p.name.split(' ')[0]
          return (
            <g
              key={p.id}
              className={`person ${cls}${isSel ? ' sel' : ''}${dim ? ' dim' : ''}${hover === p.id ? ' hover' : ''}`}
              transform={`translate(${pos.x} ${pos.y})`}
              onClick={pick({ kind: 'person', id: p.id })}
              onKeyDown={keyPick({ kind: 'person', id: p.id })}
              onPointerEnter={() => setHover(p.id)}
              onPointerLeave={() => setHover(null)}
              role="button"
              tabIndex={0}
              aria-label={`${p.name}, ${ph === 'matched' ? `${p.score.overall}% match` : ph}`}
            >
              <circle r={r * 3} className="halo" fill="url(#node-glow)" />
              {(ph === 'talking' || ph === 'handshake') && <circle r={r + 4 + ((t * 10) % 12)} className="pulse" style={{ opacity: 1 - ((t * 10) % 12) / 12 }} />}
              {ph === 'classifying' && <circle r={r + 5} className="spin" style={{ strokeDashoffset: -t * 60 }} />}
              <circle r={r} className="body" />
              <text y={r + 14} className="name">
                {first}
              </text>
              <text y={r + 26} className="score">
                {ph === 'matched' ? `${p.score.overall}%` : ph === 'classifying' ? 'jev…' : ph === 'handshake' ? 'handshake' : 'talking'}
              </text>

              {/* expanded: the topics you share branch off the node */}
              {isSel &&
                p.topics.map((topic, k) => {
                  const spread = ((k - (p.topics.length - 1) / 2) * Math.PI) / 5
                  const a = pos.a + spread
                  const d = 70
                  const x = Math.cos(a) * d
                  const y = Math.sin(a) * d
                  return (
                    <g key={topic} className="topic" style={{ '--d': `${k * 60}ms` } as CSSProperties}>
                      <line x1={Math.cos(a) * r} y1={Math.sin(a) * r} x2={x} y2={y} />
                      <circle cx={x} cy={y} r={3.5} />
                      <text x={x + Math.cos(a) * 8} y={y + Math.sin(a) * 8 + 3} textAnchor={Math.cos(a) > 0.2 ? 'start' : Math.cos(a) < -0.2 ? 'end' : 'middle'}>
                        {topic}
                      </text>
                    </g>
                  )
                })}
            </g>
          )
        })}
      </svg>

      <header className="hud">
        <div className="brand">
          muse<span>web</span>
        </div>
        <div className="event">
          {EVENT.name} · {EVENT.venue} · radius {EVENT.radius} m
        </div>
        <div className="monitors">
          <span>
            <i className="dot live" /> OpenClaw monitoring
          </span>
          <span>
            <i className="dot jev" /> jev classifying
          </span>
        </div>
        <div className="counts">
          <span>
            <b>{counts.range}</b> agents met
          </span>
          <span>
            <b>{counts.talking}</b> talking now
          </span>
          <span>
            <b>{counts.matched}</b> worth meeting
          </span>
        </div>
        {top.length > 0 && (
          <ol className="top">
            {top.map(({ p }) => (
              <li key={p.id}>
                <button onClick={() => setSel({ kind: 'person', id: p.id })}>
                  <span className={`sw ${matchLabel(p.score.overall)}`} />
                  {p.name}
                  <b>{p.score.overall}%</b>
                </button>
              </li>
            ))}
          </ol>
        )}
      </header>

      <div className="legend" aria-hidden>
        <span>
          <i className="sw strong" /> strong
        </span>
        <span>
          <i className="sw worth" /> worth meeting
        </span>
        <span>
          <i className="sw low" /> low overlap
        </span>
        <span>
          <i className="sw talking" /> agents talking
        </span>
        <span className="hint">closer = more similar · tap a node · drag, scroll to zoom</span>
      </div>

      <div className="zoom">
        <button onClick={() => (target.current = { ...target.current, z: Math.min(4, target.current.z * 1.3) })} aria-label="Zoom in">
          +
        </button>
        <button onClick={() => (target.current = { ...target.current, z: Math.max(0.5, target.current.z / 1.3) })} aria-label="Zoom out">
          −
        </button>
        <button
          onClick={() => {
            setSel(null)
            target.current = { x: 0, y: 0, z: 1 }
          }}
          aria-label="Reset view"
        >
          ⌂
        </button>
      </div>

      {sel && <Panel sel={sel} t={Math.floor(t * 4) / 4} onSelect={setSel} />}
    </div>
  )
}
