import { useMemo } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { DOORS_Z, MEZZ_Z, X1, Z0, eastX } from './layout'

// The east window wall from the on-site photos: chunky cream aluminium framing
// standing proud of the glass (mullions every bay, a low sill band, two transoms),
// glass doors with push bars and closers, black slot air diffusers in the white
// band above, and the everyday clutter along it: an e-scooter, orange extension cords.

const CREAM = '#e7e1d2'
const H = 4.6 // glass height

type Run = { a: [number, number]; b: [number, number]; doors: number[] } // doors: bay indices

// straight run through the lobby end, then the splayed run to the back corner
const RUNS: Run[] = [
  { a: [X1, MEZZ_Z], b: [X1, DOORS_Z - 4.7], doors: [5] },
  { a: [eastX(Z0 + 0.4), Z0 + 0.4], b: [X1, MEZZ_Z], doors: [4, 10] },
]

function framing() {
  const parts: THREE.BufferGeometry[] = []
  const doors: { m: THREE.Matrix4; w: number }[] = []
  const box = (m: THREE.Matrix4, s: THREE.Vector3Tuple, p: THREE.Vector3Tuple) => {
    const g = new THREE.BoxGeometry(...s)
    g.translate(...p)
    g.applyMatrix4(m)
    parts.push(g)
  }
  for (const run of RUNS) {
    const [ax, az] = run.a
    const [bx, bz] = run.b
    const len = Math.hypot(bx - ax, bz - az)
    // local frame: x along the run, z pointing into the atrium (west-ish), y up
    const dir = new THREE.Vector3(bx - ax, 0, bz - az).normalize()
    const inward = new THREE.Vector3(dir.z, 0, -dir.x)
    if (inward.x > 0) inward.negate()
    const m = new THREE.Matrix4().makeBasis(dir, new THREE.Vector3(0, 1, 0), inward).setPosition(ax, 0, az)
    const bays = Math.round(len / 2.3)
    const bw = len / bays
    for (let i = 0; i <= bays; i++) box(m, [0.13, H, 0.2], [i * bw, H / 2, 0.08]) // mullions
    box(m, [len, 0.32, 0.2], [len / 2, 0.16, 0.08]) // sill band
    box(m, [len, 0.1, 0.18], [len / 2, 2.35, 0.08]) // transoms
    box(m, [len, 0.1, 0.18], [len / 2, 3.45, 0.08])
    box(m, [len, 0.16, 0.2], [len / 2, H - 0.05, 0.08]) // head
    for (const d of run.doors) {
      if (d >= bays) continue
      const x0 = d * bw + 0.1
      // door leaf: its own frame inside the bay, full height to the lower transom
      const dm = m.clone().multiply(new THREE.Matrix4().makeTranslation(x0 + (bw - 0.2) / 2, 0, 0.12))
      doors.push({ m: dm, w: bw - 0.26 })
    }
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()))!
  g.computeVertexNormals()
  return { geo: g, doors }
}

function Door({ m, w }: { m: THREE.Matrix4; w: number }) {
  const h = 2.3
  return (
    <group matrix={m} matrixAutoUpdate={false}>
      {/* leaf frame */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[(s * w) / 2, h / 2, 0]} castShadow>
          <boxGeometry args={[0.1, h, 0.08]} />
          <meshLambertMaterial color={CREAM} />
        </mesh>
      ))}
      <mesh position={[0, 0.12, 0]}>
        <boxGeometry args={[w, 0.24, 0.08]} />
        <meshLambertMaterial color={CREAM} />
      </mesh>
      <mesh position={[0, h - 0.05, 0]}>
        <boxGeometry args={[w, 0.1, 0.08]} />
        <meshLambertMaterial color={CREAM} />
      </mesh>
      {/* the push bar across the leaf, with its latch housing */}
      <mesh position={[0, 1.02, 0.09]} castShadow>
        <boxGeometry args={[w * 0.82, 0.07, 0.06]} />
        <meshStandardMaterial color="#c9ccd0" metalness={0.7} roughness={0.35} />
      </mesh>
      <mesh position={[w * 0.36, 1.02, 0.11]}>
        <boxGeometry args={[0.1, 0.16, 0.08]} />
        <meshStandardMaterial color="#b7babf" metalness={0.7} roughness={0.35} />
      </mesh>
      {/* overhead closer and its arm */}
      <mesh position={[-w * 0.2, h + 0.12, 0.08]}>
        <boxGeometry args={[0.38, 0.1, 0.1]} />
        <meshStandardMaterial color="#b9bcc1" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[-w * 0.02, h + 0.06, 0.14]} rotation-z={0.5}>
        <boxGeometry args={[0.28, 0.025, 0.025]} />
        <meshStandardMaterial color="#9ea2a8" metalness={0.6} roughness={0.4} />
      </mesh>
      {/* EXIT ONLY sign on the glass */}
      <mesh position={[-w * 0.12, 1.55, 0.03]}>
        <planeGeometry args={[0.2, 0.12]} />
        <meshBasicMaterial color="#f7f7f4" />
      </mesh>
    </group>
  )
}

