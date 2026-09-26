import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { Avatar, type AvatarState } from './Avatar'
import type { Net } from './net'
import { cutawayUniforms } from './cutaway'

const WALK = 7
const RUN = 14
const BIKE = 24 // the Go server allows up to 30 m/s
const SEND_HZ = 15

export interface PlayerInfo {
  x: number
  z: number
  y?: number
  bike: boolean
}

const keys = new Set<string>()
function typing() {
  const el = document.activeElement
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
}

/**
 * 'overhead': the classic top-down campus camera.
 * 'inside': third-person camera down in the room behind the player; drag or Q/E to turn,
 * WASD moves relative to where the camera looks. `bounds` keeps it inside the walls.
 */
export type View =
  | { mode: 'overhead' }
  | {
      mode: 'inside'
      bounds: [number, number, number, number]
      yaw0: number
      ceiling?: (x: number, z: number, y: number) => number
      /** Draw people smaller so the building reads at true size; speed and camera follow. */
      scale?: number
      /** Where you appear in this room (the cinematic lands behind you here). */
      spawn?: [number, number]
    }

export function Player({
  name, color, start, collider, net, info, zoom, view, gps,
}: {
  view: View
  /** Where the player really is (from GPS), in this room's coordinates; drives movement when set. */
  gps?: React.MutableRefObject<{ x: number; z: number } | null>
  name: string
  color: string
  start: [number, number]
  /**
   * `surface`, when present, makes the world multi-level: it returns the floor height
   * the player would stand on at (x, z) coming from height y, or null if they can't go there.
   */
  collider: {
    blocked(x: number, z: number, r?: number): boolean
    surface?(x: number, z: number, y: number, hop?: boolean): number | null
    /** True over tables/chairs/booths, which the player hops over instead of stopping. */
    furniture?(x: number, z: number): boolean
  }
  net: Net
  info: React.MutableRefObject<PlayerInfo>
  zoom: React.MutableRefObject<number>
}) {
  const group = useRef<THREE.Group>(null!)
  const state = useRef<AvatarState>({ moving: false })
  const pos = useRef(new THREE.Vector2(...start))
  const facing = useRef(0)
  const height = useRef(0) // floor height under the player (stairs/balcony)
  const hop = useRef(0) // 0 = on the ground; (0, 1] = mid-jump over furniture
  const hopLen = useRef(1) // metres this jump has to cover (sized to the obstacle)
  const hopDir = useRef<[number, number]>([0, 1]) // direction of travel when the jump started
  const sendAcc = useRef(0)
  const light = useRef<THREE.DirectionalLight>(null!)
  const yaw = useRef(0) // camera heading in 'inside' view; 0 = camera south of player looking north
  const pitch = useRef(0) // look up (+) / down (-) in the 'inside' view
  const intro = useRef(-1) // cinematic fly-through progress 0..1 when entering the hall; -1 = off
  const introPath = useRef<{ pos: THREE.CatmullRomCurve3; look: THREE.CatmullRomCurve3; T: Float32Array } | null>(null)
  const introLook = useRef(new THREE.Vector3())
  const snap = useRef(false)
  const lean = useRef(0)
  const puff = useRef<THREE.Mesh>(null!)
  const confetti = useRef<ConfettiHandle>(null)
  const puffT = useRef(1) // landing dust ring, 0..1
  const { camera, scene, gl } = useThree()

  // Switching views: reset heading, and let the inside camera get close without clipping.
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    if (view.mode === 'inside') {
      yaw.current = view.yaw0
      pitch.current = 0
      facing.current = view.yaw0 + Math.PI // face away from the camera, into the room
      cam.near = 0.1
      cam.fov = 60
      // Cinematic sweep through the atrium on the way in (any key or click skips it).
      const q = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
      const path = {
        // in low under the mezzanine and up to a top shot of the whole atrium, held at
        // the end; then a straight cut to the camera behind you
        pos: new THREE.CatmullRomCurve3(
          [q(17, 3.2, 23), q(9, 3.3, 9), q(5, 3.8, 0), q(3, 11, -1), q(2, 17, 1.5), q(-0.5, 17.3, 1)],
          false,
          'centripetal',
        ),
        look: new THREE.CatmullRomCurve3(
          [q(0, 3, 12), q(0, 3, -8), q(1, 4, -14), q(1, 1, -12), q(1, 0, -13), q(0, 0, -13.5)],
          false,
          'centripetal',
        ),
      }
      introPath.current = { ...path, T: glideTiming(path.pos, 1) }
      introLook.current.copy(path.look.getPoint(0))
      intro.current = 0
      window.dispatchEvent(new CustomEvent('cinematic', { detail: true }))
    } else {
      cam.near = 1
      cam.fov = 40
      yaw.current = 0 // campus: camera south of you, north up, until you turn it
      // left the hall mid-cinematic: stop it and drop the letterbox
      intro.current = -1
      window.dispatchEvent(new CustomEvent('cinematic', { detail: false }))
    }
    cam.updateProjectionMatrix()
  }, [view, camera])

  // Skip the cinematic deliberately (Esc / Space / Enter or a click), never by a held
  // movement key or the E you pressed to walk in, and not in its first half second.
  useEffect(() => {
    const skip = () => {
      if (intro.current > 0.1) intro.current = 1
    }
    const key = (e: KeyboardEvent) => {
      if (!e.repeat && (e.code === 'Escape' || e.code === 'Space' || e.code === 'Enter')) skip()
    }
    window.addEventListener('keydown', key)
    window.addEventListener('pointerdown', skip)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('pointerdown', skip)
    }
  }, [])

  // Drag to look around (inside: turn + tilt; campus: turn the overhead camera).
  useEffect(() => {
    const inside = view.mode === 'inside'
    const el = gl.domElement
    // Only drags that start on the 3D view turn the camera, and only while a
    // button is actually held (checked per event, so it can never get stuck).
    let armed = false
    const downH = () => (armed = true)
    const move = (e: PointerEvent) => {
      if (!(e.buttons & 1)) armed = false
      else if (armed) {
        yaw.current -= e.movementX * 0.006
        if (inside) pitch.current = Math.max(-0.6, Math.min(1.3, pitch.current - e.movementY * 0.006)) // drag up = look up
      }
    }
    el.addEventListener('pointerdown', downH)
    window.addEventListener('pointermove', move)
    return () => {
      el.removeEventListener('pointerdown', downH)
      window.removeEventListener('pointermove', move)
    }
  }, [view, gl])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typing()) return
      keys.add(e.code)
      if (e.code === 'KeyB') info.current.bike = !info.current.bike
    }
    const up = (e: KeyboardEvent) => keys.delete(e.code)
    const blur = () => keys.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [info])

  useEffect(() => {
    scene.add(light.current.target)
  }, [scene])

  /** Measure how far the furniture ahead runs along the travel direction, and jump that far. */
  const startHop = (x: number, z: number) => {
    const [ux, uz] = hopDir.current
    let d = 0
    while (d < 12 && collider.furniture?.(x + ux * d, z + uz * d)) d += 0.1
    // Only jump if there's clear floor to land on (not a wall right behind the table).
    const land = d + 0.5
    if (collider.surface?.(x + ux * land, z + uz * land, height.current) == null) return false
    hopLen.current = Math.max(0.8, land)
    hop.current = 0.001
    return true
  }

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const p = pos.current

    if (net.correction) {
      p.set(net.correction.x, net.correction.z)
      height.current = 0
      net.correction = null
    }

    // Live location: walk (or, if far off, jump) to where you really are; keys are off.
    const goal = gps?.current
    let gpsDist = 0
    if (goal) {
      const walkable = (x: number, z: number) => (collider.surface ? collider.surface(x, z, 0) === 0 : !collider.blocked(x, z))
      gpsDist = Math.hypot(goal.x - p.x, goal.z - p.y)
      if (gpsDist > 25 || (height.current > 0.5 && gpsDist > 0.7)) {
        const [fx, fz] = nearestWalkable(walkable, goal.x, goal.z)
        p.set(fx, fz)
        height.current = 0
        gpsDist = 0
      }
    }

    let dx = 0
    let dz = 0
    if (intro.current >= 0) {
      // no walking while the cinematic plays
    } else if (goal) {
      if (gpsDist > 0.7) {
        dx = (goal.x - p.x) / gpsDist
        dz = (goal.z - p.y) / gpsDist
      }
    } else if (!typing()) {
      if (keys.has('KeyW') || keys.has('ArrowUp')) dz -= 1
      if (keys.has('KeyS') || keys.has('ArrowDown')) dz += 1
      if (keys.has('KeyA') || keys.has('ArrowLeft')) dx -= 1
      if (keys.has('KeyD') || keys.has('ArrowRight')) dx += 1
    }
    const inside = view.mode === 'inside'
    if (!typing()) {
      if (keys.has('KeyQ')) yaw.current += dt * 2.2
      if (keys.has('KeyR')) yaw.current -= dt * 2.2
    }
    if (inside && !typing()) {
      if (keys.has('KeyT')) pitch.current = Math.min(1.3, pitch.current + dt * 1.2)
      if (keys.has('KeyG')) pitch.current = Math.max(-0.6, pitch.current - dt * 1.2)
    }
    if (!goal && (dx || dz)) {
      // Rotate input into camera space so W always walks away from the camera.
      const c = Math.cos(yaw.current)
      const sn = Math.sin(yaw.current)
      const ix = dx
      const iz = dz
      dx = ix * c + iz * sn
      dz = -ix * sn + iz * c
    }
    const moving = dx !== 0 || dz !== 0
    if (moving && hop.current === 0) {
      const len = Math.hypot(dx, dz)
      const k = view.mode === 'inside' ? (view.scale ?? 1) * 0.8 : 1 // indoor pace, relative to your size
      const running = goal ? gpsDist > 6 : keys.has('ShiftLeft') || keys.has('ShiftRight')
      const speed = (info.current.bike && !goal && view.mode !== 'inside' ? BIKE : running ? RUN : WALK) * k
      const step = goal ? Math.min(speed * dt, gpsDist) : speed * dt
      const sx = (dx / len) * step
      const sz = (dz / len) * step
      // Slide along walls: try the full step, then each axis on its own.
      const tryMove = (nx: number, nz: number) => {
        if (collider.surface) {
          // Already standing inside furniture (e.g. spawned there)? Let them walk out freely.
          const stuck = collider.furniture?.(p.x, p.y) ?? false
          let h = collider.surface(nx, nz, height.current, hop.current > 0 || stuck)
          // Walked into a table/chair/booth on the ground: jump and pass over it.
          if (h === null && hop.current === 0 && height.current < 0.1 && collider.furniture?.(nx, nz)) {
            h = collider.surface(nx, nz, height.current, true)
            if (h !== null) {
              const L = Math.hypot(nx - p.x, nz - p.y) || 1
              hopDir.current = [(nx - p.x) / L, (nz - p.y) / L]
              if (!startHop(nx, nz)) h = null // nowhere to land: it blocks like a wall
            }
          }
          if (h === null) return false
          height.current = h
        } else if (collider.blocked(nx, nz)) return false
        p.set(nx, nz)
        return true
      }
      if (!tryMove(p.x + sx, p.y + sz) && !tryMove(p.x + sx, p.y)) tryMove(p.x, p.y + sz)
      const target = Math.atan2(dx, dz)
      let diff = target - facing.current
      diff = Math.atan2(Math.sin(diff), Math.cos(diff))
      facing.current += diff * Math.min(1, dt * 14)
      // lean into turns (and a touch forward when sprinting)
      lean.current += (THREE.MathUtils.clamp(-diff * 0.6, -0.35, 0.35) - lean.current) * Math.min(1, dt * 10)
    }
    state.current.moving = moving

    const bubble = net.bubbles.get(net.myId)
    state.current.bubble = bubble && performance.now() - bubble.at < 6000 ? bubble.text : undefined

    if (!collider.surface) height.current = 0
    // Hop arc sized to the obstacle; if we come down still on furniture, jump again.
    const ps = view.mode === 'inside' ? (view.scale ?? 1) : 1
    if (hop.current > 0) {
      const airSpeed = Math.max(RUN * ps * 0.8, 3) // clear it at a brisk pace even if you let go
      hop.current += (airSpeed * dt) / hopLen.current
      {
        // mid-air: carry across along the jump, so one jump clears the whole obstacle
        const [ux, uz] = hopDir.current
        const nx = p.x + ux * airSpeed * dt
        const nz = p.y + uz * airSpeed * dt
        if (collider.surface?.(nx, nz, height.current, true) != null) p.set(nx, nz)
        else hop.current = Math.max(hop.current, 0.999) // hit a wall mid-jump: come down
      }
      if (hop.current >= 1) {
        hop.current = 0
        puffT.current = 0 // landing: kick up a puff
        // came down on furniture: jump on only if there's somewhere to land; else walk out
        if (collider.furniture?.(p.x, p.y)) startHop(p.x, p.y)
      }
    }
    const hopHeight = Math.min(2.6, 0.55 + 0.3 * hopLen.current) * ps // bigger obstacle, bigger jump
    const lift = hop.current > 0 ? Math.sin(hop.current * Math.PI) * hopHeight : 0
    group.current.position.set(p.x, height.current + lift, p.y)
    group.current.scale.setScalar(view.mode === 'inside' ? (view.scale ?? 1) : 1)
    group.current.rotation.y = facing.current
    lean.current *= moving ? 1 : Math.max(0, 1 - dt * 8)
    group.current.rotation.z = lean.current
    // landing dust ring
    if (puffT.current < 1) {
      puffT.current = Math.min(1, puffT.current + dt * 2.2)
      const k = puffT.current
      puff.current.visible = true
      puff.current.position.set(p.x, height.current + 0.03, p.y)
      puff.current.scale.setScalar((0.4 + k * 1.6) * ps)
      ;(puff.current.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k)
    } else puff.current.visible = false
    // sprint camera: widen the view a little when running (the cinematic sets its own lens)
    if (intro.current < 0) {
      const cam = camera as THREE.PerspectiveCamera
      const base = view.mode === 'inside' ? 60 : 40
      const running = moving && (keys.has('ShiftLeft') || keys.has('ShiftRight') || hop.current > 0)
      const want = base + (running ? (view.mode === 'inside' ? 8 : 4) : 0)
      if (Math.abs(cam.fov - want) > 0.05) {
        cam.fov += (want - cam.fov) * Math.min(1, dt * 5)
        cam.updateProjectionMatrix()
      }
    }
    cutawayUniforms.uPlayer.value.set(p.x, 0, p.y)
    info.current.x = p.x
    info.current.z = p.y
    info.current.y = height.current

    if (intro.current >= 0 && introPath.current) {
      // Cinematic: an even glide along the path (arc-length timed, eased at both ends,
      // slowing into the top shot), with the aim following smoothly.
      intro.current = Math.min(1, intro.current + dt / 5)
      const { pos, look, T } = introPath.current
      const u = timeToU(T, intro.current)
      const prm = pos.getUtoTmapping(u, 0)
      camera.position.copy(pos.getPoint(prm))
      introLook.current.lerp(look.getPoint(prm), 1 - Math.exp(-dt * 5))
      camera.lookAt(introLook.current)
      // a slow lens push-in over the flight, and a gentle bank through the climb
      const cam = camera as THREE.PerspectiveCamera
      const e = intro.current * intro.current * (3 - 2 * intro.current)
      cam.fov = 66 - 12 * e
      cam.updateProjectionMatrix()
      camera.rotateZ(Math.sin(Math.PI * u) * 0.07)
      if (intro.current >= 1) {
        intro.current = -1
        snap.current = true // hard cut to the player camera
        // and a celebratory confetti pop around you as you arrive
        confetti.current?.burst(p.x, height.current, p.y, view.mode === 'inside' ? (view.scale ?? 1) : 1)
        window.dispatchEvent(new CustomEvent('cinematic', { detail: false }))
      }
    } else if (view.mode === 'inside') {
      // Third-person, down in the room: behind and a little above the player.
      const ps = view.scale ?? 1
      const dist = THREE.MathUtils.clamp(zoom.current / 5, 3, 12) * ps
      const sn = Math.sin(yaw.current)
      const c = Math.cos(yaw.current)
      const [x0, z0, x1, z1] = view.bounds
      const want = new THREE.Vector3(
        THREE.MathUtils.clamp(p.x + sn * dist, x0, x1),
        height.current + 1.6 * ps + dist * 0.42 - Math.max(0, pitch.current) * dist * 0.3,
        THREE.MathUtils.clamp(p.y + c * dist, z0, z1),
      )
      if (view.ceiling) want.y = Math.min(want.y, view.ceiling(want.x, want.z, height.current))
      if (snap.current) {
        camera.position.copy(want)
        snap.current = false
      } else camera.position.lerp(want, 1 - Math.exp(-dt * 8))
      // pitch tilts the view: up toward the balconies and ceiling, down to the floor
      camera.lookAt(p.x - sn * 3 * ps, height.current + 1.5 * ps + pitch.current * 6, p.y - c * 3 * ps)
    } else {
      // Overhead camera: fixed pitch, follows smoothly, turns with Q/R or a drag.
      const d = zoom.current
      const sn = Math.sin(yaw.current)
      const c = Math.cos(yaw.current)
      const want = new THREE.Vector3(p.x + sn * d * 0.6, d, p.y + c * d * 0.6)
      camera.position.lerp(want, 1 - Math.exp(-dt * 6))
      camera.lookAt(camera.position.x - sn * d * 0.6, 0, camera.position.z - c * d * 0.6)
    }

    // Keep the shadow-casting sun centered on the player.
    // Morning: the sun is low in the east, so it rakes in through Klaus's east windows.
    const indoor = view.mode === 'inside'
    const half = indoor ? 34 : 90
    // snap the shadow frustum to whole shadow-map texels so shadows don't shimmer
    const texel = (half * 2) / light.current.shadow.mapSize.x
    const sx = Math.round(p.x / texel) * texel
    const sz = Math.round(p.y / texel) * texel
    if (indoor) {
      // Indoors: a higher sun with a tight, sharp shadow map around the player so
      // tables, chairs, people and railings all throw crisp shadows on the terrazzo.
      light.current.position.set(sx + 34, 52, sz + 14)
      light.current.intensity = 1.9
    } else {
      light.current.position.set(sx + 110, 55, sz + 25)
      light.current.intensity = 2
    }
    light.current.target.position.set(sx, 0, sz)
    const sc = light.current.shadow.camera
    if (sc.right !== half) {
      sc.left = sc.bottom = -half
      sc.right = sc.top = half
      sc.far = indoor ? 160 : 400
      sc.updateProjectionMatrix()
    }
    light.current.shadow.bias = indoor ? -0.0002 : -0.0006
    light.current.shadow.normalBias = indoor ? 0.03 : 0.08

    sendAcc.current += dt
    if (sendAcc.current >= 1 / SEND_HZ) {
      sendAcc.current = 0
      net.move(p.x, p.y, facing.current, moving, height.current + lift)
    }
  })

  return (
    <>
      <directionalLight
        ref={light}
        intensity={2}
        color="#ffe1b3"
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-radius={3}
        shadow-camera-left={-90}
        shadow-camera-right={90}
        shadow-camera-top={90}
        shadow-camera-bottom={-90}
        shadow-camera-far={400}
        shadow-bias={-0.0004}
      />
      <Confetti ref={confetti} />
      <mesh ref={puff} rotation-x={-Math.PI / 2} visible={false}>
        <ringGeometry args={[0.35, 0.6, 32]} />
        <meshBasicMaterial color="#f4ecdc" transparent opacity={0} depthWrite={false} />
      </mesh>
      <Avatar ref={group} color={color} name={name} state={state} me hideTag={view.mode === 'inside'} />
    </>
  )
}

