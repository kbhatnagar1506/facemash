import { useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BeanBody } from '../Bean'
import type { AvatarState } from '../Avatar'
import { SPONSOR_BEANS, type Logo } from '../look'
import { PERSON_SCALE, X1, ex } from './layout'

// A mascot bean for every sponsor, standing at the front corner of its booth in the
// sponsor's colours with its logo on the belly. They wave now and then and do the
// happy smile-wink-jump when you walk up. Only drawn when you're at the table (cheap).

const west = -Math.PI / 2
const SPOTS: Record<Exclude<Logo, 'none'>, [number, number, number]> = {
  // back row, fronts facing the atrium (+z)
  notability: [-3.9, -24.0, 0.3],
  visa: [2.75, -24.4, 0.2],
  tmobile: [6.7, -24.4, -0.2],
  citadel: [12.6, -24.4, -0.3],
  aramco: [18.3, -24.8, -0.5],
  // east windows, fronts facing west
  nsa: [X1 - 2.2 + ex(-17.6), -17.6, west + 0.3],
  meta: [X1 - 2.2 + ex(-10.2), -10.2, west + 0.2],
  impiricus: [X1 - 2.2 + ex(-1.8), -1.8, west + 0.3],
  spacex: [X1 - 2.2, 7.4, west - 0.2],
  // organisers
  hackgt: [-1.6, -12.2, Math.PI / 2 - 0.3],
  mlh: [-0.6, 17.6, Math.PI / 2 - 0.4],
}

function SponsorBean({ i }: { i: number }) {
  const sb = SPONSOR_BEANS[i]
  const [x, z, r] = SPOTS[sb.id]
  const g = useRef<THREE.Group>(null!)
  const state = useRef<AvatarState>({ moving: false })
  const wasNear = useRef(false)
  // the bean only exists while you're at its table (mount < 11 m, leave > 14 m)
  const [on, setOn] = useState(false)
  useFrame(({ camera, clock }) => {
    const d = Math.hypot(camera.position.x - x, camera.position.z - z)
    if (!on && d < 11) setOn(true)
    else if (on && d > 14) setOn(false)
    if (!on) return
    // turn a little toward whoever's looking, wave every few seconds
    const want = Math.atan2(camera.position.x - x, camera.position.z - z)
    const diff = Math.atan2(Math.sin(want - r), Math.cos(want - r))
    g.current.rotation.y = r + THREE.MathUtils.clamp(diff, -0.6, 0.6)
    state.current.wave = Math.sin(clock.elapsedTime * 0.8 + i * 1.7) > 0.7
    const near = d < 6
    if (near && !wasNear.current) state.current.cheer = performance.now() // say hi!
    wasNear.current = near
  })
  return (
    <group ref={g} position={[x, 0, z]} scale={PERSON_SCALE}>
      {on && (
        <>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.03, 0]}>
            <circleGeometry args={[0.72, 20]} />
            <meshBasicMaterial color="#000" transparent opacity={0.2} depthWrite={false} />
          </mesh>
          <BeanBody look={sb.look} state={state} shadows={false} />
        </>
      )}
    </group>
  )
}

export function SponsorBeans() {
  return (
    <group>
      {SPONSOR_BEANS.map((_, i) => (
        <SponsorBean key={i} i={i} />
      ))}
    </group>
  )
}
