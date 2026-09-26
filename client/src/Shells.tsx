import { useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { Campus } from './map'
import type { PlayerInfo } from './Player'

const RIBS = 9

/** Scallop shell: a fan with a wavy rim, extruded and puffed with a bevel. */
function useShellGeometry() {
  return useMemo(() => {
    const s = new THREE.Shape()
    const a0 = THREE.MathUtils.degToRad(18)
    const a1 = THREE.MathUtils.degToRad(162)
    // Hinge "ears" at the base.
    s.moveTo(-0.34, -0.02)
    s.lineTo(-0.2, -0.16)
    s.lineTo(0.2, -0.16)
    s.lineTo(0.34, -0.02)
    const steps = 120
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps
      const wave = 1 + 0.07 * Math.abs(Math.sin(((a - a0) / (a1 - a0)) * Math.PI * RIBS))
      s.lineTo(Math.cos(a) * wave, Math.sin(a) * wave + 0.08)
    }
    s.closePath()
    const g = new THREE.ExtrudeGeometry(s, {
      depth: 0.12, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.06, bevelSegments: 3, curveSegments: 4,
    })
    g.center()
    return g
  }, [])
}

function Shell({
  x, z, facing, onOpen, info, active, main,
}: {
  active: boolean
  main: boolean
  x: number
  z: number
  facing: number
  onOpen: () => void
  info: React.MutableRefObject<PlayerInfo>
}) {
  const geo = useShellGeometry()
  const spin = useRef<THREE.Group>(null!)
  const glow = useRef<THREE.Mesh>(null!)
  const [hover, setHover] = useState(false)
  const [near, setNear] = useState(false)
  const seed = x * 0.37 + z * 0.11

  const ribs = useMemo(
    () =>
      Array.from({ length: RIBS - 1 }, (_, i) => {
        const a = THREE.MathUtils.degToRad(18 + (144 * (i + 1)) / RIBS)
        return { a, x: Math.cos(a) * 0.5, y: Math.sin(a) * 0.5 - 0.02 }
      }),
    [],
  )

  useFrame(({ clock }) => {
    const t = clock.elapsedTime + seed
    spin.current.position.y = 2.8 + Math.sin(t * 2) * 0.18
    spin.current.rotation.y = Math.sin(t * 0.9) * 0.6
    const k = hover ? 1.9 : 1.6
    spin.current.scale.lerp(new THREE.Vector3(k, k, k), 0.2)
    const pulse = (t * 0.8) % 1
    glow.current.scale.setScalar(1 + pulse * 0.8)
    ;(glow.current.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - pulse)
    const isNear = Math.hypot(info.current.x - x, info.current.z - z) < 45
    if (isNear !== near) setNear(isNear)
  })

  const open = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    onOpen()
  }

  return (
    // The shell always faces the overhead camera (south); `facing` only orients the post.
    <group position={[x, 0, z]}>
      {/* sandy patch + pulsing ring so the spot reads from far away */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.12, 0]}>
        <circleGeometry args={[2.2, 28]} />
        <meshLambertMaterial color="#f2dca4" />
      </mesh>
      <mesh ref={glow} rotation-x={-Math.PI / 2} position={[0, 0.14, 0]}>
        <ringGeometry args={[2.1, 2.5, 36]} />
        <meshBasicMaterial color="#ffb38a" transparent depthWrite={false} />
      </mesh>
      {/* wooden post */}
      <mesh position={[-Math.sin(facing) * 0.4, 0.7, -Math.cos(facing) * 0.4]} castShadow>
        <boxGeometry args={[0.22, 1.4, 0.22]} />
        <meshToonMaterial color="#9a6236" />
      </mesh>
      <group
        ref={spin}
        onClick={open}
        onPointerOver={(e) => {
          e.stopPropagation()
          setHover(true)
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          setHover(false)
          document.body.style.cursor = ''
        }}
      >
        <mesh geometry={geo} castShadow>
          <meshToonMaterial color={hover ? '#ffc6b3' : '#ffab91'} />
        </mesh>
        {ribs.map((r, i) => (
          <mesh key={i} position={[r.x, r.y, 0.2]} rotation-z={r.a - Math.PI / 2}>
            <boxGeometry args={[0.05, 0.85, 0.04]} />
            <meshBasicMaterial color="#e07a5f" />
          </mesh>
        ))}
        {/* invisible, larger hit target so the shell is easy to click */}
        <mesh visible={false}>
          <sphereGeometry args={[1.6, 8, 8]} />
        </mesh>
      </group>
      {/* Always mounted (unmounting drei <Html> mid-render throws); toggled with CSS. */}
      <Html position={[0, 5, 0]} center zIndexRange={[15, 0]} style={{ display: active && near ? undefined : 'none' }}>
        <button className={main ? 'shell-tag main' : 'shell-tag'} onClick={onOpen}>
          {main ? '⭐ HackGT · Main entrance' : 'HackGT'}
        </button>
      </Html>
    </group>
  )
}

export function Shells({
  campus, onOpen, info, active,
}: {
  active: boolean
  campus: Campus
  onOpen: () => void
  info: React.MutableRefObject<PlayerInfo>
}) {
  return (
    <>
      {campus.event?.entrances.map(([x, z, f], i) => (
        <Shell key={i} x={x} z={z} facing={f} onOpen={onOpen} info={info} active={active} main={i === campus.event?.main} />
      ))}
    </>
  )
}

/** Nearest shell within `range` meters of the player, or null. */
export function nearestShell(campus: Campus, x: number, z: number, range = 7) {
  let best: [number, number] | null = null
  let bestD = range
  for (const [sx, sz] of campus.event?.entrances ?? []) {
    const d = Math.hypot(sx - x, sz - z)
    if (d < bestD) {
      bestD = d
      best = [sx, sz]
    }
  }
  return best
}
