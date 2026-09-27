import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { Avatar, type AvatarState } from './Avatar'
import type { Net } from './net'
import { decodeLook } from './look'

function Remote({ id, net, scale }: { id: number; net: Net; scale: number }) {
  const group = useRef<THREE.Group>(null!)
  const state = useRef<AvatarState>({ moving: false })
  const p = net.players.get(id)!
  const cur = useRef({ x: p.x, z: p.z, y: p.y ?? 0, r: p.r })

  useFrame((_, dt) => {
    const t = net.players.get(id)
    if (!t) return
    // Server sends at 15 Hz; ease toward the latest sample to hide the steps.
    const k = 1 - Math.exp(-dt * 12)
    const c = cur.current
    if (Math.hypot(t.x - c.x, t.z - c.z) > 60) {
      c.x = t.x
      c.z = t.z
    }
    c.x += (t.x - c.x) * k
    c.z += (t.z - c.z) * k
    c.y += ((t.y ?? 0) - c.y) * k
    let diff = t.r - c.r
    diff = Math.atan2(Math.sin(diff), Math.cos(diff))
    c.r += diff * k
    group.current.position.set(c.x, c.y, c.z)
    group.current.scale.setScalar(scale)
    group.current.rotation.y = c.r
    state.current.moving = t.m
    state.current.run = t.a === 1
    state.current.bike = t.a === 2
    state.current.sit = t.a === 3
    state.current.wave = t.a === 4
    const b = net.bubbles.get(id)
    state.current.bubble = b && performance.now() - b.at < 6000 ? b.text : undefined
  })

  const look = useMemo(() => decodeLook(p.look, p.color), [p.look, p.color])
  return <Avatar ref={group} color={p.color} name={p.name} state={state} look={look} />
}

// Level of detail for crowds: only the nearest FULL_MAX players (within FULL_DIST)
// get a full bean with a name tag. Everyone else in view is a lightweight "impostor"
// bean drawn with two instanced meshes, so hundreds of players cost ~2 draw calls.
const FULL_MAX = 24
const FULL_DIST = 45
const IMPOSTOR_MAX = 1024

const impostorGeo = (() => {
  const body = new THREE.CapsuleGeometry(0.64, 0.66, 6, 14)
  body.scale(1, 1, 0.9)
  body.translate(0, 0.3 + 0.64 + 0.33, 0)
  const visor = new THREE.SphereGeometry(1, 12, 8)
  visor.scale(0.46, 0.37, 0.21)
  visor.translate(0, 1.66, 0.43)
  return { body, visor }
})()

function Impostors({ net, full, scale }: { net: Net; full: React.MutableRefObject<Set<number>>; scale: number }) {
  const body = useRef<THREE.InstancedMesh>(null!)
  const visor = useRef<THREE.InstancedMesh>(null!)
  const cur = useRef(new Map<number, { x: number; z: number; y: number; r: number; color: THREE.Color; look?: string }>())
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) }), [])
  useFrame((_, dt) => {
    const k = 1 - Math.exp(-dt * 12)
    let n = 0
    const alive = new Set<number>()
    for (const p of net.players.values()) {
      alive.add(p.id)
      let c = cur.current.get(p.id)
      if (!c || c.look !== p.look) {
        const col = new THREE.Color(decodeLook(p.look, p.color).body)
        c = { x: p.x, z: p.z, y: p.y ?? 0, r: p.r, color: col, look: p.look }
        cur.current.set(p.id, c)
      }
      c.x += (p.x - c.x) * k
      c.z += (p.z - c.z) * k
      c.y += ((p.y ?? 0) - c.y) * k
      c.r += Math.atan2(Math.sin(p.r - c.r), Math.cos(p.r - c.r)) * k
      if (full.current.has(p.id) || n >= IMPOSTOR_MAX) continue
      tmp.q.setFromAxisAngle(tmp.up, c.r)
      tmp.m.compose(tmp.p.set(c.x, c.y + (p.m ? Math.abs(Math.sin(performance.now() / 90 + p.id)) * 0.08 * scale : 0), c.z), tmp.q, tmp.s.setScalar(scale))
      body.current.setMatrixAt(n, tmp.m)
      visor.current.setMatrixAt(n, tmp.m)
      body.current.setColorAt(n, c.color)
      n++
    }
    for (const id of cur.current.keys()) if (!alive.has(id)) cur.current.delete(id)
    body.current.count = visor.current.count = n
    body.current.instanceMatrix.needsUpdate = visor.current.instanceMatrix.needsUpdate = true
    if (body.current.instanceColor) body.current.instanceColor.needsUpdate = true
  })
  return (
    <>
      <instancedMesh ref={body} args={[impostorGeo.body, undefined, IMPOSTOR_MAX]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.42} />
      </instancedMesh>
      <instancedMesh ref={visor} args={[impostorGeo.visor, undefined, IMPOSTOR_MAX]} frustumCulled={false}>
        <meshStandardMaterial color="#ffffff" roughness={0.3} emissive="#d8d8d2" />
      </instancedMesh>
    </>
  )
}

export function Remotes({ net, scale = 1 }: { net: Net; scale?: number }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => net.subscribe(rerender), [net])
  // which players get the full bean: re-picked 4× a second, nearest to where you are looking
  const full = useRef(new Set<number>())
  const [fullIds, setFullIds] = useState<number[]>([])
  const acc = useRef(1)
  const target = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera }, dt) => {
    acc.current += dt
    if (acc.current < 0.25) return
    acc.current = 0
    camera.getWorldDirection(target)
    // the point on the ground the camera looks at ≈ where you are
    const t = camera.position.y / Math.max(0.2, -target.y)
    const gx = camera.position.x + target.x * Math.min(t, 60)
    const gz = camera.position.z + target.z * Math.min(t, 60)
    const lim = FULL_DIST
    const ranked = [...net.players.values()]
      .map((p) => ({ id: p.id, d: Math.hypot(p.x - gx, p.z - gz) }))
      .filter((e) => e.d < lim)
      .sort((a, b) => a.d - b.d)
      .slice(0, FULL_MAX)
      .map((e) => e.id)
      .sort((a, b) => a - b)
    if (ranked.join() !== fullIds.join()) {
      full.current = new Set(ranked)
      setFullIds(ranked)
    }
  })
  return (
    <>
      {fullIds.filter((id) => net.players.has(id)).map((id) => (
        <Remote key={id} id={id} net={net} scale={scale} />
      ))}
      <Impostors net={net} full={full} scale={scale} />
    </>
  )
}