/** Closest spot to (x, z) you can stand on, searching outward in rings. */
function nearestWalkable(ok: (x: number, z: number) => boolean, x: number, z: number): [number, number] {
  if (ok(x, z)) return [x, z]
  for (let r = 0.5; r < 40; r += 0.5)
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
      const px = x + Math.cos(a) * r
      const pz = z + Math.sin(a) * r
      if (ok(px, pz)) return [px, pz]
    }
  return [x, z]
}

/**
 * Time profile for the cinematic: speed along the path's length, easing in/out at
 * the ends and slowing (not stopping) around the top shot. Returns cumulative time
 * T[i] (normalised 0..1) for arc fraction u = i / (N - 1).
 */
function glideTiming(curve: THREE.CatmullRomCurve3, topParam: number) {
  const N = 400
  // arc fraction of the top shot
  const lens = curve.getLengths(N)
  const total = lens[lens.length - 1]
  const uTop = lens[Math.round(topParam * N)] / total
  const T = new Float32Array(N)
  const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
  let acc = 0
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1)
    const ends = 0.12 + 0.88 * smooth(Math.min(u, 1 - u) / 0.14)
    const dwell = 1 - 0.8 * Math.exp(-(((u - uTop) / 0.07) ** 2))
    if (i > 0) acc += 1 / (ends * dwell)
    T[i] = acc
  }
  for (let i = 0; i < N; i++) T[i] /= acc
  return T
}

