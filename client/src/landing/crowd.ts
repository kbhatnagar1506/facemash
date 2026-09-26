import * as THREE from 'three'
import { BEAT_D, CROWD_A, CROWD_B, L, place, ps, type PS } from './path'
import { clamp, rng, smoothstep, wrapPi } from './physics'

// About four hundred strangers. They rise out of the ground in a ripple as you walk
// in, step aside to let you through (and drift home once you've passed), and glance
// at you as you go by. The few gold ones — the people you actually need — never look.
// Everything is typed arrays and one matrix write per person per frame.

export const CROWD_GATE = (BEAT_D.small + BEAT_D.crowd) / 2
export const CROWD_NEAR = CROWD_A - 22
export const CROWD_FAR = CROWD_B + 26

export interface Crowd {
  n: number
  hx: Float32Array
  hz: Float32Array
  ox: Float32Array
  oz: Float32Array
  vx: Float32Array
  vz: Float32Array
  yaw: Float32Array
  yawHome: Float32Array
  rise: Float32Array
  riseV: Float32Array
  gph: Float32Array
  react: Float32Array
  ph: Float32Array
  along: Float32Array
  lat: Float32Array
  gold: Uint8Array
  /** highest rise this step: 0 while everyone is still underground (then nothing is drawn) */
  up: number
}

export function makeCrowd(max = 420, latMax = Infinity): Crowd {
  const r = rng(1307)
  const S = 1.45
  const cell = 1.5
  const grid = new Map<number, number[]>()
  const key = (x: number, z: number) => (Math.floor(x / cell) + 512) * 4096 + (Math.floor(z / cell) + 2048)
  const pts: { x: number; z: number; d: number; lat: number }[] = []
  const o = ps()
  for (let tries = 0; tries < 40000 && pts.length < max; tries++) {
    const d = CROWD_A + r() * (CROWD_B - CROWD_A)
    const lat = (r() * 2 - 1) * 19
    const al = Math.abs(lat)
    if (al < 0.9) continue
    const p = (0.15 + 0.85 * smoothstep(al, 0.9, 3.8)) * smoothstep(d, CROWD_A, CROWD_A + 6) * (1 - smoothstep(d, CROWD_B - 6, CROWD_B))
    if (r() > p) continue
    place(d, lat, o)
    const cx = Math.floor(o.x / cell)
    const cz = Math.floor(o.z / cell)
    let ok = true
    for (let i = -1; i <= 1 && ok; i++)
      for (let j = -1; j <= 1 && ok; j++) {
        const list = grid.get((cx + i + 512) * 4096 + (cz + j + 2048))
        if (!list) continue
        for (const q of list) {
          const a = pts[q]
          if ((a.x - o.x) ** 2 + (a.z - o.z) ** 2 < S * S) {
            ok = false
            break
          }
        }
      }
    if (!ok) continue
    const k = key(o.x, o.z)
    const list = grid.get(k)
    if (list) list.push(pts.length)
    else grid.set(k, [pts.length])
    pts.push({ x: o.x, z: o.z, d, lat })
  }
  // laid out in full first, so trimming the far sides leaves the rest exactly where it was
  if (latMax < Infinity) pts.splice(0, pts.length, ...pts.filter((p) => Math.abs(p.lat) <= latMax))
  const n = pts.length
  const f = () => new Float32Array(n)
  const c: Crowd = {
    n,
    hx: f(),
    hz: f(),
    ox: f(),
    oz: f(),
    vx: f(),
    vz: f(),
    yaw: f(),
    yawHome: f(),
    rise: f(),
    riseV: f(),
    gph: f(),
    react: f(),
    ph: f(),
    along: f(),
    lat: f(),
    gold: new Uint8Array(n),
    up: 0,
  }
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    c.hx[i] = p.x
    c.hz[i] = p.z
    c.along[i] = p.d
    c.lat[i] = p.lat
    place(p.d, 0, o)
    // 60% face the lane (loosely), the rest face wherever
    const toLane = Math.atan2(o.x - p.x, o.z - p.z)
    const y = r() < 0.6 ? toLane + (r() - 0.5) * 1.2 : r() * Math.PI * 2
    c.yawHome[i] = y
    c.yaw[i] = y
    c.react[i] = 2.5 + r() * 3.5
    c.ph[i] = r() * 20
  }
  // five gold beans, spread along the crowd, close enough to the lane that you pass right by;
  // all on your right (screen right), so none of them stands behind the copy
  const want = [0.39, 0.45, 0.51, 0.57, 0.62]
  want.forEach((w) => {
    let best = -1
    let bd = Infinity
    for (let i = 0; i < n; i++) {
      const al = Math.abs(c.lat[i])
      if (c.gold[i] || al < 2.2 || al > 4.6 || c.lat[i] < 0) continue
      const e = Math.abs(c.along[i] - w * L)
      if (e < bd) {
        bd = e
        best = i
      }
    }
    if (best >= 0) c.gold[best] = 1
  })
  return c
}

