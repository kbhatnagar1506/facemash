import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import { Bloom, EffectComposer, N8AO, SMAA, Vignette } from '@react-three/postprocessing'
import { Collider, loadCampus, type Campus } from './map'
import { Net } from './net'
import { World } from './World'
import { Player, type PlayerInfo, type View } from './Player'
import { Remotes } from './Remotes'
import { requestMotion, useMotion } from './motion'
import { defaultLook, encodeLook, loadLook } from './look'
import { Hud } from './Hud'
import { Shells } from './Shells'
import { CALIBRATION_SPOTS, HallCollider, HALL_BOUNDS, HALL_SPAWN, HALL_YAW, PERSON_SCALE, cameraCeiling, eastX, westX } from './hall/layout'
// the Klaus hall is big: it downloads in its own chunk, only once you're near Klaus
const HackGTHall = lazy(() => import('./HackGTHall').then((m) => ({ default: m.HackGTHall })))
import { toHall, useLiveLocation, type GeoCfg } from './geo'
import { Calibrate, LivePill, MotionPill } from './LiveLocation'
import type { EventInfo } from './HackGTWelcome'

const COLORS = ['#e0564f', '#4f7fd6', '#e89a3c', '#5aa56a', '#9b6bd1', '#d9c24a', '#3fa7b3', '#f06ba8']

const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

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
        <a className="bean-link" href="/avatar">✨ Make your bean</a>
        <p className="title-hint">Head to the golden beacon at Klaus for HackGT.</p>
      </form>
    </div>
  )
}

