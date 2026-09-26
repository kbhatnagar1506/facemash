import { useMemo } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { DOORS_Z, MEZZ_Z, X1, Z0, eastX } from './layout'

// The east window wall from the on-site photos: chunky cream aluminium framing
// standing proud of the glass (mullions every bay, a low sill band, two transoms),
// glass doors with push bars and closers, black slot air diffusers in the white
// band above, and orange extension cords along the floor.

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
    // sill band, broken at each door so the doors run down to the floor
    for (let i = 0; i < bays; i++) if (!run.doors.includes(i)) box(m, [bw, 0.32, 0.2], [i * bw + bw / 2, 0.16, 0.08])
    box(m, [len, 0.1, 0.18], [len / 2, 2.35, 0.08]) // transoms
    box(m, [len, 0.1, 0.18], [len / 2, 3.45, 0.08])
    box(m, [len, 0.16, 0.2], [len / 2, H - 0.05, 0.08]) // head
    for (const d of run.doors) {
      if (d >= bays) continue
      // door leaf fills the bay between the mullions, floor to the lower transom
      const dm = m.clone().multiply(new THREE.Matrix4().makeTranslation(d * bw + bw / 2, 0, 0.1))
      doors.push({ m: dm, w: bw - 0.14 })
    }
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()))!
  g.computeVertexNormals()
  return { geo: g, doors }
}

function Door({ m, w }: { m: THREE.Matrix4; w: number }) {
  // From the photo: one tall glass leaf in a cream aluminium frame (slim stiles, a deep
  // kick rail), butt hinges on one side, a satin push bar with its latch box on the
  // other, an overhead closer on the transom, and a metal threshold on the floor.
  const h = 2.29
  const st = 0.12 // stile width
  const kick = 0.26
  const hinge = -w / 2
  const satin = <meshLambertMaterial color="#d9dcdf" />
  return (
    <group matrix={m} matrixAutoUpdate={false}>
      {/* frame */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[(s * (w - st)) / 2, h / 2, 0]} castShadow>
          <boxGeometry args={[st, h, 0.07]} />
          <meshLambertMaterial color={CREAM} />
        </mesh>
      ))}
      <mesh position={[0, kick / 2, 0]} castShadow>
        <boxGeometry args={[w - 2 * st, kick, 0.07]} />
        <meshLambertMaterial color={CREAM} />
      </mesh>
      <mesh position={[0, h - 0.06, 0]}>
        <boxGeometry args={[w - 2 * st, 0.12, 0.07]} />
        <meshLambertMaterial color={CREAM} />
      </mesh>
      {/* the leaf's own glass, a touch darker than the fixed panes */}
      <mesh position={[0, (kick + h - 0.12) / 2, 0]} renderOrder={2}>
        <planeGeometry args={[w - 2 * st, h - 0.12 - kick]} />
        <meshStandardMaterial color="#8fa6a8" roughness={0.08} metalness={0.2} transparent opacity={0.45} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {/* hinges */}
      {[0.3, 1.15, 2.0].map((y) => (
        <mesh key={y} position={[hinge + 0.005, y, 0.045]}>
          <boxGeometry args={[0.03, 0.12, 0.03]} />
          {satin}
        </mesh>
      ))}
      {/* push bar on two brackets, latch box on the far side */}
      <mesh position={[0.02, 1.0, 0.1]} rotation-z={Math.PI / 2} castShadow>
        <cylinderGeometry args={[0.022, 0.022, w * 0.72, 12]} />
        {satin}
      </mesh>
      {[-w * 0.3, w * 0.28].map((x) => (
        <mesh key={x} position={[x, 1.0, 0.065]}>
          <boxGeometry args={[0.04, 0.05, 0.06]} />
          {satin}
        </mesh>
      ))}
      <mesh position={[w / 2 - st - 0.07, 1.0, 0.075]}>
        <boxGeometry args={[0.1, 0.17, 0.08]} />
        {satin}
      </mesh>
      {/* overhead closer on the transom, arm folded to the leaf */}
      <mesh position={[hinge + 0.4, h + 0.13, 0.09]}>
        <boxGeometry args={[0.42, 0.09, 0.09]} />
        <meshLambertMaterial color="#c9ccd0" />
      </mesh>
      <mesh position={[hinge + 0.72, h + 0.07, 0.12]} rotation-z={-0.35}>
        <boxGeometry args={[0.3, 0.025, 0.025]} />
        <meshLambertMaterial color="#b3b7bc" />
      </mesh>
      {/* EXIT ONLY notice at eye height */}
      <mesh position={[0, 1.5, 0.004]}>
        <planeGeometry args={[0.2, 0.11]} />
        <meshBasicMaterial color="#f7f7f4" />
      </mesh>
      {/* threshold */}
      <mesh position={[0, 0.006, 0]}>
        <boxGeometry args={[w, 0.012, 0.22]} />
        <meshLambertMaterial color="#b7b9bb" />
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
      <Cord pts={[[X1 - 0.3, 12.8], [X1 - 0.6, 11.5], [X1 - 0.45, 10], [X1 - 0.8, 8.2], [X1 - 0.5, 6.8], [X1 - 0.35, 5.2]]} />
      <Cord pts={[[X1 - 0.3, 1.2], [X1 - 0.9, 0.6], [X1 - 1.4, 0.9], [X1 - 1.2, 0.2]]} />
    </group>
  )
}
