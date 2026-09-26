import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Collider, loadCampus, type Campus } from './map'
import { Net } from './net'
import { World } from './World'
import { Player, type PlayerInfo, type View } from './Player'
import { Remotes } from './Remotes'
import { Hud } from './Hud'
import { Shells } from './Shells'
import { HackGTHall, HallCollider, HALL, HALL_SPAWN, HALL_YAW, PERSON_SCALE, cameraCeiling } from './HackGTHall'
import type { EventInfo } from './HackGTWelcome'

const COLORS = ['#e0564f', '#4f7fd6', '#e89a3c', '#5aa56a', '#9b6bd1', '#d9c24a', '#3fa7b3', '#f06ba8']

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* private mode: fine */
  }
}

function Title({ onStart }: { onStart: (name: string, color: string) => void }) {
  const [name, setName] = useState(() => load('gt.name', ''))
  const [color, setColor] = useState(() => load('gt.color', COLORS[0]))
  return (
    <div className="title">
      <form
        className="title-card"
        onSubmit={(e) => {
          e.preventDefault()
          const n = name.trim() || 'Trainer'
          save('gt.name', n)
          save('gt.color', color)
          onStart(n, color)
        }}
      >
        <div className="title-logo">
          <span>Georgia Tech</span>
          <strong>Campus Quest</strong>
        </div>
        <label>
          Your name
          <input autoFocus value={name} maxLength={16} placeholder="Buzz" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="swatches">
          {COLORS.map((c) => (
            <button
              type="button"
              key={c}
              className={c === color ? 'swatch on' : 'swatch'}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={`cap color ${c}`}
            />
          ))}
        </div>
        <button className="start" type="submit">Start ▸</button>
        <p className="title-hint">Head to the golden beacon at Klaus for HackGT.</p>
      </form>
    </div>
  )
}

function Game({ campus, name, color }: { campus: Campus; name: string; color: string }) {
  const collider = useMemo(() => new Collider(campus), [campus])
  const start = useMemo(() => collider.freeSpot(...campus.spawn), [collider, campus])
  // Created in an effect (not useMemo) so StrictMode's double mount doesn't leave a closed socket.
  const [net, setNet] = useState<Net | null>(null)
  useEffect(() => {
    const n = new Net(name, color, start[0], start[1])
    setNet(n)
    return () => n.close()
  }, [name, color, start])
  const info = useRef<PlayerInfo>({ x: start[0], z: start[1], bike: false })
  const zoom = useRef(34)
  const [eventOpen, setEventOpen] = useState(false)
  const [event, setEvent] = useState<EventInfo | null>(null)
  useEffect(() => {
    fetch('/api/event').then((r) => (r.ok ? r.json() : null)).then(setEvent).catch(() => {})
  }, [])
  const hallCollider = useMemo(() => new HallCollider(), [])
  const [room, setRoom] = useState<'campus' | 'hackgt'>('campus')
  const view = useMemo<View>(
    () =>
      room === 'hackgt'
        ? { mode: 'inside', yaw0: HALL_YAW, scale: PERSON_SCALE, ceiling: cameraCeiling, bounds: [-HALL.w / 2 + 0.8, -HALL.d / 2 + 0.8, HALL.w / 2 - 0.8, HALL.d / 2 - 0.2] }
        : { mode: 'overhead' },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room === 'hackgt'],
  )
  useEffect(() => {
    if (!net) return
    return net.subscribe(() => setRoom(net.room))
  }, [net])
  // Where to put the player back on campus when they leave the hall.
  const returnTo = useRef<[number, number]>(start)

  const enterHall = () => {
    if (!net) return
    returnTo.current = [info.current.x, info.current.z]
    setEventOpen(false)
    info.current.bike = false
    net.enterRoom('hackgt', ...HALL_SPAWN)
    net.correction = { x: HALL_SPAWN[0], z: HALL_SPAWN[1] }
  }
  const leaveHall = () => {
    if (!net) return
    const [x, z] = returnTo.current
    net.enterRoom('campus', x, z)
    net.correction = { x, z }
  }
  useEffect(() => {
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest?.('.chat-log, .modal')) return
      zoom.current = Math.min(110, Math.max(12, zoom.current * (e.deltaY > 0 ? 1.1 : 0.9)))
    }
    window.addEventListener('wheel', wheel, { passive: true })
    return () => window.removeEventListener('wheel', wheel)
  }, [])

  if (!net) return <div className="loading">Connecting…</div>
  return (
    <>
      <Canvas
        shadows
        dpr={[1, 1.5]}
        camera={{ fov: 40, near: 1, far: 1800, position: [start[0], 25, start[1] + 20] }}
      >
        <color attach="background" args={['#bfe6ff']} />
        <fog attach="fog" args={['#bfe6ff', 180, 700]} />
        {/* campus: sky + grass bounce; inside Klaus: warm neutral bounce off the terrazzo */}
        <hemisphereLight
          args={room === 'hackgt' ? ['#fff6e8', '#d8d0c2', 1.05] : ['#dff3ff', '#7faf65', 1.15]}
          key={room}
        />
        <group visible={room === 'campus'}>
          <World campus={campus} onOpenEvent={() => setEventOpen(true)} />
          <Shells campus={campus} info={info} onOpen={() => setEventOpen(true)} active={room === 'campus'} />
        </group>
        <Suspense fallback={null}>
          <HackGTHall active={room === 'hackgt'} />
        </Suspense>
        <Player
          name={name}
          color={color}
          start={start}
          collider={room === 'hackgt' ? hallCollider : collider}
          net={net}
          info={info}
          zoom={zoom}
          view={view}
        />
        <Remotes net={net} scale={room === 'hackgt' ? PERSON_SCALE : 1} />
      </Canvas>
      <Hud
        campus={campus}
        collider={collider}
        net={net}
        info={info}
        eventOpen={eventOpen}
        setEventOpen={setEventOpen}
        event={event}
        room={room}
        onEnterHall={enterHall}
        onLeaveHall={leaveHall}
      />
    </>
  )
}

export default function App() {
  const [campus, setCampus] = useState<Campus | null>(null)
  const [error, setError] = useState('')
  const [who, setWho] = useState<{ name: string; color: string } | null>(null)

  useEffect(() => {
    loadCampus().then(setCampus, (e) => setError(String(e)))
  }, [])

  if (error) return <div className="loading">Couldn't load the campus map: {error}</div>
  if (!who) return <Title onStart={(name, color) => setWho({ name, color })} />
  if (!campus) return <div className="loading">Loading Georgia Tech…</div>
  return (
    <Suspense fallback={<div className="loading">Loading…</div>}>
      <Game campus={campus} name={who.name} color={who.color} />
    </Suspense>
  )
}