/** Black slot diffusers in the white band above the windows. */
function Diffusers() {
  return (
    <group>
      {RUNS.map((run, i) => {
        const [ax, az] = run.a
        const [bx, bz] = run.b
        const len = Math.hypot(bx - ax, bz - az)
        const ang = -Math.atan2(bz - az, bx - ax)
        return (
          <group key={i} position={[(ax + bx) / 2 - 0.06, H + 0.45, (az + bz) / 2]} rotation-y={ang}>
            {[0, 0.09, 0.18].map((y) => (
              <mesh key={y} position={[0, y, 0]} rotation-y={Math.PI / 2 + (i ? 0 : 0)}>
                <boxGeometry args={[0.02, 0.035, len * 0.9]} />
                <meshBasicMaterial color="#1c1d20" />
              </mesh>
            ))}
          </group>
        )
      })}
    </group>
  )
}

/** A folded-out e-scooter parked against the glass. */
function Scooter({ x, z, rot }: { x: number; z: number; rot: number }) {
  return (
    <group position={[x, 0, z]} rotation-y={rot}>
      <mesh position={[0, 0.1, 0]} castShadow>
        <boxGeometry args={[0.16, 0.05, 0.8]} />
        <meshLambertMaterial color="#1d1e22" />
      </mesh>
      {[-0.42, 0.42].map((z) => (
        <mesh key={z} position={[0, 0.11, z]} rotation-z={Math.PI / 2}>
          <cylinderGeometry args={[0.11, 0.11, 0.06, 16]} />
          <meshLambertMaterial color="#141417" />
        </mesh>
      ))}
      <mesh position={[0, 0.62, 0.44]} rotation-x={-0.12} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 1.05, 8]} />
        <meshLambertMaterial color="#1d1e22" />
      </mesh>
      <mesh position={[0, 1.13, 0.5]} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.018, 0.018, 0.5, 8]} />
        <meshLambertMaterial color="#1d1e22" />
      </mesh>
      <mesh position={[0, 0.7, 0.47]}>
        <boxGeometry args={[0.03, 0.12, 0.012]} />
        <meshBasicMaterial color="#d9412b" />
      </mesh>
    </group>
  )
}

/** Orange extension cord snaking along the floor. */
function Cord({ pts }: { pts: [number, number][] }) {
  const geo = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0.012, z)))
    return new THREE.TubeGeometry(curve, pts.length * 12, 0.012, 5)
  }, [pts])
  return (
    <mesh geometry={geo} castShadow>
      <meshLambertMaterial color="#e2622a" />
    </mesh>
  )
}

export function EastGlass() {
  const { geo, doors } = useMemo(framing, [])
  return (
    <group>
      <mesh geometry={geo} castShadow receiveShadow>
        <meshLambertMaterial color={CREAM} />
      </mesh>
      {doors.map((d, i) => (
        <Door key={i} m={d.m} w={d.w} />
      ))}
      <Diffusers />
      <Scooter x={X1 - 0.5} z={13.5} rot={0.2} />
      <Cord pts={[[X1 - 0.3, 12.8], [X1 - 0.6, 11.5], [X1 - 0.45, 10], [X1 - 0.8, 8.2], [X1 - 0.5, 6.8], [X1 - 0.35, 5.2]]} />
      <Cord pts={[[X1 - 0.3, 1.2], [X1 - 0.9, 0.6], [X1 - 1.4, 0.9], [X1 - 1.2, 0.2]]} />
    </group>
  )
}