/** Colours: cool neutral greys for strangers, gold for the ones who matter. */
export function crowdColors(c: Crowd, mesh: THREE.InstancedMesh) {
  const col = new THREE.Color()
  for (let i = 0; i < c.n; i++) {
    if (c.gold[i]) col.set('#FFC93C')
    else col.setHSL(0.62, 0.05, 0.64 + (i % 5) * 0.03)
    mesh.setColorAt(i, col)
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

/** Snap everyone to where they'd be (after a cut, or with reduced motion on first frame). */
export function crowdReset(c: Crowd, heroD: number) {
  let up = 0
  for (let i = 0; i < c.n; i++) {
    c.ox[i] = c.oz[i] = c.vx[i] = c.vz[i] = c.riseV[i] = 0
    c.rise[i] = riseTarget(c, i, heroD)
    c.yaw[i] = c.yawHome[i]
    if (c.rise[i] > up) up = c.rise[i]
  }
  c.up = up
}

function riseTarget(c: Crowd, i: number, heroD: number) {
  return heroD > CROWD_GATE && heroD > c.along[i] - 16 + 0.35 * Math.abs(c.lat[i]) ? 1 : 0
}

export interface CrowdHero {
  d: number
  x: number
  z: number
  vx: number
  vz: number
}

/** One simulation step; writes every instance matrix into `out` (n × 16). */
export function stepCrowd(c: Crowd, h: CrowdHero, at: PS, t: number, dt: number, reduced: boolean, out: ArrayLike<number> & { [i: number]: number }) {
  const R = 2.8
  const R2 = R * R
  const K_REP = reduced ? 19 : 38
  const W = 3
  const K_HOME = W * W
  const C = 2 * 0.8 * W
  const px = h.x + h.vx * 0.35 // anticipation: people move before you arrive
  const pz = h.z + h.vz * 0.35
  const subs = Math.max(1, Math.ceil(dt * 120))
  const hs = dt / subs
  let up = 0
  for (let i = 0; i < c.n; i++) {
    const x0 = c.hx[i] + c.ox[i]
    const z0 = c.hz[i] + c.oz[i]
    let fx = 0
    let fz = 0
    const dx = x0 - px
    const dz = z0 - pz
    const r2 = dx * dx + dz * dz
    if (r2 < R2) {
      const r = Math.sqrt(r2) + 1e-4
      const f = K_REP * (1 - r / R) ** 2
      const side = dx * at.rx + dz * at.rz >= 0 ? 1 : -1 // step aside, not forward
      fx = f * ((0.35 * dx) / r + 0.65 * side * at.rx)
      fz = f * ((0.35 * dz) / r + 0.65 * side * at.rz)
    }
    let ex = x0 - h.x
    let ez = z0 - h.z
    let dh = Math.sqrt(ex * ex + ez * ez)
    const kHome = K_HOME * smoothstep(dh, 2.5, 6) // wait until you've passed before drifting back
    c.vx[i] += (fx - kHome * c.ox[i] - C * c.vx[i]) * dt
    c.vz[i] += (fz - kHome * c.oz[i] - C * c.vz[i]) * dt
    c.ox[i] += c.vx[i] * dt
    c.oz[i] += c.vz[i] * dt
    const ol = Math.sqrt(c.ox[i] * c.ox[i] + c.oz[i] * c.oz[i])
    if (ol > 2.4) {
      c.ox[i] *= 2.4 / ol
      c.oz[i] *= 2.4 / ol
    }
    let x = c.hx[i] + c.ox[i]
    let z = c.hz[i] + c.oz[i]
    ex = x - h.x
    ez = z - h.z
    dh = Math.sqrt(ex * ex + ez * ez)
    if (dh < 1.4 && c.rise[i] > 0.5) {
      // hard constraint: nobody stands inside you
      const k = 1.4 / (dh + 1e-4)
      x = h.x + ex * k
      z = h.z + ez * k
      c.ox[i] = x - c.hx[i]
      c.oz[i] = z - c.hz[i]
      dh = 1.4
    }
    // glance: staggered head turns toward you; the gold ones never look
    const gw = c.gold[i] ? 0 : 0.65 * (1 - smoothstep(dh, 3, 7.5))
    const yawT = c.yawHome[i] + 0.1 * Math.sin(0.45 * t + c.ph[i]) + wrapPi(Math.atan2(-ex, -ez) - c.yawHome[i]) * gw
    c.yaw[i] += wrapPi(yawT - c.yaw[i]) * (1 - Math.exp(-c.react[i] * dt))
    // a little waddle while being pushed aside
    const sp = Math.sqrt(c.vx[i] * c.vx[i] + c.vz[i] * c.vz[i])
    const wk = Math.min(1, sp / 1.2)
    if (sp > 0.05) c.gph[i] += dt * (4 + 6 * sp)
    // rise ripple, nearest the lane first; reversible
    const rt = riseTarget(c, i, h.d)
    if (reduced) {
      c.rise[i] = rt
      c.riseV[i] = 0
    } else
      for (let s = 0; s < subs; s++) {
        c.riseV[i] += (121 * (rt - c.rise[i]) - 12.1 * c.riseV[i]) * hs
        c.rise[i] += c.riseV[i] * hs
      }
    if (c.rise[i] > up) up = c.rise[i]
    const s0 = c.gold[i] ? 1 : 0.85
    const sy = 1 + clamp(c.riseV[i] * 0.045, -0.15, 0.2) + (reduced ? 0 : 0.012 * Math.sin(2.2 * t + c.ph[i]))
    const sxz = s0 / Math.sqrt(sy)
    const sY = s0 * sy
    // matrix = T · Ry(yaw) · Rz(roll) · S, written directly (column-major)
    const g = Math.sin(c.gph[i])
    const roll = g * 0.07 * wk
    const cy = Math.cos(c.yaw[i])
    const syw = Math.sin(c.yaw[i])
    const cr = Math.cos(roll)
    const sr = Math.sin(roll)
    const o = i * 16
    out[o] = cy * cr * sxz
    out[o + 1] = sr * sxz
    out[o + 2] = -syw * cr * sxz
    out[o + 3] = 0
    out[o + 4] = -cy * sr * sY
    out[o + 5] = cr * sY
    out[o + 6] = syw * sr * sY
    out[o + 7] = 0
    out[o + 8] = syw * sxz
    out[o + 9] = 0
    out[o + 10] = cy * sxz
    out[o + 11] = 0
    out[o + 12] = x
    out[o + 13] = (c.rise[i] - 1) * 2.6 + Math.abs(g) * 0.07 * wk
    out[o + 14] = z
    out[o + 15] = 1
  }
  c.up = up
}
