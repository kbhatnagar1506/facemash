import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { CEIL, HALL_EXIT, TABLE, TABLES, type Table } from './layout'
import { curtain, textCard } from './textures'
import { FoldingChair, Sponsors } from './Sponsors'


/* ------------------------------------------------------------------ bunting */

const PASTELS = ['#f6a6b2', '#fbd36b', '#9ad9b5', '#b8a8e6', '#f7c59f', '#8fd3e8', '#f28ca0', '#c9e98f']
const BUNTING: [THREE.Vector3Tuple, THREE.Vector3Tuple, number][] = [
  [[-17, 13.4, -24.6], [18.6, 13.8, -24.6], 1.6], // across the checkerboard wall
  [[-17, 9.6, -12], [18.6, 9.2, -20], 1.8],
  [[-13, 10.8, 3], [18.6, 11.2, -6], 2.0],
  [[-17, 12.2, 12], [18.6, 12.6, 4], 1.8],
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

const GULLS: THREE.Vector3Tuple[] = [
  [-6, 12, -6], [2, 10.5, -14], [8, 13, -4], [-2, 14.5, 4], [12, 11, -18],
  [5, 15.5, 8], [-9, 10.2, -20], [14, 13.5, 6], [0, 9.2, -22], [-4, 16, -12], [10, 8.6, 12],
]

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
      <mesh scale={[0.22, 0.2, 0.62]}>
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
        <mesh geometry={wing} rotation-x={-Math.PI / 2}>
          <meshLambertMaterial color="#fbfbf9" side={THREE.DoubleSide} />
        </mesh>
      </group>
      <group ref={wr} position={[-0.12, 0.05, 0.05]} scale={[-1, 1, 1]}>
        <mesh geometry={wing} rotation-x={-Math.PI / 2}>
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
      {/* the wooden boat hackers pose in */}
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

/* ------------------------------------------------------------ hacking tables */

const LAPTOP_COLORS = ['#c9ccd2', '#2b2d33', '#c9ccd2', '#8c9097']
const SCREEN_COLORS = ['#7fd3ff', '#b5f5c8', '#ffd98a', '#d7c2ff', '#9fe7ff']
export const CHAIR_X = [-1.1, 0, 1.1]

function HackTable({ t, active }: { t: Table; active: boolean }) {
  const screens = useRef<THREE.MeshBasicMaterial[]>([])
  const laptops = useMemo(() => {
    const out: { x: number; side: 1 | -1; body: string; screen: string }[] = []
    CHAIR_X.forEach((x, i) =>
      ([1, -1] as const).forEach((side, j) => {
        if ((t.n * 3 + i * 5 + j * 7) % 4 !== 0) {
          out.push({ x, side, body: LAPTOP_COLORS[(t.n + i + j) % 4], screen: SCREEN_COLORS[(t.n * 2 + i + j) % 5] })
        }
      }),
    )
    return out
  }, [t.n])
  // screens flicker gently as code scrolls
  useFrame(({ clock }) => {
    screens.current.forEach((m, i) => {
      if (m) m.color.setScalar(1).lerp(new THREE.Color(laptops[i].screen), 0.75 + 0.25 * Math.sin(clock.elapsedTime * 3 + i * 1.7 + t.n))
    })
  })
  return (
    <group position={[t.x, 0, t.z]}>
      <mesh position={[0, TABLE.h, 0]} castShadow receiveShadow>
        <boxGeometry args={[TABLE.w, 0.08, TABLE.d]} />
        <meshToonMaterial color="#e2c79c" />
      </mesh>
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <mesh key={i} position={[sx * (TABLE.w / 2 - 0.12), TABLE.h / 2, sz * (TABLE.d / 2 - 0.12)]}>
          <boxGeometry args={[0.07, TABLE.h, 0.07]} />
          <meshLambertMaterial color="#6d737c" />
        </mesh>
      ))}
      {CHAIR_X.flatMap((x) =>
        ([1, -1] as const).map((side) => (
          <FoldingChair key={`${x}${side}`} x={x} z={side * (TABLE.d / 2 + 0.45)} rot={side === 1 ? Math.PI : 0} />
        )),
      )}
      {laptops.map((l, i) => (
        <group key={i} position={[l.x, TABLE.h + 0.05, l.side * 0.3]} rotation-y={l.side === 1 ? 0 : Math.PI}>
          <mesh>
            <boxGeometry args={[0.46, 0.025, 0.32]} />
            <meshLambertMaterial color={l.body} />
          </mesh>
          <group position={[0, 0.01, -0.16]} rotation-x={-0.3}>
            <mesh position={[0, 0.15, 0]}>
              <boxGeometry args={[0.46, 0.3, 0.02]} />
              <meshLambertMaterial color={l.body} />
            </mesh>
            <mesh position={[0, 0.15, 0.012]}>
              <planeGeometry args={[0.41, 0.25]} />
              <meshBasicMaterial ref={(m) => { if (m) screens.current[i] = m }} color={l.screen} />
            </mesh>
          </group>
        </group>
      ))}
      <mesh position={[TABLE.w / 2 - 0.3, TABLE.h + 0.1, 0]}>
        <cylinderGeometry args={[0.04, 0.04, 0.15, 10]} />
        <meshLambertMaterial color={t.n % 2 ? '#2f80ed' : '#e8543f'} />
      </mesh>
      <Html position={[0, 2.2, 0]} center zIndexRange={[15, 0]} style={{ display: active ? undefined : 'none', pointerEvents: 'none' }}>
        <div className="table-tag">Table {t.n}</div>
      </Html>
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
      <PhotoBooth />
      <Sponsors />
      {TABLES.map((t) => (
        <HackTable key={t.n} t={t} active={active} />
      ))}
      <ExitShell active={active} />
    </group>
  )
}

