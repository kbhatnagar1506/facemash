import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { BALCONY, CEIL, HALL_EXIT, L1, MEZZ_Z } from './layout'
import { HackTables } from './HackTables'
import { curtain, textCard } from './textures'
import { Bear, Sponsors } from './Sponsors'


/* ------------------------------------------------------------------ bunting */

const PASTELS = ['#f6a6b2', '#fbd36b', '#9ad9b5', '#b8a8e6', '#f7c59f', '#8fd3e8', '#f28ca0', '#c9e98f']
const BUNTING: [THREE.Vector3Tuple, THREE.Vector3Tuple, number][] = [
  [[-14, 13.4, -24.6], [16.6, 13.8, -24.6], 1.6], // across the checkerboard wall
  [[-12, 9.6, -12], [16.6, 9.2, -20], 1.8],
  [[-9.5, 10.8, 3], [16.6, 11.2, -6], 2.0],
  [[-8.5, 12.2, 12], [16.6, 12.6, 4], 1.8],
  [[-12, 15.5, -20], [16.6, 15, -10], 2.2],
  [[-9, 7.6, -2], [16.6, 8, -14], 1.6],
  [[-10, 14.2, -4], [16.6, 14.6, 10], 2.4],
  [[-12, 8.4, -22], [10, 8.8, 2], 1.8],
  [[-7, 17, 2], [16.6, 17.4, -22], 2.6],
]

function Bunting() {
  const mesh = useRef<THREE.InstancedMesh>(null!)
  const flags = useMemo(() => {
    const out: { p: THREE.Vector3; dir: number; phase: number; color: string }[] = []
    BUNTING.forEach(([a, b, sag], s) => {
      const A = new THREE.Vector3(...a)
      const B = new THREE.Vector3(...b)
      const n = Math.floor(A.distanceTo(B) / 0.75)
      const dir = -Math.atan2(B.z - A.z, B.x - A.x)
      for (let i = 1; i < n; i++) {
        const t = i / n
        const p = A.clone().lerp(B, t)
        p.y -= sag * 4 * t * (1 - t)
        out.push({ p, dir, phase: i * 0.7 + s, color: PASTELS[(i + s * 3) % PASTELS.length] })
      }
    })
    return out
  }, [])
  const geo = useMemo(() => {
    const sh = new THREE.Shape([new THREE.Vector2(-0.26, 0), new THREE.Vector2(0.26, 0), new THREE.Vector2(0, -0.7)])
    return new THREE.ShapeGeometry(sh)
  }, [])
  const strings = useMemo(
    () =>
      BUNTING.map(([a, b, sag]) => {
        const pts: THREE.Vector3[] = []
        for (let i = 0; i <= 40; i++) {
          const t = i / 40
          const p = new THREE.Vector3(...a).lerp(new THREE.Vector3(...b), t)
          p.y -= sag * 4 * t * (1 - t)
          pts.push(p)
        }
        return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#d8d4cc' }))
      }),
    [],
  )
  useEffect(() => {
    const c = new THREE.Color()
    flags.forEach((f, i) => mesh.current.setColorAt(i, c.set(f.color)))
    mesh.current.instanceColor!.needsUpdate = true
  }, [flags])
  const m = useMemo(() => new THREE.Matrix4(), [])
  const q = useMemo(() => new THREE.Quaternion(), [])
  const e = useMemo(() => new THREE.Euler(), [])
  const one = useMemo(() => new THREE.Vector3(1, 1, 1), [])
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    flags.forEach((f, i) => {
      // pennants flutter in the air-handler draft
      e.set(Math.sin(t * 2.1 + f.phase) * 0.35, f.dir, Math.sin(t * 1.3 + f.phase) * 0.05)
      m.compose(f.p, q.setFromEuler(e), one)
      mesh.current.setMatrixAt(i, m)
    })
    mesh.current.instanceMatrix.needsUpdate = true
  })
  return (
    <group>
      <instancedMesh ref={mesh} args={[geo, undefined, flags.length]}>
        <meshLambertMaterial side={THREE.DoubleSide} />
      </instancedMesh>
      {strings.map((l, i) => (
        <primitive key={i} object={l} />
      ))}
    </group>
  )
}

