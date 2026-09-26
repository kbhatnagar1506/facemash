import { useEffect, useMemo, useReducer, useRef } from 'react'
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
    const b = net.bubbles.get(id)
    state.current.bubble = b && performance.now() - b.at < 6000 ? b.text : undefined
  })

  const look = useMemo(() => decodeLook(p.look, p.color), [p.look, p.color])
  return <Avatar ref={group} color={p.color} name={p.name} state={state} look={look} />
}

export function Remotes({ net, scale = 1 }: { net: Net; scale?: number }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => net.subscribe(rerender), [net])
  return (
    <>
      {[...net.players.keys()].map((id) => (
        <Remote key={id} id={id} net={net} scale={scale} />
      ))}
    </>
  )
}