function timeToU(T: Float32Array, t: number) {
  let lo = 0
  let hi = T.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (T[mid] < t) lo = mid
    else hi = mid
  }
  const span = T[hi] - T[lo] || 1
  return (lo + (t - T[lo]) / span) / (T.length - 1)
}

/* ------------------------------------------------------------------ confetti */

export interface ConfettiHandle {
  burst: (x: number, y: number, z: number, scale: number) => void
}

const CONFETTI_N = 160
const CONFETTI_COLORS = ['#f26b5b', '#f7c548', '#2bb3c0', '#7cc38b', '#b58be0', '#ff8fb1', '#3fb8f0', '#ffffff']

/** A pop of paper confetti that bursts up around you, flutters and settles (2.8 s). */
const Confetti = forwardRef<ConfettiHandle>(function Confetti(_, ref) {
  const mesh = useRef<THREE.InstancedMesh>(null!)
  const st = useRef<{ t: number; pos: Float32Array; vel: Float32Array; spin: Float32Array; s: number } | null>(null)
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), p: new THREE.Vector3(), sc: new THREE.Vector3() }), [])
  useImperativeHandle(ref, () => ({
    burst(x, y, z, scale) {
      const pos = new Float32Array(CONFETTI_N * 3)
      const vel = new Float32Array(CONFETTI_N * 3)
      const spin = new Float32Array(CONFETTI_N * 3)
      for (let i = 0; i < CONFETTI_N; i++) {
        const a = Math.random() * Math.PI * 2
        const r = Math.random() * 0.5
        pos.set([x + Math.cos(a) * r * scale, y + 1.2 * scale, z + Math.sin(a) * r * scale], i * 3)
        const out = (1.2 + Math.random() * 2.2) * scale
        vel.set([Math.cos(a) * out, (3.2 + Math.random() * 2.6) * scale, Math.sin(a) * out], i * 3)
        spin.set([Math.random() * 8, Math.random() * 8, Math.random() * 8], i * 3)
      }
      st.current = { t: 0, pos, vel, spin, s: scale }
      mesh.current.visible = true
    },
  }))
  useEffect(() => {
    mesh.current.visible = false // shown only during a burst (set imperatively, not via props)
    const c = new THREE.Color()
    for (let i = 0; i < CONFETTI_N; i++) mesh.current.setColorAt(i, c.set(CONFETTI_COLORS[i % CONFETTI_COLORS.length]))
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true
  }, [])
  useFrame((_, dt) => {
    const s = st.current
    if (!s) return
    const d = Math.min(dt, 0.05)
    s.t += d
    const life = 2.8
    const shrink = s.t > life - 0.6 ? Math.max(0, (life - s.t) / 0.6) : 1
    for (let i = 0; i < CONFETTI_N; i++) {
      const k = i * 3
      // gravity, heavy air drag, and a sideways flutter as the paper falls
      s.vel[k + 1] -= 6 * s.s * d
      s.vel[k] *= 1 - 1.6 * d
      s.vel[k + 2] *= 1 - 1.6 * d
      s.vel[k + 1] = Math.max(s.vel[k + 1], -1.1 * s.s)
      s.pos[k] += (s.vel[k] + Math.sin(s.t * 6 + i) * 0.35 * s.s) * d
      s.pos[k + 1] = Math.max(0.02, s.pos[k + 1] + s.vel[k + 1] * d)
      s.pos[k + 2] += (s.vel[k + 2] + Math.cos(s.t * 5 + i) * 0.35 * s.s) * d
      tmp.e.set(s.spin[k] * s.t, s.spin[k + 1] * s.t, s.spin[k + 2] * s.t)
      tmp.q.setFromEuler(tmp.e)
      tmp.p.set(s.pos[k], s.pos[k + 1], s.pos[k + 2])
      tmp.sc.setScalar(s.s * shrink)
      mesh.current.setMatrixAt(i, tmp.m.compose(tmp.p, tmp.q, tmp.sc))
    }
    mesh.current.instanceMatrix.needsUpdate = true
    if (s.t >= life) {
      st.current = null
      mesh.current.visible = false
    }
  })
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, CONFETTI_N]} frustumCulled={false}>
      <planeGeometry args={[0.13, 0.08]} />
      <meshBasicMaterial side={THREE.DoubleSide} toneMapped={false} />
    </instancedMesh>
  )
})