/* ----------------------------------------------------------------- seagulls */

/** Keep hanging things out of the intro camera's climb and its top-shot view (Player.tsx). */
function clearOfIntro([x, y, z]: THREE.Vector3Tuple | [number, number, number, ...unknown[]]) {
  const p = new THREE.Vector3(x as number, y as number, z as number)
  const near = (a: THREE.Vector3, b: THREE.Vector3, r: number) => {
    const ab = b.clone().sub(a)
    const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq()))
    return p.distanceTo(a.clone().addScaledVector(ab, t)) < r
  }
  const top = new THREE.Vector3(-0.5, 17.3, 1)
  return !near(new THREE.Vector3(5, 3.8, 0), top, 4.5) && !near(top, new THREE.Vector3(0, 0, -13), 3.2)
}

const GULLS: THREE.Vector3Tuple[] = (() => {
  // a whole flock on fishing line through the atrium void, at every height
  const out: THREE.Vector3Tuple[] = [
    [-6, 12, -6], [2, 10.5, -14], [8, 13, -4], [-2, 14.5, 4], [12, 11, -18],
    [5, 15.5, 8], [-9, 10.2, -20], [14, 13.5, 6], [0, 9.2, -22], [-4, 16, -12], [10, 8.6, 12],
  ]
  let s = 7
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  while (out.filter(clearOfIntro).length < 32) {
    const p: THREE.Vector3Tuple = [-8 + r() * 23, 7.2 + r() * 11, -23 + r() * 25]
    if (out.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) > 3)) out.push(p)
  }
  return out.filter(clearOfIntro)
})()

function Gull({ at, i }: { at: THREE.Vector3Tuple; i: number }) {
  const g = useRef<THREE.Group>(null!)
  const wl = useRef<THREE.Group>(null!)
  const wr = useRef<THREE.Group>(null!)
  const wing = useMemo(() => {
    const s = new THREE.Shape()
    s.moveTo(0, 0.18)
    s.quadraticCurveTo(0.6, 0.35, 1.25, 0.05)
    s.lineTo(1.15, -0.08)
    s.quadraticCurveTo(0.6, 0.02, 0, -0.18)
    s.closePath()
    return new THREE.ShapeGeometry(s)
  }, [])
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + i * 1.7
    // paper gulls hang on fishing line: slow pendulum sway + drift + wing flutter
    g.current.position.set(at[0] + Math.sin(t * 0.5) * 0.5, at[1] + Math.sin(t * 0.8) * 0.15, at[2] + Math.cos(t * 0.4) * 0.35)
    g.current.rotation.set(Math.sin(t * 0.6) * 0.08, i * 0.9 + Math.sin(t * 0.25) * 0.5, Math.sin(t * 0.5) * 0.18)
    const flap = 0.25 + Math.sin(t * 2.6) * 0.22
    wl.current.rotation.z = flap
    wr.current.rotation.z = -flap
  })
  return (
    <group ref={g}>
      {/* the fishing line up to the ceiling */}
      <mesh position={[0, (CEIL - at[1]) / 2, 0]}>
        <cylinderGeometry args={[0.006, 0.006, CEIL - at[1], 3]} />
        <meshBasicMaterial color="#e8e6e0" transparent opacity={0.5} />
      </mesh>
      <mesh scale={[0.22, 0.2, 0.62]} castShadow>
        <sphereGeometry args={[1, 12, 10]} />
        <meshLambertMaterial color="#ffffff" />
      </mesh>
      <mesh position={[0, 0.08, 0.55]}>
        <sphereGeometry args={[0.16, 10, 8]} />
        <meshLambertMaterial color="#ffffff" />
      </mesh>
      <mesh position={[0, 0.06, 0.72]}>
        <sphereGeometry args={[0.05, 6, 6]} />
        <meshBasicMaterial color="#d6423a" />
      </mesh>
      <group ref={wl} position={[0.12, 0.05, 0.05]}>
        <mesh geometry={wing} rotation-x={-Math.PI / 2} castShadow>
          <meshLambertMaterial color="#fbfbf9" side={THREE.DoubleSide} />
        </mesh>
      </group>
      <group ref={wr} position={[-0.12, 0.05, 0.05]} scale={[-1, 1, 1]}>
        <mesh geometry={wing} rotation-x={-Math.PI / 2} castShadow>
          <meshLambertMaterial color="#fbfbf9" side={THREE.DoubleSide} />
        </mesh>
      </group>
      <mesh position={[0, 0.02, -0.7]} rotation-x={-Math.PI / 2}>
        <coneGeometry args={[0.18, 0.4, 3]} />
        <meshLambertMaterial color="#e9e9e4" />
      </mesh>
    </group>
  )
}