function Game({ campus, name, color }: { campus: Campus; name: string; color: string }) {
  // your bean from /avatar (or a default bean in your colour)
  const myLook = useMemo(() => loadLook() ?? defaultLook(color), [color])
  const collider = useMemo(() => new Collider(campus), [campus])
  const start = useMemo(() => collider.freeSpot(...campus.spawn), [collider, campus])
  // Created in an effect (not useMemo) so StrictMode's double mount doesn't leave a closed socket.
  const [net, setNet] = useState<Net | null>(null)
  useEffect(() => {
    const n = new Net(name, color, start[0], start[1], encodeLook(myLook))
    setNet(n)
    return () => n.close()
  }, [name, color, start, myLook])
  const info = useRef<PlayerInfo>({ x: start[0], z: start[1], bike: false })
  const zoom = useRef(34)
  const [eventOpen, setEventOpen] = useState(false)
  const [event, setEvent] = useState<EventInfo | null>(null)
  useEffect(() => {
    fetch('/api/event').then((r) => (r.ok ? r.json() : null)).then(setEvent).catch(() => {})
  }, [])
  const hallCollider = useMemo(() => new HallCollider(), [])
  const [room, setRoom] = useState<'campus' | 'hackgt'>('campus')
  // rendering quality (see <PerformanceMonitor>)
  const [dpr, setDpr] = useState(() => Math.min(1.5, window.devicePixelRatio))
  const [lite, setLite] = useState(false)
  // The hall loads (and pre-compiles) once you get within 300 m of Klaus, then stays.
  const [hallWanted, setHallWanted] = useState(false)
  useEffect(() => {
    if (hallWanted) return
    const ev = campus.event
    const check = () => {
      const near = !ev || Math.hypot(info.current.x - ev.center[0], info.current.z - ev.center[1]) < 300
      if (near || room === 'hackgt') setHallWanted(true)
    }
    check()
    const t = setInterval(check, 1000)
    return () => clearInterval(t)
  }, [hallWanted, room, campus])
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
  const [where, setWhere] = useState<'in' | 'out' | 'stuck' | null>(null)
  // A small Kalman filter over the GPS fixes, in hall metres: each fix counts in
  // proportion to its accuracy, the estimate is allowed to drift at walking speed
  // between fixes, and jumps a person couldn't make (indoor multipath) are ignored
  // unless they persist.
  const kf = useRef<{ x: number; z: number; p: number; t: number; rejects: number } | null>(null)
  const lastMeas = useRef('')
  const sticky = useRef(new Map<string, { n: number; at: number }>())
  useEffect(() => {
    // Live location is only used inside the Klaus atrium; campus is always keys.
    if (room !== 'hackgt' || !live || !fix || fix.acc > 60 || !geoCfg) {
      gps.current = null
      if (room !== 'hackgt' || !live) kf.current = null
      setWhere(null)
      return
    }
    // frozen GPS (same position for >10 s): hand control back to the keys until it moves
    if (fix.since && Date.now() - fix.since > 10000) {
      // steps keep tracking you through a GPS freeze; without them, the keys take over
      if (motionActive.current && kf.current) setWhere('in')
      else {
        gps.current = null
        setWhere('stuck')
      }
      return
    }
    let [x, z] = toHall(geoCfg, fix.lat, fix.lon)
    const b = HALL_BOUNDS
    const slack = 12 // indoor GPS drifts; allow a little outside the walls
    if (x < b[0] - slack || x > b[2] + slack || z < b[1] - slack || z > b[3] + slack) {
      gps.current = null
      kf.current = null
      setWhere('out')
      return
    }
    // keep it inside the building: between the (angled) west and east walls, off the end walls
    z = Math.min(b[3] - 1, Math.max(b[1] + 1, z))
    x = Math.min(eastX(z) - 0.9, Math.max(westX(z) + 0.9, x))
    // A reading identical to the last one carries no new information (iOS replays cached
    // fixes), and a coordinate that keeps coming back exactly is a cached Wi-Fi location:
    // ignore it for a minute. With steps + compass on, GPS only nudges (and only good fixes).
    const key = `${fix.lat},${fix.lon}`
    const seen = sticky.current
    seen.set(key, { n: (seen.get(key)?.n ?? 0) + 1, at: Date.now() })
    for (const [kk, v] of seen) if (Date.now() - v.at > 60000) seen.delete(kk)
    if (key === lastMeas.current || (seen.get(key)?.n ?? 0) >= 3) {
      if (kf.current) setWhere('in')
      return
    }
    lastMeas.current = key
    if (motionActive.current && kf.current && fix.acc > 15) {
      setWhere('in')
      return
    }
    const r = fix.acc * fix.acc * (motionActive.current ? 2 : 1) // measurement variance (m²)
    const k = kf.current
    if (!k) kf.current = { x, z, p: r, t: fix.at, rejects: 0 }
    else {
      const dt = Math.max(0.2, (fix.at - k.t) / 1000)
      // you can have walked up to ~1.6 m/s since the last fix (steps already moved us if motion is on)
      k.p += motionActive.current ? 0.3 + (0.5 * dt) ** 2 : (1.6 * dt) ** 2 + 0.5
      const d = Math.hypot(x - k.x, z - k.z)
      const implausible = d > 3 * Math.sqrt(k.p + r) && d / dt > 3
      if (implausible && k.rejects < 3) {
        k.rejects++ // a multipath spike: skip it
      } else {
        if (implausible) k.p = r // it kept saying so: you really moved, re-anchor
        const g = k.p / (k.p + r)
        k.x += (x - k.x) * g
        k.z += (z - k.z) * g
        k.p *= 1 - g
        k.rejects = 0
        learn.current.onGps(x, z, fix.acc)
      }
      k.t = fix.at
    }
    const e = kf.current!
    gps.current = { x: Math.min(eastX(e.z) - 0.9, Math.max(westX(e.z) + 0.9, e.x)), z: e.z }
    setWhere('in')
  }, [fix, live, room, geoCfg])
  // Motion sensors (optional boost): each step moves the filtered position along the
  // compass heading, so your bean follows you instantly between GPS fixes; GPS keeps
  // correcting the drift. The compass bias and your stride length are learned on the
  // fly by comparing the step path with the GPS path over the last ~15 m.
  const [motionOn, setMotionOn] = useState(() => load('gt.motion', false))
  const motionActive = useRef(false)
  const motionStatusRef = useRef('off')
  const stepCount = useRef(0)
  const learn = useRef({
    bias: 0, // compass correction (radians)
    stride: 0.7, // metres per step
    gps0: null as null | [number, number],
    pdr: [0, 0] as [number, number],
    onGps(x: number, z: number, acc: number) {
      if (acc > 18 || !motionActive.current) return
      if (!this.gps0) {
        this.gps0 = [x, z]
        this.pdr = [0, 0]
        return
      }
      const gx = x - this.gps0[0]
      const gz = z - this.gps0[1]
      const gd = Math.hypot(gx, gz)
      const pd = Math.hypot(this.pdr[0], this.pdr[1])
      if (gd < 15 || pd < 12) return
      // how far off the step path's direction and length are from what GPS saw
      const diff = Math.atan2(this.pdr[0] * gz - this.pdr[1] * gx, this.pdr[0] * gx + this.pdr[1] * gz)
      this.bias += clampN(diff, -0.6, 0.6) * 0.3
      this.stride = clampN(this.stride * (1 + 0.3 * (gd / pd - 1)), 0.45, 1.0)
      this.gps0 = [x, z]
      this.pdr = [0, 0]
    },
  })
  const onStep = (headingDeg: number) => {
    stepCount.current++
    const k = kf.current
    if (!k || !geoCfg || room !== 'hackgt') return
    // which way is compass north / east in the hall's coordinates (from the GPS alignment);
    // works from the door anchor even before the first GPS fix arrives
    const ref = fix ?? { lat: 33.7771, lon: -84.3963 }
    const [x0, z0] = toHall(geoCfg, ref.lat, ref.lon)
    const [xn, zn] = toHall(geoCfg, ref.lat + 1e-5, ref.lon)
    const [xe, ze] = toHall(geoCfg, ref.lat, ref.lon + 1e-5)
    const nl = Math.hypot(xn - x0, zn - z0) || 1
    const el = Math.hypot(xe - x0, ze - z0) || 1
    const h = (headingDeg * Math.PI) / 180 + learn.current.bias
    const L = learn.current.stride
    const dx = (((xn - x0) / nl) * Math.cos(h) + ((xe - x0) / el) * Math.sin(h)) * L
    const dz = (((zn - z0) / nl) * Math.cos(h) + ((ze - z0) / el) * Math.sin(h)) * L
    k.x += dx
    k.z += dz
    k.p += (0.3 * L) ** 2 // each step adds a little uncertainty
    learn.current.pdr[0] += dx
    learn.current.pdr[1] += dz
    const zc = Math.min(HALL_BOUNDS[3] - 1, Math.max(HALL_BOUNDS[1] + 1, k.z))
    k.z = zc
    k.x = Math.min(eastX(zc) - 0.9, Math.max(westX(zc) + 0.9, k.x))
    gps.current = { x: k.x, z: k.z }
  }
  const motionStatus = useMotion(live && room === 'hackgt' && motionOn, onStep)
  motionActive.current = motionStatus === 'on'
  motionStatusRef.current = motionStatus
  const enableMotion = async () => {
    const ok = await requestMotion()
    setMotionOn(ok)
    save('gt.motion', ok)
  }

  useEffect(() => {
    // Walking in through the main doors is a perfect anchor (like Doorstep's entrance
    // detection): start tracking from exactly there, then steps + GPS take over.
    if (room === 'hackgt') {
      kf.current = { x: HALL_SPAWN[0], z: HALL_SPAWN[1], p: 2, t: Date.now(), rejects: 0 }
      gps.current = null
    } else {
      kf.current = null
      gps.current = null
    }
    lastMeas.current = ''
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
    const k = kf.current
    postSample({
      name, status, lat: fix?.lat, lon: fix?.lon, acc: fix?.acc, hall,
      est: k ? [+k.x.toFixed(2), +k.z.toFixed(2), +Math.sqrt(k.p).toFixed(1)] : null,
      motion: motionStatusRef.current, steps: stepCount.current,
      stride: +learn.current.stride.toFixed(2), bias: +((learn.current.bias * 180) / Math.PI).toFixed(0),
      where,
    })
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
        shadows="soft"
        dpr={dpr}
        onCreated={({ gl, scene }) => {
          // ?perf: expose the renderer for live profiling from the console
          if (location.search.includes('perf')) Object.assign(window, { __gl: gl, __scene: scene })
        }}
        camera={{ fov: 40, near: 1, far: 800, position: [start[0], 25, start[1] + 20] }}
      >
        <color attach="background" args={['#bfe6ff']} />
        <fog attach="fog" args={['#bfe6ff', 180, 700]} />
        {/* campus: sky + grass bounce; inside Klaus: warm neutral bounce off the terrazzo */}
        <hemisphereLight
          args={room === 'hackgt' ? ['#fff6ea', '#cfc8ba', 1.45] : ['#e8f2ff', '#7faf65', 1.1]}
          key={room}
        />
        {/* inside Klaus: the mezzanine's downlights, as a soft shadowless top light so the
            lobby under the low ceiling isn't left dim when the sun can't reach it */}
        {room === 'hackgt' && <directionalLight position={[-6, 30, 30]} intensity={0.55} color="#fff3e2" />}
        <group visible={room === 'campus'}>
          <World campus={campus} onOpenEvent={() => setEventOpen(true)} focus={info} active={room === 'campus'} />
          <Shells campus={campus} info={info} onOpen={() => setEventOpen(true)} active={room === 'campus'} />
        </group>
        {hallWanted && (
          <Suspense fallback={null}>
            <HackGTHall active={room === 'hackgt'} />
          </Suspense>
        )}
        <Player
          name={name}
          color={color}
          look={myLook}
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
        {/* A fresh composer per room: indoors adds ambient occlusion, which reads the depth
            buffer and can't share it with a multisampled target (that blit fails and freezes
            the frame), so the hall uses SMAA for edges instead of MSAA. */}
        {/* Adaptive quality: if frames start dropping, render at a lower pixel ratio (and drop
            ambient occlusion); climb back up when there's headroom. Keeps it smooth everywhere. */}
        <PerformanceMonitor
          bounds={() => [45, 58]}
          flipflops={4}
          onDecline={() => {
            setDpr(1)
            setLite(true)
          }}
          onIncline={() => {
            setDpr(Math.min(1.5, window.devicePixelRatio))
            setLite(false)
          }}
          onFallback={() => {
            setDpr(1)
            setLite(true)
          }}
        />
        {room === 'hackgt' ? (
          <EffectComposer key={lite ? 'hall-lite' : 'hall'} multisampling={0}>
            {lite ? <></> : <N8AO halfRes quality="performance" aoRadius={1.4} distanceFalloff={0.6} intensity={2.6} color="#2a2420" />}
            <Bloom mipmapBlur intensity={0.35} luminanceThreshold={0.99} luminanceSmoothing={0.03} />
            <Vignette offset={0.3} darkness={0.55} />
            <SMAA />
          </EffectComposer>
        ) : (
          <EffectComposer key="campus" multisampling={dpr > 1.2 ? 2 : 4}>
            <Bloom mipmapBlur intensity={0.25} luminanceThreshold={0.99} luminanceSmoothing={0.03} />
            <Vignette offset={0.3} darkness={0.55} />
          </EffectComposer>
        )}
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
        {room === 'hackgt' && live && status === 'live' && <MotionPill status={motionStatus} wanted={motionOn} onEnable={enableMotion} />}
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
      <div className="cine-skip">Esc or click to skip</div>
    </div>
  )
}
