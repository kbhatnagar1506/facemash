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
  name, color, start, collider, net, info, zoom, view,
}: {
  view: View
  name: string
  color: string
  start: [number, number]
  /**
   * `surface`, when present, makes the world multi-level: it returns the floor height
   * the player would stand on at (x, z) coming from height y, or null if they can't go there.
   */
  collider: { blocked(x: number, z: number, r?: number): boolean; surface?(x: number, z: number, y: number): number | null }
  net: Net
  info: React.MutableRefObject<PlayerInfo>
  zoom: React.MutableRefObject<number>
}) {
  const group = useRef<THREE.Group>(null!)
  const state = useRef<AvatarState>({ moving: false })
  const pos = useRef(new THREE.Vector2(...start))
  const facing = useRef(0)
  const height = useRef(0) // floor height under the player (stairs/balcony)
  const sendAcc = useRef(0)
  const light = useRef<THREE.DirectionalLight>(null!)
  const yaw = useRef(0) // camera heading in 'inside' view; 0 = camera south of player looking north
  const { camera, scene, gl } = useThree()

  // Switching views: reset heading, and let the inside camera get close without clipping.
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    if (view.mode === 'inside') {
      yaw.current = view.yaw0
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
      else if (armed) yaw.current -= e.movementX * 0.006
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

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const p = pos.current

    if (net.correction) {
      p.set(net.correction.x, net.correction.z)
      height.current = 0
      net.correction = null
    }

    let dx = 0
    let dz = 0
    if (!typing()) {
      if (keys.has('KeyW') || keys.has('ArrowUp')) dz -= 1
      if (keys.has('KeyS') || keys.has('ArrowDown')) dz += 1
      if (keys.has('KeyA') || keys.has('ArrowLeft')) dx -= 1
      if (keys.has('KeyD') || keys.has('ArrowRight')) dx += 1
    }
    const inside = view.mode === 'inside'
    if (inside && !typing()) {
      if (keys.has('KeyQ')) yaw.current += dt * 2.2
      if (keys.has('KeyR')) yaw.current -= dt * 2.2
    }
    if (inside && (dx || dz)) {
      // Rotate input into camera space so W always walks away from the camera.
      const c = Math.cos(yaw.current)
      const sn = Math.sin(yaw.current)
      const ix = dx
      const iz = dz
      dx = ix * c + iz * sn
      dz = -ix * sn + iz * c
    }
    const moving = dx !== 0 || dz !== 0
    if (moving) {
      const len = Math.hypot(dx, dz)
      const k = view.mode === 'inside' ? (view.scale ?? 1) * 0.8 : 1 // indoor pace, relative to your size
      const speed = (info.current.bike && view.mode !== 'inside' ? BIKE : keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN : WALK) * k
      const sx = (dx / len) * speed * dt
      const sz = (dz / len) * speed * dt
      // Slide along walls: try the full step, then each axis on its own.
      const tryMove = (nx: number, nz: number) => {
        if (collider.surface) {
          const h = collider.surface(nx, nz, height.current)
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
    group.current.position.set(p.x, height.current, p.y)
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
        height.current + 1.6 * ps + dist * 0.42,
        THREE.MathUtils.clamp(p.y + c * dist, z0, z1),
      )
      if (view.ceiling) want.y = Math.min(want.y, view.ceiling(want.x, want.z, height.current))
      camera.position.lerp(want, 1 - Math.exp(-dt * 8))
      camera.lookAt(p.x - sn * 3 * ps, height.current + 1.5 * ps, p.y - c * 3 * ps)
    } else {
      // Classic overhead camera: fixed pitch, follows smoothly, no rotation.
      const d = zoom.current
      const want = new THREE.Vector3(p.x, d, p.y + d * 0.6)
      camera.position.lerp(want, 1 - Math.exp(-dt * 6))
      camera.lookAt(camera.position.x, 0, camera.position.z - d * 0.6)
    }

    // Keep the shadow-casting sun centered on the player.
    light.current.position.set(p.x + 60, 120, p.y + 40)
    light.current.target.position.set(p.x, 0, p.y)

    sendAcc.current += dt
    if (sendAcc.current >= 1 / SEND_HZ) {
      sendAcc.current = 0
      net.move(p.x, p.y, facing.current, moving, height.current)
    }
  })

  return (
    <>
      <directionalLight
        ref={light}
        intensity={1.7}
        color="#fff6e5"
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
