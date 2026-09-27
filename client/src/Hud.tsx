import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { NpcChat, useNpcChat } from './NpcChat'
import type { Campus, Collider } from './map'
import type { Net } from './net'
import type { PlayerInfo } from './Player'
import { HackGTWelcome, InfoBoard, type EventInfo } from './HackGTWelcome'
import { HALL_EXIT, PHOTO_EVENT, nearestSpot, type Spot, type Table } from './hall/layout'
import { nearestShell } from './Shells'
import { Stick } from './Stick'
import { touchFirst } from './touch'

const MAP_PX = 190

function Minimap({ campus, net, info }: { campus: Campus; net: Net; info: React.MutableRefObject<PlayerInfo> }) {
  const canvas = useRef<HTMLCanvasElement>(null!)
  const [big, setBig] = useState(false)

  useEffect(() => {
    const [x0, z0, x1, z1] = campus.bounds
    const size = big ? 520 : MAP_PX
    const scale = size / Math.max(x1 - x0, z1 - z0)
    const dpr = window.devicePixelRatio || 1
    const cv = canvas.current
    cv.width = cv.height = size * dpr
    cv.style.width = cv.style.height = `${size}px`

    // Static layer drawn once.
    const base = document.createElement('canvas')
    base.width = base.height = size * dpr
    const b = base.getContext('2d')!
    b.scale(dpr, dpr)
    const tx = (x: number) => (x - x0) * scale
    const tz = (z: number) => (z - z0) * scale
    b.fillStyle = '#9ad97a'
    b.fillRect(0, 0, size, size)
    b.lineCap = 'round'
    for (const r of campus.roads) {
      b.strokeStyle = r.foot ? '#efdcae' : '#8d93a3'
      b.lineWidth = Math.max(0.6, r.w * scale)
      b.beginPath()
      r.pts.forEach(([x, z], i) => (i ? b.lineTo(tx(x), tz(z)) : b.moveTo(tx(x), tz(z))))
      b.stroke()
    }
    for (const bl of campus.buildings) {
      b.fillStyle = bl.event ? '#f5b700' : bl.roof
      b.beginPath()
      bl.pts.forEach(([x, z], i) => (i ? b.lineTo(tx(x), tz(z)) : b.moveTo(tx(x), tz(z))))
      b.fill()
    }

    const ctx = cv.getContext('2d')!
    let raf = 0
    const draw = (t: number) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(base, 0, 0)
      ctx.scale(dpr, dpr)
      if (campus.event) {
        const [ex, ez] = campus.event.center
        const pulse = 5 + Math.sin(t / 200) * 2
        ctx.fillStyle = '#ffd23f'
        ctx.strokeStyle = '#2b2a33'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(tx(ex), tz(ez), pulse, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
      for (const p of net.players.values()) {
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(tx(p.x), tz(p.z), 3, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = '#e0564f'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(tx(info.current.x), tz(info.current.z), 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [campus, net, info, big])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.code === 'KeyM' && !(document.activeElement instanceof HTMLInputElement)) setBig((v) => !v)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  return (
    <div className={big ? 'minimap big' : 'minimap'} onClick={() => setBig((v) => !v)} title="Map (M)">
      <div className="minimap-head">
        <img src="/gt-logo.svg" alt="Georgia Tech" />
      </div>
      <canvas ref={canvas} />
    </div>
  )
}

/** Pokémon-style "area name" sign that slides in when you walk up to a building. */
function LocationSign({ collider, info }: { collider: Collider; info: React.MutableRefObject<PlayerInfo> }) {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    const id = setInterval(() => {
      setName(collider.nearestNamed(info.current.x, info.current.z)?.name ?? null)
    }, 250)
    return () => clearInterval(id)
  }, [collider, info])
  return (
    <div className={name ? 'location show' : 'location'}>
      <span>{name}</span>
    </div>
  )
}

/** "Now / Next" from the real HackGT schedule, using the viewer's clock. */
function nowNext(event: EventInfo | null) {
  if (!event?.days) return null
  const now = Date.now()
  const all = event.days.flatMap((d) =>
    d.items.map((it) => {
      const start = new Date(`${d.date}T${it.start}:00`).getTime()
      let end = it.end ? new Date(`${d.date}T${it.end}:00`).getTime() : start + 30 * 60e3
      if (end < start) end += 24 * 3600e3 // runs past midnight
      return { ...it, startMs: start, endMs: end }
    }),
  )
  const live = all.filter((it) => it.startMs <= now && now < it.endMs)
  const next = all.filter((it) => it.startMs > now).sort((a, b) => a.startMs - b.startMs)[0]
  return { live, next }
}

const TOUCH = touchFirst()
/** Hall signs say "Press E"; a phone has no E, so there it's a tap on the card. */
const keyHint = (text: string) => (TOUCH ? text.replace(/Press E to /g, 'Tap to ').replace(/Press E\b/g, 'Tap here') : text)

export function Hud({
  campus, collider, net, info, eventOpen, setEventOpen, event, room, onEnterHall, onLeaveHall,
}: {
  campus: Campus
  collider: Collider
  net: Net
  info: React.MutableRefObject<PlayerInfo>
  eventOpen: boolean
  setEventOpen: (v: boolean) => void
  event: EventInfo | null
  room: 'campus' | 'hackgt'
  onEnterHall: () => void
  onLeaveHall: () => void
}) {
  type Near = null | { kind: 'shell' } | { kind: 'exit' } | { kind: 'spot'; spot: Spot } | { kind: 'table'; table: Table }
  const [near, setNear] = useState<Near>(null)
  const [npcChat, closeNpcChat] = useNpcChat()
  const [board, setBoard] = useState<null | 'about' | 'tracks' | 'schedule'>(null)
  const [bike, setBike] = useState(false)
  const [clock, setClock] = useState(0)
  const [snap, setSnap] = useState(0) // photo-booth flash + toast
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => net.subscribe(rerender), [net])

  useEffect(() => {
    const id = setInterval(() => {
      const { x, z } = info.current
      setBike(info.current.bike)
      if (room === 'campus') {
        setNear(nearestShell(campus, x, z) ? { kind: 'shell' } : null)
        return
      }
      const y = info.current.y ?? 0
      const spot = nearestSpot(x, z, y)
      const next: Near =
        Math.hypot(HALL_EXIT[0] - x, HALL_EXIT[1] - z) < 3 ? { kind: 'exit' }
          : spot ? { kind: 'spot', spot }
          : null
      // only re-render when what you're next to actually changes
      setNear((cur) => {
        const key = (n: Near) => (!n ? '' : n.kind === 'table' ? `t${n.table.n}` : n.kind === 'spot' ? n.spot.id : n.kind)
        return key(cur) === key(next) ? cur : next
      })
    }, 200)
    const tick = setInterval(() => setClock((c) => c + 1), 30_000)
    return () => {
      clearInterval(id)
      clearInterval(tick)
    }
  }, [campus, info, room])

  // P: mark where you're standing (used to lay walls exactly where they are in real life).
  const [marks, setMarks] = useState<{ n: number; x: number; z: number; at: number }[]>([])
  useEffect(() => {
    if (room !== 'hackgt') return
    const k = (e: KeyboardEvent) => {
      if (e.code !== 'KeyP' || document.activeElement instanceof HTMLInputElement) return
      const { x, z } = info.current
      setMarks((m) => {
        const n = m.length + 1
        fetch('/api/geo/samples', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'wall-mark', n, x: +x.toFixed(2), z: +z.toFixed(2), t: new Date().toISOString() }),
        }).catch(() => {})
        return [...m, { n, x, z, at: Date.now() }]
      })
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [room, info])

  const act = () => {
    if (!near) return
    if (near.kind === 'shell') setEventOpen(true)
    else if (near.kind === 'exit') onLeaveHall()
    else if (near.kind === 'table') setBoard('tracks')
    else if (near.spot.action === 'photo') {
      window.dispatchEvent(new Event(PHOTO_EVENT))
      setSnap(Date.now())
    } else if (near.spot.action) setBoard(near.spot.action)
  }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (document.activeElement instanceof HTMLInputElement || eventOpen || board || npcChat) return
      if (e.code === 'KeyE' || e.code === 'Space') act()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const title = event?.title ?? 'HackGT'
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const schedule = useMemo(() => nowNext(event), [event, clock])
  // the server only streams nearby players, so ask it for the real head-count
  const [roomCount, setRoomCount] = useState<number | null>(null)
  useEffect(() => {
    let dead = false
    const poll = () =>
      fetch('/api/online')
        .then((r) => r.json())
        .then((c: Record<string, number>) => !dead && setRoomCount(c[net.room] ?? null))
        .catch(() => {})
    poll()
    const t = setInterval(poll, 5000)
    return () => {
      dead = true
      clearInterval(t)
    }
  }, [net])
  const inHall = room === 'hackgt'

  return (
    <div className="hud">
      <div className="topbar">
        <div className={net.connected ? 'online' : 'online off'}>
          ● {net.connected ? `${Math.max(roomCount ?? 0, net.players.size + 1)} ${inHall ? `at ${title}` : 'on campus'}` : 'Connecting…'}
        </div>
        {bike && !inHall && <div className="pill">🚲 Bike</div>}
      </div>
      {inHall ? (
        <>
          <div className="location show"><span>{title} · Klaus Atrium</span></div>
          {schedule && (schedule.live.length > 0 || schedule.next) && (
            <div className="now-next" onClick={() => setBoard('schedule')}>
              {schedule.live.length > 0 && (
                <div><b>Now</b> {schedule.live.map((l) => l.item).join(' · ')}</div>
              )}
              {schedule.next && (
                <div><b>Next</b> {schedule.next.item} · {schedule.next.time.split(' – ')[0]}{schedule.next.where ? ` · ${schedule.next.where}` : ''}</div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <LocationSign collider={collider} info={info} />
          <Minimap campus={campus} net={net} info={info} />
        </>
      )}
      <a className="settings-btn" href="/settings" aria-label="Settings" title="Settings">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </a>
      {/* no chat box: agents do the talking */}
      {TOUCH && <Stick />}
      <div className="help">
        <kbd>WASD</kbd> move · <kbd>Shift</kbd> run · {inHall ? <>drag or <kbd>Q</kbd>/<kbd>R</kbd>/<kbd>T</kbd>/<kbd>G</kbd> look · </> : <><kbd>B</kbd> bike · <kbd>M</kbd> map · </>}<kbd>E</kbd> interact · scroll to zoom
      </div>
      {npcChat && !eventOpen && !board && <NpcChat key={npcChat.talk} chat={npcChat} net={net} info={info} onClose={closeNpcChat} />}
      {near && !npcChat && !eventOpen && !board && (
        <div className="dialog" onClick={act}>
          <p>
            {near.kind === 'shell' && <>🐚 A shiny shell at the Klaus entrance! It's glowing with <b>{title}</b> energy…</>}
            {near.kind === 'exit' && <>🐚 Head back out to campus?</>}
            {near.kind === 'spot' && keyHint(near.spot.text)}
            {near.kind === 'table' && keyHint('Grab a seat and start hacking! Press E to see the tracks.')}
          </p>
          {(near.kind !== 'spot' || near.spot.action) && <span className="dialog-hint">{TOUCH ? 'Tap ▼' : 'Press E ▼'}</span>}
        </div>
      )}
      {marks.length > 0 && Date.now() - marks[marks.length - 1].at < 3000 && (
        <div key={`m${marks.length}`} className="photo-toast">
          📍 Mark {marks[marks.length - 1].n} saved ({marks[marks.length - 1].x.toFixed(1)}, {marks[marks.length - 1].z.toFixed(1)})
        </div>
      )}
      {snap > 0 && Date.now() - snap < 2500 && (
        <>
          <div key={`f${snap}`} className="photo-flash" />
          <div key={`t${snap}`} className="photo-toast">📸 Snap! Say “HackGT”!</div>
        </>
      )}
      {eventOpen && <HackGTWelcome event={event} onClose={() => setEventOpen(false)} onEnter={onEnterHall} />}
      {board && event && <InfoBoard event={event} panel={board} onClose={() => setBoard(null)} />}
    </div>
  )
}