function Seagulls() {
  return (
    <group>
      {GULLS.map((at, i) => (
        <Gull key={i} at={at} i={i} />
      ))}
    </group>
  )
}

/* ----------------------------------------------------- seaside decorations */

/** Glowing paper jellyfish lanterns hanging in the void, gently bobbing. */
const JELLIES: [number, number, number, string][] = [
  [-3, 11, -10, '#9fd8ff'], [6, 13.5, -16, '#f6b6d9'], [12, 10.5, -8, '#b8a8e6'], [1, 14.5, -2, '#8fe3d6'],
  [9, 12, 0, '#9fd8ff'], [-6, 13, -18, '#f7c59f'], [14, 15, -20, '#f6b6d9'], [4, 9.5, -6, '#b8a8e6'],
  [-1, 16, -20, '#8fe3d6'], [11, 16.5, -2, '#f7c59f'],
]

function Jelly({ at, i }: { at: [number, number, number, string]; i: number }) {
  const g = useRef<THREE.Group>(null!)
  const tentacles = useMemo(
    () =>
      Array.from({ length: 7 }, (_, k) => {
        const a = (k / 7) * Math.PI * 2
        const pts = Array.from({ length: 8 }, (_, j) => new THREE.Vector3(Math.cos(a) * 0.3 + Math.sin(j * 1.3 + k) * 0.05, -j * 0.16, Math.sin(a) * 0.3 + Math.cos(j * 1.1 + k) * 0.05))
        return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.018, 4)
      }),
    [],
  )
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + i * 2.1
    g.current.position.y = at[1] + Math.sin(t * 0.7) * 0.25
    g.current.rotation.y = t * 0.15
    g.current.scale.set(1 + Math.sin(t * 1.4) * 0.05, 1 - Math.sin(t * 1.4) * 0.05, 1 + Math.sin(t * 1.4) * 0.05)
  })
  return (
    <group ref={g} position={[at[0], at[1], at[2]]}>
      <mesh position={[0, (CEIL - at[1]) / 2, 0]}>
        <cylinderGeometry args={[0.006, 0.006, CEIL - at[1], 3]} />
        <meshBasicMaterial color="#e8e6e0" transparent opacity={0.5} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.45, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshBasicMaterial color={at[3]} transparent opacity={0.8} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.05, 0]}>
        <sphereGeometry args={[0.2, 12, 8]} />
        <meshBasicMaterial color="#fffaf0" transparent opacity={0.9} toneMapped={false} />
      </mesh>
      {tentacles.map((geo, k) => (
        <mesh key={k} geometry={geo}>
          <meshBasicMaterial color={at[3]} transparent opacity={0.75} />
        </mesh>
      ))}
    </group>
  )
}

