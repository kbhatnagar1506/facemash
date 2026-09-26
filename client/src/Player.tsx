import { useEffect, useRef } from 'react'
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
    } else {
      cam.near = 1
      cam.fov = 40
    }
    cam.updateProjectionMatrix()
  }, [view, camera])

  // Drag to look around (inside view only).
  useEffect(() => {
    if (view.mode !== 'inside') return
    const el = gl.domElement
    // Only drags that start on the 3D view turn the camera, and only while a
    // button is actually held (checked per event, so it can never get stuck).
    let armed = false
    const downH = () => (armed = true)
    const move = (e: PointerEvent) => {
      if (!(e.buttons & 1)) armed = false
      else if (armed) {
        yaw.current -= e.movementX * 0.006
        pitch.current = Math.max(-0.6, Math.min(1.3, pitch.current - e.movementY * 0.006)) // drag up = look up
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
    if (goal) {
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
    if (inside && !typing()) {
      if (keys.has('KeyQ')) yaw.current += dt * 2.2
      if (keys.has('KeyR')) yaw.current -= dt * 2.2
      if (keys.has('KeyT')) pitch.current = Math.min(1.3, pitch.current + dt * 1.2)
      if (keys.has('KeyG')) pitch.current = Math.max(-0.6, pitch.current - dt * 1.2)
    }
    if (inside && !goal && (dx || dz)) {
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
        // came down on furniture: jump on only if there's somewhere to land; else walk out
        if (collider.furniture?.(p.x, p.y)) startHop(p.x, p.y)
      }
    }
    const hopHeight = Math.min(2.6, 0.55 + 0.3 * hopLen.current) * ps // bigger obstacle, bigger jump
    const lift = hop.current > 0 ? Math.sin(hop.current * Math.PI) * hopHeight : 0
    group.current.position.set(p.x, height.current + lift, p.y)
    group.current.scale.setScalar(view.mode === 'inside' ? (view.scale ?? 1) : 1)
    group.current.rotation.y = facing.current
    cutawayUniforms.uPlayer.value.set(p.x, 0, p.y)
    info.current.x = p.x
    info.current.z = p.y
    info.current.y = height.current

    if (view.mode === 'inside') {
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
      camera.position.lerp(want, 1 - Math.exp(-dt * 8))
      // pitch tilts the view: up toward the balconies and ceiling, down to the floor
      camera.lookAt(p.x - sn * 3 * ps, height.current + 1.5 * ps + pitch.current * 6, p.y - c * 3 * ps)
    } else {
      // Classic overhead camera: fixed pitch, follows smoothly, no rotation.
      const d = zoom.current
      const want = new THREE.Vector3(p.x, d, p.y + d * 0.6)
      camera.position.lerp(want, 1 - Math.exp(-dt * 6))
      camera.lookAt(camera.position.x, 0, camera.position.z - d * 0.6)
    }

    // Keep the shadow-casting sun centered on the player.
    // Morning: the sun is low in the east, so it rakes in through Klaus's east windows.
    light.current.position.set(p.x + 110, 55, p.y + 25)
    light.current.target.position.set(p.x, 0, p.y)

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
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-90}
        shadow-camera-right={90}
        shadow-camera-top={90}
        shadow-camera-bottom={-90}
        shadow-camera-far={400}
        shadow-bias={-0.0004}
      />
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
