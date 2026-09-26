import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { Avatar, type AvatarState } from '../Avatar'
import { PERSON_SCALE, floorAt } from './layout'

// The HackGT crowd: everyone in the atrium photos, animated.

type Look = { shirt: string; skin: string; hair: string; pants: string; backpack?: string }

const SHIRTS = ['#1d1f24', '#2b2e35', '#f1f1ee', '#3f6f4f', '#1f2f4f', '#8a8f96', '#7fa6c9', '#e6a6b5', '#111214', '#5b4636']
const PANTS = ['#1a1b1f', '#27324a', '#cfc6a8', '#3d5a80', '#6b7079', '#1a1b1f', '#4a6b8a']
const SKINS = ['#f1c7a3', '#d9a47c', '#b97c52', '#8d5a3b', '#e8b98f', '#6e4630', '#c68e62']
const HAIR = ['#1f1a17', '#2b1f18', '#3b2a20', '#1a1a1a', '#5a3a22', '#141414']
const PACKS = ['#5b6068', '#23262b', '#8a8f96', '#2f3e57']

function look(i: number, pack = true): Look {
  return {
    shirt: SHIRTS[(i * 7 + 3) % SHIRTS.length],
    pants: PANTS[(i * 5 + 1) % PANTS.length],
    skin: SKINS[(i * 3 + 2) % SKINS.length],
    hair: HAIR[(i * 11) % HAIR.length],
    backpack: pack && i % 3 !== 0 ? PACKS[i % PACKS.length] : undefined,
  }
}

/** What the crowd brain writes each frame; the NPC component renders it. */
interface Ctrl {
  x: number
  y: number
  z: number
  r: number
  moving: boolean
  sit?: boolean
  wave?: boolean
}

function Npc({ ctrl, look, mop }: { ctrl: Ctrl; look: Look; mop?: boolean }) {
  const g = useRef<THREE.Group>(null!)
  const mopRef = useRef<THREE.Group>(null!)
  const state = useRef<AvatarState>({ moving: false })
  useFrame(({ clock }) => {
    // seated people sit on the chair seat (0.47 m), not on the floor
    g.current.position.set(ctrl.x, ctrl.y + (ctrl.sit ? 0.47 - 0.13 * PERSON_SCALE : 0), ctrl.z)
    g.current.rotation.y = ctrl.r
    state.current.moving = ctrl.moving
    state.current.sit = ctrl.sit
    state.current.wave = ctrl.wave
    if (mopRef.current) mopRef.current.rotation.y = Math.sin(clock.elapsedTime * 2.2) * 0.6
  })
  return (
    <group ref={g} scale={PERSON_SCALE}>
      <Avatar color={look.shirt} name="" state={state} npc={look} />
      {mop && (
        <group ref={mopRef} position={[0.5, 0, 0.5]}>
          <mesh position={[0, 0.8, 0.3]} rotation-x={0.7}>
            <cylinderGeometry args={[0.03, 0.03, 1.9, 6]} />
            <meshLambertMaterial color="#f2c230" />
          </mesh>
          <mesh position={[0, 0.05, 1.05]}>
            <boxGeometry args={[1.3, 0.08, 0.14]} />
            <meshLambertMaterial color="#9ec27a" />
          </mesh>
        </group>
      )}
    </group>
  )
}

const face = (dx: number, dz: number) => Math.atan2(dx, dz)
const turn = (from: number, to: number, k: number) => {
  let d = to - from
  d = Math.atan2(Math.sin(d), Math.cos(d))
  return from + d * k
}

/** Walk along a polyline (ping-pong or loop), following stairs/balcony heights. */
function walker(pts: [number, number][], speed: number, loop: boolean, start = 0) {
  const c: Ctrl = { x: pts[0][0], y: 0, z: pts[0][1], r: 0, moving: true }
  let seg = start % (pts.length - 1)
  let dir = 1
  let pause = 0
  return {
    c,
    step(dt: number) {
      if (pause > 0) {
        pause -= dt
        c.moving = false
        return
      }
      c.moving = true
      const [tx, tz] = pts[seg + (dir > 0 ? 1 : 0)]
      const dx = tx - c.x
      const dz = tz - c.z
      const d = Math.hypot(dx, dz)
      if (d < 0.1) {
        seg += dir
        if (seg >= pts.length - 1 || seg < 0) {
          if (loop) seg = 0
          else {
            dir = -dir
            seg = Math.max(0, Math.min(pts.length - 2, seg))
          }
          pause = 1.5 + Math.random() * 2 // stop and look around at the ends
        }
        return
      }
      const s = Math.min(d, speed * dt)
      c.x += (dx / d) * s
      c.z += (dz / d) * s
      c.y = floorAt(c.x, c.z, c.y)
      c.r = turn(c.r, face(dx, dz), Math.min(1, dt * 8))
    },
  }
}

function fixed(x: number, z: number, r: number, extra: Partial<Ctrl> = {}): { c: Ctrl; step: (dt: number, t: number) => void } {
  const c: Ctrl = { x, y: 0, z, r, moving: false, ...extra }
  const r0 = r
  const phase = x * 1.3 + z
  return {
    c,
    // small idle life: glance around, occasional wave
    step: (_dt, t) => {
      c.r = r0 + Math.sin(t * 0.4 + phase) * 0.35
      if (extra.wave === undefined && !c.sit) c.wave = Math.sin(t * 0.3 + phase * 2) > 0.93
    },
  }
}

export function Crowd() {
  const brains = useMemo(() => {
    const out: { c: Ctrl; step: (dt: number, t: number) => void; look: Look; mop?: boolean }[] = []
    let n = 0
    const add = (b: { c: Ctrl; step: (dt: number, t: number) => void }, opts: { pack?: boolean; mop?: boolean; look?: Look } = {}) =>
      out.push({ ...b, look: opts.look ?? look(n++, opts.pack), mop: opts.mop })

    // A light crowd: just the staff at their tables and one person wandering.
    const west = -Math.PI / 2
    add(walker([[0, 18], [-4, 8], [-5.5, -9], [-2, -15.3], [6.4, -15.3], [6.2, 14], [0, 18]], 1.5, true))
    add(fixed(-3.9, -9.6, Math.PI / 2), { pack: false }) // HackGT Help Desk
    add(fixed(-15.4, 7.5, Math.PI / 2, { wave: false }), { pack: false }) // Hardware Desk
    add(fixed(-12.8, 14.5, 0, { wave: false }), { pack: false }) // MLH
    add(fixed(19.6, -24.3, west, { sit: true, wave: false }), { pack: false }) // Aramco, in his folding chair
    add(fixed(21.5, -20.3, west, { wave: false }), { pack: false }) // NSA
    add(fixed(21.6, -4, west), { pack: false }) // Impiricus
    add(fixed(21.6, -12.5, west, { wave: false }), { pack: false }) // Meta, behind the long table

    // 8. The janitor mopping by the entrance.
    add(walker([[6, 16.4], [-3, 16.8]], 0.55, false), { pack: false, mop: true, look: { shirt: '#3c3f46', pants: '#1f2126', skin: '#8d5a3b', hair: '#2a2a2a' } })

    return out
  }, [])

  useFrame(({ clock }, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    for (const b of brains) b.step(dt, clock.elapsedTime)
  })

  return (
    <group>
      {brains.map((b, i) => (
        <Npc key={i} ctrl={b.c} look={b.look} mop={b.mop} />
      ))}
    </group>
  )
}