/** Orange-and-white life rings hung on the balcony railings. */
function LifeRing({ p, ry }: { p: THREE.Vector3Tuple; ry: number }) {
  return (
    <group position={p} rotation-y={ry}>
      {Array.from({ length: 8 }, (_, k) => (
        <mesh key={k} rotation-z={(k / 8) * Math.PI * 2}>
          <torusGeometry args={[0.32, 0.1, 8, 6, Math.PI / 4 + 0.01]} />
          <meshLambertMaterial color={k % 2 ? '#f4f4f0' : '#e8543f'} />
        </mesh>
      ))}
      <mesh>
        <torusGeometry args={[0.33, 0.012, 4, 24]} />
        <meshLambertMaterial color="#d8c9a6" />
      </mesh>
    </group>
  )
}

function SeasideDecor() {
  return (
    <group>
      {JELLIES.filter(clearOfIntro).map((j, i) => (
        <Jelly key={i} at={j} i={i} />
      ))}
      {[1, 7, 13].map((x) => (
        <LifeRing key={x} p={[x, L1 + 0.9, MEZZ_Z - 0.12]} ry={0} />
      ))}
      {[-9, -1].map((z) => (
        <LifeRing key={z} p={[BALCONY.left.x1 + 0.12, L1 + 0.9, z]} ry={Math.PI / 2} />
      ))}
    </group>
  )
}

/* -------------------------------------------------------------- photo booth */

/** Fired by the HUD when you press E at the photo booth. */
export const PHOTO_EVENT = 'hackgt-photo'

