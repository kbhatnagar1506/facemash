import * as THREE from 'three'

// The winding path the bean walks, "down" the page toward -z. Everything in the scene
// is placed in (along, lateral) coordinates through sample(), so beats, props and the
// crowd all stay on the path however it bends.

const CONTROL: [number, number][] = [
  [0, 0],
  [4, -18],
  [-4, -38],
  [5, -58],
  [-3, -80],
  [4, -102],
  [-2, -124],
  [0, -150],
]

export const path = new THREE.CatmullRomCurve3(
  CONTROL.map(([x, z]) => new THREE.Vector3(x * 0.8, 0, z * 0.7)),
  false,
  'centripetal',
)
path.arcLengthDivisions = 2000 // the default 200 shows up as a speed ripple
path.updateArcLengths()

/** Arc length of the path in world units. */
export const L = path.getLength()

const M = 1024
const PX = new Float32Array(M + 1)
const PZ = new Float32Array(M + 1)
const TX = new Float32Array(M + 1)
const TZ = new Float32Array(M + 1)
const KX = new Float32Array(M + 1)
const KZ = new Float32Array(M + 1)
{
  const p = new THREE.Vector3()
  const t = new THREE.Vector3()
  for (let i = 0; i <= M; i++) {
    path.getPointAt(i / M, p)
    path.getTangentAt(i / M, t)
    const n = Math.hypot(t.x, t.z) || 1
    PX[i] = p.x
    PZ[i] = p.z
    TX[i] = t.x / n
    TZ[i] = t.z / n
  }
  // curvature vector dT/ds (points to the inside of the bend), then a box blur: spline knots are noisy
  const ds = L / M
  const kx = new Float32Array(M + 1)
  const kz = new Float32Array(M + 1)
  for (let i = 0; i <= M; i++) {
    const a = Math.max(0, i - 1)
    const b = Math.min(M, i + 1)
    kx[i] = (TX[b] - TX[a]) / ((b - a) * ds)
    kz[i] = (TZ[b] - TZ[a]) / ((b - a) * ds)
  }
  for (let i = 0; i <= M; i++) {
    let sx = 0
    let sz = 0
    let n = 0
    for (let j = -2; j <= 2; j++) {
      const k = i + j
      if (k < 0 || k > M) continue
      sx += kx[k]
      sz += kz[k]
      n++
    }
    KX[i] = sx / n
    KZ[i] = sz / n
  }
}

/** A path sample: position, unit tangent, right-hand lateral axis, curvature, heading. */
export interface PS {
  x: number
  z: number
  tx: number
  tz: number
  /** the walker's right-hand side (screen right when the camera is behind a walker) */
  rx: number
  rz: number
  kx: number
  kz: number
  /** yaw that faces along +tangent (same convention as group.rotation.y) */
  heading: number
}
export const ps = (): PS => ({ x: 0, z: 0, tx: 0, tz: -1, rx: 1, rz: 0, kx: 0, kz: 0, heading: Math.PI })

/** O(1), allocation-free sample at arc length d (world units, clamped to the path). */
export function sample(d: number, o: PS) {
  const u = THREE.MathUtils.clamp(d / L, 0, 1) * M
  const i = Math.min(M - 1, u | 0)
  const f = u - i
  o.x = PX[i] + (PX[i + 1] - PX[i]) * f
  o.z = PZ[i] + (PZ[i + 1] - PZ[i]) * f
  let tx = TX[i] + (TX[i + 1] - TX[i]) * f
  let tz = TZ[i] + (TZ[i + 1] - TZ[i]) * f
  const n = Math.hypot(tx, tz) || 1
  tx /= n
  tz /= n
  o.tx = tx
  o.tz = tz
  o.rx = -tz
  o.rz = tx
  o.kx = KX[i] + (KX[i + 1] - KX[i]) * f
  o.kz = KZ[i] + (KZ[i + 1] - KZ[i]) * f
  o.heading = Math.atan2(tx, tz)
  // past either end the path carries on straight
  if (d < 0 || d > L) {
    const e = d < 0 ? d : d - L
    o.x += tx * e
    o.z += tz * e
  }
}

/** World point at (along, lateral) — lateral > 0 is the walker's right. */
export function place(d: number, lat: number, o: PS) {
  sample(d, o)
  o.x += o.rx * lat
  o.z += o.rz * lat
  return o
}

/* ------------------------------------------------------------------ story beats */

export const SECTIONS = ['hero', 'friend', 'small', 'crowd', 'strangers', 'bug', 'apps', 'finale'] as const
export type Section = (typeof SECTIONS)[number]
export const N_SECTIONS = SECTIONS.length

/** Where the bean rests (arc length) while each section's copy is on screen. */
export const BEAT_D: Record<Section, number> = {
  hero: 0,
  friend: 0.15 * L,
  small: 0.3 * L,
  crowd: 0.45 * L,
  strangers: 0.565 * L,
  bug: 0.72 * L,
  apps: 0.855 * L,
  finale: L - 3.0,
}
export const BEAT_LIST = SECTIONS.map((s) => BEAT_D[s])

/** The crowd occupies this stretch of the path. */
export const CROWD_A = 0.36 * L
export const CROWD_B = 0.645 * L
