import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import { Collider, loadCampus, type Campus } from './map'
import { Net } from './net'
import { World } from './World'
import { Player, type PlayerInfo, type View } from './Player'
import { Remotes } from './Remotes'
import { Hud } from './Hud'
import { Shells } from './Shells'
import { CALIBRATION_SPOTS, HackGTHall, HallCollider, HALL_BOUNDS, HALL_SPAWN, HALL_YAW, PERSON_SCALE, cameraCeiling } from './HackGTHall'
import { toHall, useLiveLocation, type GeoCfg } from './geo'
import { Calibrate, LivePill } from './LiveLocation'
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
        ? { mode: 'inside', yaw0: HALL_YAW, spawn: HALL_SPAWN, scale: PERSON_SCALE, ceiling: cameraCeiling, bounds: [HALL_BOUNDS[0] + 0.8, HALL_BOUNDS[1] + 0.8, HALL_BOUNDS[2] - 0.8, HALL_BOUNDS[3] - 0.2] }
        : { mode: 'overhead' },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room === 'hackgt'],
  )
  useEffect(() => {
    if (!net) return
    return net.subscribe(() => setRoom(net.room))
  }, [net])
  // Live location (GPS only): where you really are drives your avatar.
  // Beta mode (the default) = move with the keys, no GPS. Turn beta off → live GPS positioning.
  const [live, setLive] = useState(() => load('gt.gps', false))
  const { fix, status } = useLiveLocation(live && room === 'hackgt')
  const [geoCfg, setGeoCfg] = useState<GeoCfg | null>(null)
  useEffect(() => {
    fetch('/api/geo')
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => setGeoCfg(load<GeoCfg | null>('gt.geo', null) ?? c))
      .catch(() => {})
  }, [])
  const gps = useRef<{ x: number; z: number } | null>(null)
  const [where, setWhere] = useState<'in' | 'out' | null>(null)
  useEffect(() => {
    // Live location is only used inside the Klaus atrium; campus is always keys.
    if (room !== 'hackgt' || !live || !fix || fix.acc > 60 || !geoCfg) {
      gps.current = null
      setWhere(null)
      return
    }
    let [x, z] = toHall(geoCfg, fix.lat, fix.lon)
    const b = HALL_BOUNDS
    const slack = 12 // indoor GPS drifts; allow a little outside the walls
    if (x < b[0] - slack || x > b[2] + slack || z < b[1] - slack || z > b[3] + slack) {
      gps.current = null
      setWhere('out')
      return
    }
    x = Math.min(b[2] - 1, Math.max(b[0] + 1, x))
    z = Math.min(b[3] - 1, Math.max(b[1] + 1, z))
    // smooth out jitter; big jumps (new room, first fix) go straight through
    const prev = gps.current
    gps.current = prev && Math.hypot(prev.x - x, prev.z - z) < 15 ? { x: prev.x + (x - prev.x) * 0.5, z: prev.z + (z - prev.z) * 0.5 } : { x, z }
    setWhere('in')
  }, [fix, live, room, geoCfg])
  useEffect(() => {
    gps.current = null // re-place on the next fix after changing rooms
  }, [room])
  // Send what the device reports to the server so the atrium can be mapped from
  // real coordinates (and so we can see why live location isn't moving someone).
  const lastSample = useRef(0)
  useEffect(() => {
    if (room !== 'hackgt' || !live) return
    const now = Date.now()
    if (now - lastSample.current < 2000 && status === 'live') return
    lastSample.current = now
    const hall = fix && geoCfg ? toHall(geoCfg, fix.lat, fix.lon) : null
    postSample({ name, status, lat: fix?.lat, lon: fix?.lon, acc: fix?.acc, hall })
  }, [fix, status, live, room, geoCfg, name])
  const calibrating = useMemo(() => new URLSearchParams(location.search).has('calibrate'), [])

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
          args={room === 'hackgt' ? ['#fff6ea', '#cfc8ba', 1.6] : ['#e8f2ff', '#7faf65', 1.1]}
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
          gps={gps}
        />
        <Remotes net={net} scale={room === 'hackgt' ? PERSON_SCALE : 1} />
        {/* glow on lights, screens and signs; soft vignette to frame the shot */}
        <EffectComposer multisampling={4}>
          <Bloom mipmapBlur intensity={room === 'hackgt' ? 0.45 : 0.25} luminanceThreshold={0.96} luminanceSmoothing={0.05} />
          <Vignette offset={0.3} darkness={0.55} />
        </EffectComposer>
      </Canvas>
      <Cinematic />
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
      <div className="live-ui">
        {room === 'hackgt' && <LivePill
          live={live}
          status={status}
          fix={fix}
          where={where}
          room={room}
          onToggle={() => {
            save('gt.gps', !live)
            setLive(!live)
          }}
        />}
        {calibrating && room === 'hackgt' && (
          <Calibrate
            fix={fix}
            spots={CALIBRATION_SPOTS}
            onMark={(label) => fix && postSample({ name, label, status, lat: fix.lat, lon: fix.lon, acc: fix.acc })}
            onApply={(c) => {
              save('gt.geo', c)
              setGeoCfg(c)
            }}
          />
        )}
      </div>
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

function postSample(s: Record<string, unknown>) {
  fetch('/api/geo/samples', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...s, t: new Date().toISOString(), ua: navigator.userAgent.slice(0, 80) }),
  }).catch(() => {})
}

/** Letterbox bars + title card while the atrium fly-through plays. */
function Cinematic() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const h = (e: Event) => setOn((e as CustomEvent<boolean>).detail)
    window.addEventListener('cinematic', h)
    return () => window.removeEventListener('cinematic', h)
  }, [])
  return (
    <div className={on ? 'cine on' : 'cine'} aria-hidden={!on}>
      <div className="cine-bar top" />
      <div className="cine-bar bottom" />
      <div className="cine-title">
        <small>Welcome to</small>
        <strong>HackGT 13</strong>
        <span>Klaus Advanced Computing Building · Seaside Market</span>
      </div>
      <div className="cine-skip">Press any key to skip</div>
    </div>
  )
}