function PhotoBooth() {
  const [x0, x1, z0, z1, h] = [-0.2, 4.2, -22.6, -18.6, 3.6]
  const back = useMemo(() => curtain('#2f86d6'), [])
  const side = useMemo(() => curtain('#46b1dc'), [])
  const flash = useRef<THREE.PointLight>(null!)
  const flashAt = useRef(-10)
  useEffect(() => {
    const on = () => (flashAt.current = performance.now() / 1000)
    window.addEventListener(PHOTO_EVENT, on)
    return () => window.removeEventListener(PHOTO_EVENT, on)
  }, [])
  useFrame(() => {
    const dt = performance.now() / 1000 - flashAt.current
    flash.current.intensity = dt < 0.5 ? 60 * (1 - dt / 0.5) : 0
  })
  const edges = useMemo(() => {
    const out: { p: THREE.Vector3Tuple; r: THREE.Vector3Tuple; len: number }[] = []
    for (const x of [x0, x1]) for (const z of [z0, z1]) out.push({ p: [x, h / 2, z], r: [0, 0, 0], len: h })
    for (const z of [z0, z1]) for (const y of [h, 0.05]) out.push({ p: [(x0 + x1) / 2, y, z], r: [0, 0, Math.PI / 2], len: x1 - x0 })
    for (const x of [x0, x1]) for (const y of [h, 0.05]) out.push({ p: [x, y, (z0 + z1) / 2], r: [Math.PI / 2, 0, 0], len: z1 - z0 })
    return out
  }, [x0, x1, z0, z1, h])
  const hull = useMemo(() => {
    const s = new THREE.Shape()
    s.moveTo(-2.6, 1.05)
    s.lineTo(2.6, 1.05)
    s.quadraticCurveTo(2.5, 0.35, 1.8, 0.05)
    s.lineTo(-1.9, 0.05)
    s.quadraticCurveTo(-2.45, 0.3, -2.6, 1.05)
    const g = new THREE.ExtrudeGeometry(s, { depth: 1.5, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2 })
    g.translate(0, 0, -0.75)
    return g
  }, [])
  const name = useMemo(
    () => textCard([{ text: 'HACKGT 13', font: '700 150px Georgia, serif', color: '#27364a' }], { w: 1024, h: 220 }),
    [],
  )
  const waves = useMemo(() => {
    const s = new THREE.Shape()
    s.moveTo(0, 0)
    for (let i = 0; i <= 10; i++) s.quadraticCurveTo(i * 0.44 + 0.22, 0.95, i * 0.44 + 0.44, 0.45)
    s.lineTo(4.4, 0)
    s.closePath()
    return new THREE.ShapeGeometry(s)
  }, [])
  return (
    <group>
      {edges.map((e, i) => (
        <mesh key={i} position={e.p} rotation={e.r}>
          <cylinderGeometry args={[0.05, 0.05, e.len, 8]} />
          <meshLambertMaterial color="#f7f7f5" />
        </mesh>
      ))}
      <mesh position={[(x0 + x1) / 2, h / 2 - 0.05, z0 + 0.05]}>
        <planeGeometry args={[x1 - x0 - 0.1, h - 0.2]} />
        <meshLambertMaterial map={back} />
      </mesh>
      {[x0, x1].map((x) => (
        <mesh key={x} position={[x, h / 2 - 0.05, (z0 + z1) / 2]} rotation-y={Math.PI / 2}>
          <planeGeometry args={[z1 - z0 - 0.1, h - 0.2]} />
          <meshLambertMaterial map={side} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {/* cut-out waves along the back */}
      <mesh geometry={waves} position={[x0, 0.02, z0 + 0.15]}>
        <meshLambertMaterial color="#8fd0f0" side={THREE.DoubleSide} />
      </mesh>
      {/* life ring on the frame */}
      <group position={[x1 + 0.12, 2.3, z1 - 0.6]} rotation-y={Math.PI / 2}>
        <mesh>
          <torusGeometry args={[0.38, 0.11, 10, 28]} />
          <meshLambertMaterial color="#f6f3ee" />
        </mesh>
        {[0, 1, 2, 3].map((k) => (
          <mesh key={k} rotation-z={(k * Math.PI) / 2}>
            <torusGeometry args={[0.38, 0.115, 10, 6, Math.PI / 5]} />
            <meshLambertMaterial color="#e2433b" />
          </mesh>
        ))}
      </group>
      {/* the wooden boat hackers pose in, with the HackGT bear sitting in it */}
      <Bear x={2.9} z={-17.5} y={0.5} rot={0.15} chair={false} />
      <group position={[2, 0, -17.4]}>
        <mesh geometry={hull} castShadow receiveShadow>
          <meshToonMaterial color="#f2e9d6" />
        </mesh>
        <mesh position={[0, 0.3, 0.83]}>
          <boxGeometry args={[4.4, 0.12, 0.02]} />
          <meshLambertMaterial color="#c9483a" />
        </mesh>
        <mesh position={[0, 1.08, 0]}>
          <boxGeometry args={[5.25, 0.08, 1.6]} />
          <meshLambertMaterial color="#a8703c" />
        </mesh>
        <mesh position={[0, 0.98, 0]}>
          <boxGeometry args={[5, 0.05, 1.4]} />
          <meshLambertMaterial color="#6f4d2c" />
        </mesh>
        <mesh position={[0.2, 0.66, 0.84]}>
          <planeGeometry args={[2.6, 2.6 / name.aspect]} />
          <meshBasicMaterial map={name.map} transparent />
        </mesh>
      </group>
      <pointLight ref={flash} position={[2, 2.2, -14]} intensity={0} distance={14} color="#ffffff" />
    </group>
  )
}

function ExitShell({ active }: { active: boolean }) {
  const g = useRef<THREE.Group>(null!)
  useFrame(({ clock }) => {
    g.current.position.y = 1.6 + Math.sin(clock.elapsedTime * 2) * 0.15
  })
  const [x, z] = HALL_EXIT
  return (
    <group position={[x, 0, z]}>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.03, 0]}>
        <circleGeometry args={[1.6, 28]} />
        <meshBasicMaterial color="#fff4d6" transparent opacity={0.8} />
      </mesh>
      <group ref={g}>
        <Html center distanceFactor={10} zIndexRange={[15, 0]} style={{ display: active ? undefined : 'none' }}>
          <div className="shell-tag">🐚 Back to campus</div>
        </Html>
      </group>
    </group>
  )
}

export function Decor({ active }: { active: boolean }) {
  return (
    <group>
      <Bunting />
      <Seagulls />
      <SeasideDecor />
      <PhotoBooth />
      <Sponsors />
      <HackTables />
      <ExitShell active={active} />
    </group>
  )
}

