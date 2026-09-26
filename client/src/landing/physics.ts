// Small, allocation-free physics helpers for the landing scene. Every function
// takes dt, so the feel is the same at 60, 120 or 144 Hz.

/** One spring's state: position and velocity. */
export interface S1 {
  x: number
  v: number
}
export const s1 = (x = 0): S1 => ({ x, v: 0 })
export const snap = (s: S1, x: number) => {
  s.x = x
  s.v = 0
}

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x)
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k
/** Hermite smoothstep; needs a < b (write a falling edge as 1 - smoothstep). */
export const smoothstep = (x: number, a: number, b: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
export const smootherstep = (x: number, a: number, b: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * t * (t * (t * 6 - 15) + 10)
}
export const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
export const lerpAngle = (a: number, b: number, k: number) => a + wrapPi(b - a) * k
/** Frame-rate independent exponential approach. */
export const damp = (a: number, b: number, lambda: number, dt: number) => b + (a - b) * Math.exp(-lambda * dt)

/** Critically damped spring, exact closed form: stable for any dt and never overshoots.
 *  About 95% settled after 4.74 / omega seconds. */
export function crit(s: S1, target: number, omega: number, dt: number) {
  const d = s.x - target
  const e = Math.exp(-omega * dt)
  const j = (s.v + omega * d) * dt
  s.x = target + (d + j) * e
  s.v = (s.v - omega * j) * e
  return s.x
}

/** General damped spring with an optional external acceleration (jelly, wobble).
 *  Semi-implicit Euler sub-stepped at 240 Hz, so it is stable and frame-rate independent. */
export function spring2(s: S1, target: number, omega: number, zeta: number, dt: number, force = 0) {
  const n = Math.max(1, Math.ceil(dt * 240))
  const h = dt / n
  const k = omega * omega
  const c = 2 * zeta * omega
  for (let i = 0; i < n; i++) {
    s.v += (force - k * (s.x - target) - c * s.v) * h
    s.x += s.v * h
  }
  return s.x
}

/** Yaw spring that always turns the short way; s.x stays continuous (unwrapped). */
export function angleSpring(s: S1, target: number, omega: number, zeta: number, dt: number) {
  return spring2(s, s.x + wrapPi(target - s.x), omega, zeta, dt)
}

/** A bean that can be bumped: world position/velocity plus spring offsets and weeble tilt. */
export interface Body {
  x: number
  z: number
  vx: number
  vz: number
  bx: S1
  bz: S1
  tiltX: S1
  tiltZ: S1
  inv: number
}

/** Soft contact between two upright beans (discs of combined radius R on the ground).
 *  Positional split by inverse mass, then a restitution impulse along the normal that
 *  also kicks both weeble tilts, so heads tip away from each other. Returns the impulse. */
export function collide(a: Body, b: Body, R = 1.4, e = 0.3, tip = 0.6) {
  let nx = b.x - a.x
  let nz = b.z - a.z
  const d2 = nx * nx + nz * nz
  if (d2 >= R * R || d2 < 1e-8) return -1
  const d = Math.sqrt(d2)
  nx /= d
  nz /= d
  const w = a.inv + b.inv
  const pen = R - d
  a.bx.x -= (nx * pen * a.inv) / w
  a.bz.x -= (nz * pen * a.inv) / w
  b.bx.x += (nx * pen * b.inv) / w
  b.bz.x += (nz * pen * b.inv) / w
  const vn = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz
  if (vn >= 0) return 0 // already separating
  const j = Math.min((-(1 + e) * vn) / w, 3)
  a.bx.v -= j * nx * a.inv
  a.bz.v -= j * nz * a.inv
  b.bx.v += j * nx * b.inv
  b.bz.v += j * nz * b.inv
  // the lighter bean wobbles more
  const ta = (tip * 2 * a.inv) / w
  const tb = (tip * 2 * b.inv) / w
  a.tiltX.v -= nx * j * ta
  a.tiltZ.v -= nz * j * ta
  b.tiltX.v += nx * j * tb
  b.tiltZ.v += nz * j * tb
  return j
}

/** Deterministic PRNG (so the crowd and trees land in the same places every load). */
export function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
