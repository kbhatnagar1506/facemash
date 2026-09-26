import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { useFrame, useThree, type RootState } from '@react-three/fiber'
import { Preload } from '@react-three/drei'
import * as THREE from 'three'
import type { Look } from '../look'
import { LandingBean } from './LandingBean'
import { makePose, type Pose } from './pose'
import { BEAT_D, BEAT_LIST, CROWD_A, CROWD_B, L, N_SECTIONS, path, place, ps, sample, type PS } from './path'
import { angleSpring, clamp, collide, crit, damp, lerp, lerpAngle, rng, s1, smootherstep, smoothstep, snap, spring2, type Body, type S1 } from './physics'
import { CROWD_FAR, CROWD_NEAR, crowdColors, crowdReset, makeCrowd, stepCrowd, type Crowd } from './crowd'
import { blobTexture, bugTag, checkTag, matchCard, visorFace } from './textures'
import type { Shared } from './shared'

// The whole scene runs from one Director (useFrame at priority -1, before every bean's
// own frame): scroll → story position → the hero's arrive controller → collisions →
// springs → the crowd → props → camera → DOM. Nothing reads the raw scroll except the
// Director, so the bean, the camera, the crowd and the progress bar always agree.

export const PAPER = '#F3EEE6'
const GROUND = '#E8E1D4'

const HERO: Look = { body: '#3b63c4', accent: '#ffffff', pattern: 'solid', eyes: 'dots', hat: 'headphones', item: 'phone', logo: 'hackgt' }
const FRIEND: Look = { body: '#ff7eb6', accent: '#ffffff', pattern: 'hearts', eyes: 'happy', hat: 'bunny', item: 'boba' }
const MATCH: Look = { body: '#ffc93c', accent: '#ff5d6c', pattern: 'solid', eyes: 'star', hat: 'cap', item: 'coffee' }
const SMALL: Look[] = [
  { body: '#7ad36b', accent: '#ffffff', pattern: 'solid', eyes: 'dots', hat: 'none', item: 'coffee' },
  { body: '#9b6bd1', accent: '#ffe066', pattern: 'stripes', eyes: 'happy', hat: 'party', item: 'none' },
  { body: '#ff8a3d', accent: '#ffffff', pattern: 'split', eyes: 'wink', hat: 'crown', item: 'none' },
  { body: '#2bb3a6', accent: '#ffffff', pattern: 'dots', eyes: 'dots', hat: 'propeller', item: 'duck' },
]
const STUCK: Look = { body: '#8e9aaf', accent: '#ffffff', pattern: 'solid', eyes: 'sleepy', hat: 'none', item: 'laptop' }
const FIXER: Look = { body: '#2bb3a6', accent: '#ffe066', pattern: 'stripes', eyes: 'dots', hat: 'bucket', item: 'laptop' }

/* ------------------------------------------------------------------ world state */

const HERO_R = 1.4 // two beans touch at this centre distance
/** the finale pair stop a little short of touching (visors and arms stick out past the
 *  body), so both faces stay whole while they stand face to face */
const MEET_R = 1.8
/** in the finale, how far each bean turns from facing the other toward the camera */
const TOGETHER_CAM = 0.55
const STOOL = 0.42
const BUG_D = BEAT_D.bug
const APPS_D = BEAT_D.apps
/** the bug beat: one row of three tables running off to the right of the path */
const BUG_ROW = BUG_D + 0.8
const BUG_LAT = [2.4, 4.35, 6.3]
const FIN_D = BEAT_D.finale
const MATCH_HOME = L - 0.2

type G = RefObject<THREE.Group | null>
type Mref = RefObject<THREE.Mesh | null>

interface Npc extends Body {
  hx: number
  hz: number
  y: number
  d: number
  yaw: S1
  yawHome: number
  pose: Pose
  omega: number
  zeta: number
  slump: number
  root: G
  yawG: G
  lean: G
  shadow: Mref
  touching: boolean
  cool: number
  faceUntil: number
  waveFrom: number
  waveUntil: number
}

const ref = <T,>(): RefObject<T | null> => ({ current: null })

function makeNpc(d: number, lat: number, yawHome: number, o: PS, y = 0): Npc {
  place(d, lat, o)
  return {
    x: o.x,
    z: o.z,
    vx: 0,
    vz: 0,
    bx: s1(),
    bz: s1(),
    tiltX: s1(),
    tiltZ: s1(),
    inv: 1,
    hx: o.x,
    hz: o.z,
    y,
    d,
    yaw: s1(yawHome),
    yawHome,
    pose: makePose(),
    omega: 6,
    zeta: 0.6,
    slump: 0,
    root: ref(),
    yawG: ref(),
    lean: ref(),
    shadow: ref(),
    touching: false,
    cool: 0,
    faceUntil: 0,
    waveFrom: 0,
    waveUntil: 0,
  }
}

const APART = 0
const APPROACH = 1
const BUMP = 2
const CHEER = 3
const TOGETHER = 4

function createWorld() {
  const o = ps()
  // the friend: just off the path, busy with their boba, facing away from the lane
  sample(BEAT_D.friend - 1.0, o)
  const friend = makeNpc(BEAT_D.friend - 1.0, 1.05, Math.atan2(o.rx, o.rz), o)
  friend.omega = 5
  friend.zeta = 0.5
  // the same four faces: a little circle chatting just off the path, open on the side you walk past
  const RING: [number, number][] = [
    [5.0, 1.55],
    [4.7, 3.7],
    [2.6, 3.9],
    [2.4, 1.6],
  ]
  const c = ps()
  place(BEAT_D.small + 3.7, 2.7, c)
  const ring = RING.map(([along, lat]) => {
    place(BEAT_D.small + along, lat, o)
    return makeNpc(BEAT_D.small + along, lat, Math.atan2(c.x - o.x, c.z - o.z), o)
  })
  // the bug: three tables in a row, stuck at the first, the fix at the third
  sample(BUG_ROW, o)
  const stuck = makeNpc(BUG_ROW, BUG_LAT[0], o.heading + Math.PI, o, STOOL)
  stuck.slump = 0.12
  stuck.pose.sit = true
  const fixer = makeNpc(BUG_ROW, BUG_LAT[2], o.heading + Math.PI - 0.1, o, STOOL)
  fixer.pose.sit = true
  // the match, at the end of the path, facing back toward you
  sample(MATCH_HOME, o)
  const match = makeNpc(MATCH_HOME, 0, o.heading + Math.PI, o)
  match.inv = 1

  return {
    first: true,
    snap: true,
    resumed: false,
    f: 0,
    hero: {
      d: 0,
      v: 0,
      a: 0,
      aS: 0,
      dir: 1,
      idle: 3,
      x: 0,
      z: 0,
      vx: 0,
      vz: 0,
      bx: s1(),
      bz: s1(),
      tiltX: s1(),
      tiltZ: s1(),
      inv: 0.5,
      yaw: s1(),
      bank: s1(),
      pitch: s1(),
      sq: s1(),
      armed: false,
      glance: s1(),
      glanceUntil: 0,
      glanceYaw: 0,
      introDone: false,
      pose: makePose(),
      root: ref<THREE.Group>(),
      yawG: ref<THREE.Group>(),
      lean: ref<THREE.Group>(),
      shadow: ref<THREE.Mesh>(),
    },
    friend,
    ring,
    ringNear: false,
    stuck,
    fixer,
    match: Object.assign(match, { md: MATCH_HOME, mv: 0, mdir: -1, midle: 3 }),
    fin: { state: APART, settle: 0, t0: 0, heroT: FIN_D, matchT: MATCH_HOME, armed: true, heroCheered: false, matchCheered: false },
    crowd: makeCrowd(),
    crowdOn: false, // the crowd meshes are currently drawn
    thread: { drawn: s1(), sag: s1(), plucked: false, pulse: 0, bugOn: false, fixOn: false, bugPop: s1(), fixPop: s1() },
    card: { mode: 0, on: false, x: s1(), y: s1(2.6), z: s1(), vx: 0, vy: 0, vz: 0, rx: s1(), pop: s1(), dim: s1(1), yaw: 0 },
    meetT: -1,
    cam: { dist: s1(8), pitch: s1(0.2), orbit: s1(0), nx: s1(0), ny: s1(0), fov: s1(40), ax: s1(), ay: s1(1.15), az: s1(), drift: 0 },
    last: { progress: -1, side: -1, center: -1, bottom: -1, cue: false, copyTop: -1 },
    refs: {
      sun: ref<THREE.DirectionalLight>(),
      hemi: ref<THREE.HemisphereLight>(),
      crowdBody: ref<THREE.InstancedMesh>(),
      crowdVisor: ref<THREE.InstancedMesh>(),
      crowdShadow: ref<THREE.InstancedMesh>(),
      dots: ref<THREE.InstancedMesh>(),
      bugTag: ref<THREE.Sprite>(),
      fixTag: ref<THREE.Sprite>(),
      card: ref<THREE.Mesh>(),
      meet: ref<THREE.Mesh>(),
    },
  }
}
type World = ReturnType<typeof createWorld>

/* ------------------------------------------------------------------ scratch (no allocation per frame) */

const P = ps() // path at the hero
const AH = ps() // look-ahead
const Q = ps() // scratch
const MP = ps() // path at the match
const _v = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _shift = new THREE.Vector3()
const _look = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const SUN_OFF = new THREE.Vector3(5, 10, 4)
const SUN_DIR = SUN_OFF.clone().normalize().negate()
const SUN_R = new THREE.Vector3().crossVectors(SUN_DIR, UP).normalize()
const SUN_U = new THREE.Vector3().crossVectors(SUN_R, SUN_DIR).normalize()
const SUN_WHITE = new THREE.Color('#FFF4E5')
const SUN_GOLD = new THREE.Color('#FFCF8A')
const SKY_WHITE = new THREE.Color('#FFFFFF')
const SKY_WARM = new THREE.Color('#FFF0DA')
const WHITE = new THREE.Color('#ffffff')
const GOLD_DOT = new THREE.Color('#F2B705')

/** Reading pace: the bean eases in and out of each beat, so the scene is calm while you read. */
const hold = (x: number) => x + 0.55 * (smootherstep(x, 0, 1) - x)

function writeNpc(n: Npc, heroD: number) {
  const r = n.root.current
  if (!r) return
  const vis = Math.abs(n.d - heroD) < 45
  r.visible = vis
  if (n.shadow.current) n.shadow.current.visible = vis
  if (!vis) return
  r.position.set(n.x, n.y, n.z)
  r.rotation.set(n.tiltZ.x, 0, -n.tiltX.x)
  if (n.yawG.current) n.yawG.current.rotation.y = n.yaw.x
  if (n.lean.current) n.lean.current.rotation.x = n.slump
  if (n.shadow.current) n.shadow.current.position.set(n.x, 0.055, n.z)
}

function stepNpcSprings(n: Npc, dt: number) {
  spring2(n.bx, 0, n.omega, n.zeta, dt)
  spring2(n.bz, 0, n.omega, n.zeta, dt)
  spring2(n.tiltX, 0, 9, 0.22, dt)
  spring2(n.tiltZ, 0, 9, 0.22, dt)
  n.tiltX.x = clamp(n.tiltX.x, -0.3, 0.3)
  n.tiltZ.x = clamp(n.tiltZ.x, -0.3, 0.3)
}

function cheerJump(c: number) {
  const k = c / 1000
  return k > 0.18 && k < 0.78 ? Math.sin(((k - 0.18) / 0.6) * Math.PI) * 0.95 : 0
}

/* ------------------------------------------------------------------ the Director */

function useDirector(w: World, shared: Shared) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  useEffect(() => {
    const on = () => {
      if (document.visibilityState === 'visible') w.resumed = true
    }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [w])

  const step = (state: RootState, rawDt: number) => {
    let dt = Math.min(Math.max(rawDt, 0), 1 / 20)
    if (w.resumed || w.first) {
      dt = 0
      w.resumed = false
    }
    const t = state.clock.elapsedTime
    const now = performance.now()
    const sh = shared
    const reduced = sh.reduced
    const n = N_SECTIONS
    const h = w.hero

    /* 1. scroll → section float f → the bean's target arc position */
    const A = sh.anchors
    const y = clamp(window.scrollY, 0, sh.maxScroll)
    let f = 0
    if (y >= A[n - 1]) f = n - 1
    else if (y > A[0]) {
      let i = 0
      while (i < n - 2 && y > A[i + 1]) i++
      f = i + (y - A[i]) / Math.max(1, A[i + 1] - A[i])
    }
    w.f = f
    const si = Math.min(n - 2, Math.floor(f))
    let dT = lerp(BEAT_LIST[si], BEAT_LIST[si + 1], hold(f - si))
    const sec = Math.round(f)

    /* 2. the finale: one state machine, one trigger */
    const fin = w.fin
    const mt = w.match
    let matchTarget = MATCH_HOME
    if (fin.state !== APART && f < n - 1.6) {
      fin.state = APART
      fin.heroCheered = fin.matchCheered = false
    }
    if (!fin.armed && Math.abs(mt.md - h.d) > MEET_R + 0.8) fin.armed = true
    if (fin.state === APART) {
      if (fin.armed && f >= n - 1.35 && Math.abs(dT - h.d) < 0.3 && Math.abs(h.v) < 0.4) fin.settle += dt
      else fin.settle = 0
      if (fin.settle > 0.25) {
        fin.state = APPROACH
        fin.settle = 0
      }
    }
    if (fin.state === APPROACH) {
      dT = FIN_D + 0.9
      matchTarget = MATCH_HOME - 0.9
    } else if (fin.state !== APART) {
      dT = fin.heroT
      matchTarget = fin.matchT
    }

    /* 3. the hero's arrive controller: bounded acceleration, no overshoot */
    let err = dT - h.d
    if (w.first) {
      h.d = dT
      h.v = 0
      err = 0
    } else if (Math.abs(err) > 40) {
      // Home / End: cut instead of fast-forwarding across the world
      h.d = dT - Math.sign(err) * 3
      h.v = 0
      w.snap = true
      err = dT - h.d
    }
    if (w.snap) crowdReset(w.crowd, dT)
    const V_MAX = 11
    const vDes = Math.sign(err) * Math.min(V_MAX, 0.9 * Math.sqrt(2 * 16 * Math.abs(err)), 3.4 * Math.abs(err))
    const speedingUp = Math.abs(vDes) > Math.abs(h.v) && Math.sign(vDes) === Math.sign(h.v || vDes)
    const lim = (speedingUp ? 24 : 20) * dt
    const v0 = h.v
    h.v += clamp(vDes - h.v, -lim, lim)
    h.d += (v0 + h.v) * 0.5 * dt
    if (Math.abs(dT - h.d) < 0.003 && Math.abs(h.v) < 0.02) {
      h.d = dT
      h.v = 0
    }
    h.a = dt > 0 ? (h.v - v0) / dt : 0
    h.aS = damp(h.aS, h.a, 18, dt)
    const speed = Math.abs(h.v)
    h.idle = speed < 0.12 ? h.idle + dt : 0

    /* 4. the path under the hero */
    sample(h.d, P)
    h.x = P.x + h.bx.x
    h.z = P.z + h.bz.x
    h.vx = P.tx * h.v + h.bx.v
    h.vz = P.tz * h.v + h.bz.v

    // the match walks its own path toward its target
    {
      const e2 = matchTarget - mt.md
      const vd = Math.sign(e2) * Math.min(2.2, 0.9 * Math.sqrt(2 * 8 * Math.abs(e2)), 3 * Math.abs(e2))
      const l2 = 10 * dt
      const mv0 = mt.mv
      mt.mv += clamp(vd - mt.mv, -l2, l2)
      mt.md += (mv0 + mt.mv) * 0.5 * dt
      if (w.first) {
        mt.md = matchTarget
        mt.mv = 0
      }
      sample(mt.md, MP)
      mt.d = mt.md
      mt.x = MP.x + mt.bx.x
      mt.z = MP.z + mt.bz.x
      mt.vx = MP.tx * mt.mv + mt.bx.v
      mt.vz = MP.tz * mt.mv + mt.bz.v
    }

    /* 5. contact: the friend you bump into, and the one you meet */
    const fr = w.friend
    fr.x = fr.hx + fr.bx.x
    fr.z = fr.hz + fr.bz.x
    fr.vx = fr.bx.v
    fr.vz = fr.bz.v
    const tip = reduced ? 0.18 : 0.6
    const j = collide(h, fr, HERO_R, 0.3, tip)
    const touching = j >= 0
    if (touching && !fr.touching && t > fr.cool && !w.first) {
      // even a slow brush gets a visible wobble
      if (j < 0.5) {
        const nx = fr.x - h.x
        const nz = fr.z - h.z
        const nl = Math.hypot(nx, nz) || 1
        const k = (0.5 - Math.max(0, j)) * tip
        fr.tiltX.v += (nx / nl) * k
        fr.tiltZ.v += (nz / nl) * k
        h.tiltX.v -= (nx / nl) * k * 0.5
        h.tiltZ.v -= (nz / nl) * k * 0.5
      }
      fr.cool = t + 1.2
      fr.faceUntil = t + 3.2
      fr.waveFrom = t + 0.15
      fr.waveUntil = t + 1.75
      h.glanceUntil = t + 1.05
    }
    fr.touching = touching
    if (Math.hypot(fr.x - h.x, fr.z - h.z) < 2.6 && t < fr.faceUntil) fr.faceUntil = Math.max(fr.faceUntil, t + 0.6)

    if (fin.state === APPROACH || fin.state >= BUMP) {
      const dx = mt.x - h.x
      const dz = mt.z - h.z
      const dist = Math.hypot(dx, dz)
      const jm = collide(h, mt, MEET_R, 0.3, reduced ? 0.27 : 0.9)
      if (jm >= 0 && fin.state === APPROACH) {
        const pen = Math.max(0, MEET_R - dist)
        fin.heroT = h.d - pen / 2
        fin.matchT = mt.md + pen / 2
        fin.state = BUMP
        fin.t0 = t
        fin.armed = false
      }
    }
    if (fin.state === BUMP || fin.state === CHEER) {
      const e = t - fin.t0
      if (e > 0.28 && !fin.heroCheered) {
        h.pose.av.cheer = now
        fin.heroCheered = true
        w.meetT = t
      }
      if (e > 0.36 && !fin.matchCheered) {
        mt.pose.av.cheer = now
        fin.matchCheered = true
        fin.state = CHEER
      }
      if (e > 0.36 + 1.25) fin.state = TOGETHER
    }

    /* 6. the hero's springs: bump offset, weeble, lean into turns, jelly, settle, yaw */
    spring2(h.bx, 0, 6, 0.6, dt)
    spring2(h.bz, 0, 6, 0.6, dt)
    spring2(h.tiltX, 0, 9, 0.22, dt)
    spring2(h.tiltZ, 0, 9, 0.22, dt)
    h.tiltX.x = clamp(h.tiltX.x, -0.3, 0.3)
    h.tiltZ.x = clamp(h.tiltZ.x, -0.3, 0.3)
    const g = reduced ? 0 : 1
    const lx = Math.cos(h.yaw.x)
    const lz = -Math.sin(h.yaw.x)
    const acx = h.v * h.v * P.kx
    const acz = h.v * h.v * P.kz
    spring2(h.bank, -clamp(Math.atan((acx * lx + acz * lz) / 45), -0.16, 0.16) * g, 7, 0.8, dt)
    const aF = h.aS * h.dir
    spring2(h.pitch, clamp(0.012 * speed, 0, 0.13) * g, 9, 0.45, dt, -0.2 * aF * g)
    h.pitch.x = clamp(h.pitch.x, -0.22, 0.22)
    if (h.armed && speed < 0.25) {
      h.sq.v -= 0.9 * g
      h.armed = false
    }
    if (speed > 1.5) h.armed = true
    spring2(h.sq, 0, 14, 0.4, dt)
    h.x = P.x + h.bx.x
    h.z = P.z + h.bz.x

    /* 7. NPC springs, glances, waves */
    stepNpcSprings(fr, dt)
    fr.x = fr.hx + fr.bx.x
    fr.z = fr.hz + fr.bz.x
    {
      const toHero = Math.atan2(h.x - fr.x, h.z - fr.z)
      if (t < fr.faceUntil) angleSpring(fr.yaw, toHero, 7, 0.8, dt)
      else angleSpring(fr.yaw, fr.yawHome, 3, 0.9, dt)
      fr.pose.wave = t > fr.waveFrom && t < fr.waveUntil
    }
    // the ring of familiar faces: glance at you, two of them wave
    {
      let near = false
      for (let i = 0; i < w.ring.length; i++) {
        const r = w.ring[i]
        stepNpcSprings(r, dt)
        r.x = r.hx + r.bx.x
        r.z = r.hz + r.bz.x
        const dist = Math.hypot(h.x - r.x, h.z - r.z)
        if (dist < 5) near = true
        const wgt = 0.7 * (1 - smoothstep(dist, 3, 7))
        angleSpring(r.yaw, lerpAngle(r.yawHome, Math.atan2(h.x - r.x, h.z - r.z), wgt), 5, 0.8, dt)
        r.pose.wave = t > r.waveFrom && t < r.waveUntil
      }
      if (near && !w.ringNear) {
        w.ring[0].waveFrom = t + 0.4
        w.ring[0].waveUntil = t + 1.8
        w.ring[1].waveFrom = t + 1.1
        w.ring[1].waveUntil = t + 2.5
      }
      if (near) w.ringNear = true
      else if (Math.abs(h.d - BEAT_D.small) > 8) w.ringNear = false
    }
    stepNpcSprings(w.stuck, dt)
    stepNpcSprings(w.fixer, dt)
    // the match: faces you, walks when told, turns toward the camera once you've met
    {
      stepNpcSprings(mt, dt)
      mt.x = MP.x + mt.bx.x
      mt.z = MP.z + mt.bz.x
      if (mt.mv > 0.5) mt.mdir = 1
      else if (mt.mv < -0.5) mt.mdir = -1
      mt.midle = Math.abs(mt.mv) < 0.12 ? mt.midle + dt : 0
      let yawT = mt.mdir > 0 ? MP.heading : MP.heading + Math.PI
      if (Math.abs(mt.mv) < 0.12) yawT = Math.atan2(h.x - mt.x, h.z - mt.z)
      if (fin.state === TOGETHER) {
        // turned toward each other, opened out a little to the camera: both faces show
        // (standing still, yawT already faces the hero)
        const toCam = Math.atan2(camera.position.x - mt.x, camera.position.z - mt.z)
        yawT = lerpAngle(yawT, toCam, TOGETHER_CAM * smoothstep(mt.midle, 0.3, 1.2))
      }
      if (w.first) snap(mt.yaw, yawT)
      angleSpring(mt.yaw, yawT, 7, 0.8, dt)
      mt.pose.speed = Math.abs(mt.mv)
      mt.pose.calm = reduced
    }

    /* 8. the crowd: simulated while it's anywhere near, drawn only while someone is above ground */
    const crowdOn = h.d > CROWD_NEAR && h.d < CROWD_FAR
    const cb = w.refs.crowdBody.current
    if (cb) {
      if (crowdOn || w.first) {
        stepCrowd(w.crowd, h, P, t, dt, reduced, cb.instanceMatrix.array)
        cb.instanceMatrix.needsUpdate = true
      }
      const show = crowdOn && w.crowd.up > 0.01
      if (show !== w.crowdOn) {
        cb.visible = show
        if (w.refs.crowdVisor.current) w.refs.crowdVisor.current.visible = show
        if (w.refs.crowdShadow.current) w.refs.crowdShadow.current.visible = show
        w.crowdOn = show
      }
    }

    /* 9a. the bug: a thread draws itself from the stuck bean to the fix, then plucks taut */
    {
      const th = w.thread
      const a = w.stuck
      const b = w.fixer
      crit(th.drawn, smoothstep(h.d, BUG_D - 1.6, BUG_D - 0.2), 5, dt)
      if (w.snap) snap(th.drawn, smoothstep(h.d, BUG_D - 1.6, BUG_D - 0.2))
      if (!th.plucked && th.drawn.x > 0.985) {
        th.plucked = true
        if (!reduced) th.sag.v = -4.5
      }
      if (th.drawn.x < 0.5) th.plucked = false
      spring2(th.sag, 0, 12, 0.16, dt)
      const dots = w.refs.dots.current
      const near = Math.abs(h.d - BUG_D) < 30
      if (dots) {
        dots.visible = near && th.drawn.x > 0.002
        if (dots.visible) {
          const ay = STOOL + 2.2
          for (let i = 0; i < 40; i++) {
            const u = i / 39
            const k = clamp(th.drawn.x * 39 - i + 1, 0, 1)
            const pop = k === 0 ? 0 : 1 + 2.5 * (k - 1) ** 3 + 1.5 * (k - 1) ** 2
            _v.set(lerp(a.x, b.x, u), ay + 4 * u * (1 - u) * (1.0 + th.sag.x), lerp(a.z, b.z, u))
            _m.compose(_v, _q.identity(), _s.setScalar(0.05 * pop))
            dots.setMatrixAt(i, _m)
          }
          // once it's drawn, the fix travels back along it every 2.2 s
          let ps2 = 0
          if (th.drawn.x > 0.98 && !reduced) {
            th.pulse = (th.pulse + dt / 2.2) % 1
            ps2 = th.pulse < 0.6 ? Math.sin((th.pulse / 0.6) * Math.PI) : 0
          }
          const u = 1 - smootherstep(Math.min(1, th.pulse / 0.6), 0, 1)
          _v.set(lerp(a.x, b.x, u), ay + 4 * u * (1 - u) * (1.0 + th.sag.x), lerp(a.z, b.z, u))
          _m.compose(_v, _q.identity(), _s.setScalar(0.085 * ps2))
          dots.setMatrixAt(40, _m)
          dots.instanceMatrix.needsUpdate = true
        }
      }
      // glyph tags: the bug shows as you approach; the check only once the thread lands
      if (h.d > BUG_D - 9) th.bugOn = true
      else if (h.d < BUG_D - 9.8) th.bugOn = false
      if (th.drawn.x > 0.95) th.fixOn = true
      else if (th.drawn.x < 0.5) th.fixOn = false
      popTag(w.refs.bugTag.current, th.bugPop, th.bugOn, a.x, STOOL + 2.82, a.z, t, dt, reduced, 1.3)
      popTag(w.refs.fixTag.current, th.fixPop, th.fixOn, b.x, STOOL + 2.82, b.z, t, dt, reduced, 2.1)
    }

    /* 10. camera: spring the framing parameters, then solve the pose */
    const cam = w.cam
    const fr0 = sh.frames[si]
    const fr1 = sh.frames[si + 1]
    const cw = smootherstep(clamp((f - si - 0.3) / 0.4, 0, 1), 0, 1)
    const om = reduced ? 4 : 3
    const tDist = lerp(fr0.dist, fr1.dist, cw)
    const tPitch = lerp(fr0.pitch, fr1.pitch, cw)
    const tOrbit = lerp(fr0.orbit, fr1.orbit, cw)
    const tNx = lerp(fr0.nx, fr1.nx, cw)
    const tNy = lerp(fr0.ny, fr1.ny, cw)
    const tFov = lerp(fr0.fov, fr1.fov, cw) + (reduced ? 0 : 3 * smoothstep(speed, 3, 10))
    // a slow breath of camera drift while the bean stands still
    cam.drift = damp(cam.drift, reduced ? 0 : smoothstep(h.idle, 2, 4), 2, dt)
    const la = reduced ? 0 : clamp(h.v * 0.25, -2.5, 2.5)
    // the finale frames both beans
    const wFin = smoothstep(f, n - 1.7, n - 1.05)
    const mx = lerp(P.x, (P.x + MP.x) / 2, wFin)
    const mz = lerp(P.z, (P.z + MP.z) / 2, wFin)
    const axT = mx + P.tx * la
    const azT = mz + P.tz * la
    if (w.snap || w.first) {
      snap(cam.dist, tDist)
      snap(cam.pitch, tPitch)
      snap(cam.orbit, tOrbit)
      snap(cam.nx, tNx)
      snap(cam.ny, tNy)
      snap(cam.fov, tFov)
      snap(cam.ax, axT)
      snap(cam.ay, 1.15)
      snap(cam.az, azT)
    }
    crit(cam.dist, tDist, om, dt)
    crit(cam.pitch, tPitch, om, dt)
    crit(cam.orbit, tOrbit, om, dt)
    crit(cam.nx, tNx, om, dt)
    crit(cam.ny, tNy, om, dt)
    crit(cam.fov, tFov, om, dt)
    crit(cam.ax, axT, 6, dt)
    crit(cam.ay, 1.15, 6, dt)
    crit(cam.az, azT, 6, dt)
    // fog per section: the opening shot is quiet, the crowd shots see further
    const fog = state.scene.fog as THREE.Fog | null
    if (fog) {
      const k = sh.narrow ? 0.9 : 1
      fog.near = lerp(FOG_NEAR[si], FOG_NEAR[si + 1], cw) * k
      fog.far = lerp(FOG_FAR[si], FOG_FAR[si + 1], cw) * k
    }
    const pitch = cam.pitch.x + 0.012 * Math.sin(0.27 * t) * cam.drift
    const orbit = cam.orbit.x + 0.03 * Math.sin(0.35 * t) * cam.drift
    const dist = cam.dist.x
    const cp = Math.cos(pitch)
    _look.set(cam.ax.x, cam.ay.x, cam.az.x)
    camera.position.set(_look.x + dist * cp * Math.sin(orbit), _look.y + dist * Math.sin(pitch), _look.z + dist * cp * Math.cos(orbit))
    _fwd.subVectors(_look, camera.position).normalize()
    _right.crossVectors(_fwd, UP).normalize()
    _up.crossVectors(_right, _fwd)
    const aspect = camera.aspect || 1
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(cam.fov.x) / 2)
    const halfW = halfH * aspect
    // truck (don't rotate) so the anchor lands at (nx, ny) and the horizon stays level
    _shift.copy(_right).multiplyScalar(-cam.nx.x * halfW).addScaledVector(_up, -cam.ny.x * halfH)
    camera.position.add(_shift)
    _look.add(_shift)
    camera.lookAt(_look)
    if (Math.abs(camera.fov - cam.fov.x) > 0.01) {
      camera.fov = cam.fov.x
      camera.updateProjectionMatrix()
    }

    /* 6b. the hero's facing (needs the camera) and transforms */
    if (h.v > 0.6) h.dir = 1
    else if (h.v < -0.6) h.dir = -1
    sample(h.d + h.dir * 1.2, AH)
    let yawT = AH.heading + (h.dir < 0 ? Math.PI : 0)
    const toCam = Math.atan2(camera.position.x - h.x, camera.position.z - h.z)
    const faceCam = sec === 0 ? 1 : sec === n - 1 ? (fin.state === TOGETHER ? 0.45 : 0) : 0.8
    yawT = lerpAngle(yawT, toCam, smoothstep(h.idle, 0.45, 1.3) * faceCam)
    if (fin.state === TOGETHER) yawT = lerpAngle(Math.atan2(mt.x - h.x, mt.z - h.z), toCam, TOGETHER_CAM * smoothstep(h.idle, 0.3, 1.2))
    // look back at the friend after the bump
    crit(h.glance, t < h.glanceUntil ? 0.6 : 0, t < h.glanceUntil ? 8 : 4, dt)
    h.glanceYaw = Math.atan2(fr.x - h.x, fr.z - h.z)
    yawT = lerpAngle(yawT, h.glanceYaw, h.glance.x)
    if (w.first || w.snap) snap(h.yaw, yawT)
    angleSpring(h.yaw, yawT, speed > 0.3 ? 10 : 6, 0.8, dt)

    // intro: one small wave, once, a moment after the page is ready
    const readyFor = sh.readyAt ? (now - sh.readyAt) / 1000 : -1
    const intro = !h.introDone && readyFor > 1.2 && readyFor < 2.6 && f < 0.3
    if (readyFor > 2.6 || f > 0.3) h.introDone = h.introDone || readyFor > 0
    h.pose.wave = intro
    h.pose.speed = speed
    h.pose.calm = reduced
    h.pose.pocket = fin.state !== APART || f > n - 1.45

    const root = h.root.current
    if (root) {
      root.position.set(h.x, 0, h.z)
      root.rotation.set(h.tiltZ.x, 0, -h.tiltX.x)
      if (h.yawG.current) h.yawG.current.rotation.y = h.yaw.x
      const ln = h.lean.current
      if (ln) {
        ln.rotation.set(h.pitch.x, 0, h.bank.x)
        const sy = 1 + h.sq.x
        const sxz = 1 / Math.sqrt(Math.max(0.5, sy))
        ln.scale.set(sxz, sy, sxz)
      }
      const sd = h.shadow.current
      if (sd) {
        const jmp = h.pose.av.cheer ? cheerJump(now - h.pose.av.cheer) * (reduced ? 0.3 : 1) : 0
        sd.position.set(h.x, 0.055, h.z)
        sd.scale.setScalar(1 - 0.3 * jmp)
        ;(sd.material as THREE.MeshBasicMaterial).opacity = 0.2 * (1 - 0.5 * jmp)
      }
    }
    writeNpc(fr, h.d)
    for (const r of w.ring) writeNpc(r, h.d)
    writeNpc(w.stuck, h.d)
    writeNpc(w.fixer, h.d)
    writeNpc(mt, h.d)

    /* 9b. the networking app: hovers beside you, unopened, then drops */
    stepCard(w, h, camera, t, dt, reduced, sh.narrow)

    /* 9c. the meet: one gold ring on the ground, once */
    {
      const ring = w.refs.meet.current
      if (ring) {
        const k = w.meetT >= 0 ? (t - w.meetT) / 1.4 : 2
        ring.visible = k >= 0 && k <= 1 && !reduced
        if (ring.visible) {
          const s = 0.6 + 0.4 * (1 - Math.pow(2, -10 * k))
          ring.scale.setScalar(s)
          ring.position.set((h.x + mt.x) / 2, 0.06, (h.z + mt.z) / 2)
          ;(ring.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - k) ** 1.5
        }
      }
    }

    /* sun: follows the hero, snapped to shadow texels (no shimmer); warms for Sunday afternoon */
    const sun = w.refs.sun.current
    if (sun) {
      _v.set(P.x, 0, P.z)
      const texel = 22 / 1024
      const ru = _v.dot(SUN_R)
      const uu = _v.dot(SUN_U)
      _v.addScaledVector(SUN_R, Math.round(ru / texel) * texel - ru).addScaledVector(SUN_U, Math.round(uu / texel) * texel - uu)
      sun.target.position.copy(_v)
      sun.position.copy(_v).add(SUN_OFF)
      sun.target.updateMatrixWorld()
      const warm = smoothstep(f, 4.4, 5.0) * (1 - smoothstep(f, 5.55, 6.15))
      sun.color.copy(SUN_WHITE).lerp(SUN_GOLD, warm * 0.85)
      sun.intensity = 2.0 + 0.25 * warm
      const hemi = w.refs.hemi.current
      if (hemi) hemi.color.copy(SKY_WHITE).lerp(SKY_WARM, warm)
    }

    /* 11. DOM: progress, scroll cue, scrims — only when something changed */
    const last = w.last
    const pk = clamp(h.d / L, 0, 1)
    if (sh.progress && Math.abs(pk - last.progress) > 0.0005) {
      sh.progress.style.transform = `scaleX(${pk.toFixed(4)})`
      last.progress = pk
    }
    const gone = y > 24
    if (sh.cue && gone !== last.cue) {
      sh.cue.classList.toggle('gone', gone)
      last.cue = gone
    }
    const narrow = sh.narrow
    const wSide = scrim(f, narrow ? SIDE_M : SIDE_D)
    const wCenter = narrow ? 0 : scrim(f, CENTER_D)
    const wBottom = scrim(f, BOTTOM)
    if (sh.scrimSide && Math.abs(wSide - last.side) > 0.004) {
      sh.scrimSide.style.opacity = wSide.toFixed(3)
      last.side = wSide
    }
    // phones: the scrim fades in just above wherever this section's copy starts
    if (narrow && sh.scrimSide) {
      const at = (i: number) => sh.frames[clamp(i, 1, n - 2)].copyTop
      const ct = lerp(at(si), at(si + 1), smoothstep(f - si, 0.3, 0.7))
      if (Math.abs(ct - last.copyTop) > 0.5) {
        sh.scrimSide.style.setProperty('--copy-top', `${ct.toFixed(1)}px`)
        last.copyTop = ct
      }
    }
    if (sh.scrimCenter && Math.abs(wCenter - last.center) > 0.004) {
      sh.scrimCenter.style.opacity = wCenter.toFixed(3)
      last.center = wCenter
    }
    if (sh.scrimBottom && Math.abs(wBottom - last.bottom) > 0.004) {
      sh.scrimBottom.style.opacity = wBottom.toFixed(3)
      last.bottom = wBottom
    }

    if (w.first) {
      w.first = false
      sh.framed = true
      sh.onFirstFrame?.()
    }
    w.snap = false
  }
  useFrame((state: RootState, rawDt: number) => {
    // dev only: window.__sub = N runs N simulation steps per frame (for inspecting a throttled
    // preview); window.__dirMs is the Director's smoothed cost per frame
    if (import.meta.env.DEV) {
      const win = window as unknown as { __sub?: number; __dirMs?: number }
      const t0 = performance.now()
      for (let i = 0; i < (win.__sub ?? 1); i++) step(state, rawDt)
      const ms = performance.now() - t0
      win.__dirMs = (win.__dirMs ?? ms) * 0.9 + ms * 0.1
    } else step(state, rawDt)
  }, -1)
}

// fog distances per section: hero, friend, small, crowd, strangers, bug, apps, finale.
// The opening shot is only you: everyone else is still in the haze behind the headline
// and walks out of it on the next beat. The finale's ground fades to paper before the
// horizon, so no band of darker ground shows behind the pair.
const FOG_NEAR = [10, 24, 24, 28, 34, 24, 22, 13]
const FOG_FAR = [22, 66, 66, 78, 96, 70, 64, 28]

// scrim weights per section: hero, friend, small, crowd, strangers, bug, apps, finale
const SIDE_D = [0, 1, 1, 1, 0, 1, 1, 0]
const SIDE_M = [0, 1, 1, 1, 1, 1, 1, 0]
const CENTER_D = [0, 0, 0, 0, 1, 0, 0, 0]
const BOTTOM = [0, 0, 0, 0, 0, 0, 0, 1]
function scrim(f: number, wts: number[]) {
  const i = Math.min(wts.length - 2, Math.floor(f))
  return lerp(wts[i], wts[i + 1], smoothstep(f - i, 0.3, 0.7))
}

/** tag height in world units: big enough to read the glyph at a glance */
const TAG_S = 0.8

function popTag(s: THREE.Sprite | null, pop: S1, on: boolean, x: number, y: number, z: number, t: number, dt: number, reduced: boolean, seed: number) {
  if (!s) return
  const mat = s.material as THREE.SpriteMaterial
  if (reduced) {
    crit(pop, on ? 1 : 0, 20, dt)
    mat.opacity = clamp(pop.x, 0, 1)
    s.scale.set(TAG_S * (300 / 250), TAG_S, 1)
  } else {
    spring2(pop, on ? 1 : 0, 13, 0.62, dt)
    mat.opacity = 1
    const k = Math.max(0, pop.x)
    s.scale.set(TAG_S * (300 / 250) * k, TAG_S * k, 1)
  }
  s.visible = pop.x > 0.01
  s.position.set(x, y + (reduced ? 0 : 0.05 * Math.sin(1.6 * t + seed)), z)
}

/** The card's width in world units (its height follows the texture's 640:220). */
const CARD_W = 2.1
const CARD_W_NARROW = 1.8
const CARD_ASPECT = 640 / 220

function stepCard(w: World, h: World['hero'], camera: THREE.Camera, t: number, dt: number, reduced: boolean, narrow: boolean) {
  const c = w.card
  const mesh = w.refs.card.current
  if (!mesh) return
  if (h.d > APPS_D - 8) c.on = true
  else if (h.d < APPS_D - 8.8) c.on = false
  const cw = narrow ? CARD_W_NARROW : CARD_W
  const halfH = (cw * Math.max(0, c.pop.x)) / CARD_ASPECT / 2
  if (c.mode === 0) {
    // hover off your shoulder on the camera's side (never behind your head), turned to the
    // camera; phones have less room beside you, so it floats higher and closer in.
    // _right / _fwd are the camera basis the Director solved this frame.
    const side = narrow ? 0.85 : 1.8
    const tx = h.x + _right.x * side - _fwd.x * 0.35
    const tz = h.z + _right.z * side - _fwd.z * 0.35
    const ty = (narrow ? 2.85 : 2.4) + (reduced ? 0 : 0.06 * Math.sin(2.1 * t))
    if (w.snap) {
      snap(c.x, tx)
      snap(c.y, ty)
      snap(c.z, tz)
    }
    crit(c.x, tx, 5, dt)
    crit(c.y, ty, 5, dt)
    crit(c.z, tz, 5, dt)
    // square to the camera (tilted back by its pitch), so the dial reads face-on
    const cdx = camera.position.x - c.x.x
    const cdz = camera.position.z - c.z.x
    crit(c.rx, -Math.atan2(camera.position.y - c.y.x, Math.hypot(cdx, cdz)), 6, dt)
    c.yaw = Math.atan2(cdx, cdz)
    // ignored: you walk on past it, or you stand there long enough to read the paragraph
    const ignored = h.d > APPS_D + 1.0 || (Math.abs(h.d - APPS_D) < 1.5 && h.idle > 3.5)
    if (c.on && c.pop.x > 0.9 && ignored) {
      c.mode = 1
      c.vx = c.x.v
      c.vy = c.y.v
      c.vz = c.z.v
    }
  } else {
    // nobody opened it: it drops, lands on its edge, tips back and comes to rest
    // leaning, face up toward the camera, number still readable
    const k = Math.exp(-3 * dt)
    c.vx *= k
    c.vz *= k
    c.vy -= 22 * dt
    c.x.x += c.vx * dt
    c.z.x += c.vz * dt
    c.y.x += c.vy * dt
    spring2(c.rx, -Math.PI / 2 + 0.45, 6, 0.5, dt)
    // the lowest edge touches the ground: half the card's height times how upright it is
    const floor = 0.03 + halfH * Math.abs(Math.cos(c.rx.x))
    if (c.y.x <= floor) {
      c.y.x = floor
      if (c.vy < -0.8) c.vy = -0.3 * c.vy
      else c.vy = Math.max(0, c.vy)
      c.vx *= 0.8
      c.vz *= 0.8
    }
    if (h.d < APPS_D - 2) {
      c.mode = 0
      c.x.v = c.y.v = c.z.v = 0
    }
  }
  crit(c.dim, c.mode === 1 ? 0.6 : 1, 3, dt)
  if (reduced) crit(c.pop, c.on ? 1 : 0, 20, dt)
  else spring2(c.pop, c.on ? 1 : 0, 13, 0.62, dt)
  const s = Math.max(0, c.pop.x)
  // once you've walked on toward the finale, the discarded card fades from the path
  const gone = 1 - smoothstep(h.d, APPS_D + 4, APPS_D + 8)
  mesh.visible = s > 0.01 && gone > 0.01 && Math.abs(h.d - APPS_D) < 40
  mesh.position.set(c.x.x, c.y.x, c.z.x)
  mesh.rotation.set(c.rx.x, c.yaw, 0, 'YXZ')
  mesh.scale.set(cw * s, (cw / CARD_ASPECT) * s, 1)
  ;(mesh.material as THREE.MeshBasicMaterial).opacity = gone * c.dim.x * (reduced ? clamp(c.pop.x, 0, 1) : 1)
}

/* ------------------------------------------------------------------ scene parts */

function Blob({ r, shadow, opacity = 0.16 }: { r: number; shadow: Mref; opacity?: number }) {
  const map = useMemo(() => blobTexture(), [])
  return (
    <mesh ref={shadow} rotation-x={-Math.PI / 2} renderOrder={1}>
      <planeGeometry args={[r * 2, r * 2]} />
      <meshBasicMaterial map={map} transparent opacity={opacity} depthWrite={false} toneMapped={false} />
    </mesh>
  )
}

function NpcRig({ npc, look }: { npc: Npc; look: Look }) {
  return (
    <>
      <group ref={npc.root}>
        <group ref={npc.yawG}>
          <group ref={npc.lean}>
            <LandingBean look={look} pose={npc.pose} />
          </group>
        </group>
      </group>
      {npc.y === 0 && <Blob r={0.85} shadow={npc.shadow} />}
    </>
  )
}

function HeroRig({ w }: { w: World }) {
  const h = w.hero
  return (
    <>
      <group ref={h.root}>
        <group ref={h.yawG}>
          <group ref={h.lean}>
            <LandingBean look={HERO} pose={h.pose} />
          </group>
        </group>
      </group>
      <Blob r={0.9} shadow={h.shadow} opacity={0.2} />
    </>
  )
}

/** Paper-coloured ground, a soft path ribbon with a feathered edge, and a shadow catcher. */
function Ground() {
  const geos = useMemo(() => {
    const ribbon = (hw: number, y: number) => {
      const K = 700
      const pos = new Float32Array((K + 1) * 2 * 3)
      const idx: number[] = []
      const o = ps()
      for (let i = 0; i <= K; i++) {
        sample((i / K) * L, o)
        pos.set([o.x - o.rx * hw, y, o.z - o.rz * hw, o.x + o.rx * hw, y, o.z + o.rz * hw], i * 6)
        if (i < K) {
          const a = i * 2
          // counter-clockwise seen from above, so the lane faces the camera
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
        }
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      g.setIndex(idx)
      g.computeVertexNormals()
      return g
    }
    const end = path.getPointAt(1)
    return { edge: ribbon(1.5, 0.02), path: ribbon(1.3, 0.035), end }
  }, [])
  const mid = -L / 2
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0, mid]}>
        <planeGeometry args={[340, L + 260]} />
        <meshBasicMaterial color={GROUND} toneMapped={false} />
      </mesh>
      <mesh geometry={geos.edge}>
        <meshBasicMaterial color="#EFE8DC" toneMapped={false} />
      </mesh>
      <mesh geometry={geos.path}>
        <meshBasicMaterial color="#FAF7F1" toneMapped={false} />
      </mesh>
      {/* round ends */}
      {[
        [0, 0],
        [geos.end.x, geos.end.z],
      ].map(([x, z], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh rotation-x={-Math.PI / 2} position-y={0.02}>
            <circleGeometry args={[1.5, 48]} />
            <meshBasicMaterial color="#EFE8DC" toneMapped={false} />
          </mesh>
          <mesh rotation-x={-Math.PI / 2} position-y={0.035}>
            <circleGeometry args={[1.3, 48]} />
            <meshBasicMaterial color="#FAF7F1" toneMapped={false} />
          </mesh>
        </group>
      ))}
      {/* real shadows land here; the ground keeps its exact colour */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.05, mid]} receiveShadow renderOrder={0}>
        <planeGeometry args={[340, L + 260]} />
        <shadowMaterial color="#3A2F22" opacity={0.16} depthWrite={false} />
      </mesh>
    </group>
  )
}

/** Sparse round trees off to the sides: depth and scale, nothing in the air. */
function Trees() {
  const canopy = useRef<THREE.InstancedMesh>(null!)
  const trunk = useRef<THREE.InstancedMesh>(null!)
  const trees = useMemo(() => {
    const r = rng(77)
    const out: { x: number; z: number; s: number; c: number }[] = []
    const o = ps()
    // where the camera stands for the beats framed beside the copy
    const sideBeats = [BEAT_D.friend, BEAT_D.small, BEAT_D.bug, BEAT_D.apps]
    let tries = 0
    while (out.length < 30 && tries++ < 4000) {
      const d = -14 + r() * (L * 0.92 + 14)
      if (d > CROWD_A - 4 && d < CROWD_B + 2) continue
      const side = r() < 0.5 ? -1 : 1
      const lat = side * (8 + r() * 10)
      // nothing on the copy side (your left, the screen's left) in view of those cameras:
      // it would sit under the text as a pale blob cut off by the edge of the screen
      if (lat < 0 && sideBeats.some((b) => d > b - 20 && d < b + 12)) continue
      // and nothing around the opening shot: it is only you, under the headline
      if (d > -8 && d < 15) continue
      place(d, lat, o)
      if (out.some((q) => (q.x - o.x) ** 2 + (q.z - o.z) ** 2 < 16)) continue
      // keep clear of the path where it bends back
      let clear = true
      for (let k = 0; k <= 60 && clear; k++) {
        sample((k / 60) * L, Q)
        if ((Q.x - o.x) ** 2 + (Q.z - o.z) ** 2 < 36) clear = false
      }
      if (!clear) continue
      out.push({ x: o.x, z: o.z, s: 1.1 + r() * 0.5, c: Math.floor(r() * 3) })
    }
    return out
  }, [])
  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const col = new THREE.Color()
    const cols = ['#C7D6B8', '#B9CCA8', '#D3DEC6']
    trees.forEach((t, i) => {
      m.compose(new THREE.Vector3(t.x, 1.0 + t.s * 0.85, t.z), q, new THREE.Vector3(t.s, t.s * 1.05, t.s))
      canopy.current.setMatrixAt(i, m)
      canopy.current.setColorAt(i, col.set(cols[t.c]))
      m.compose(new THREE.Vector3(t.x, 0.6, t.z), q, new THREE.Vector3(1, 1, 1))
      trunk.current.setMatrixAt(i, m)
    })
    canopy.current.instanceMatrix.needsUpdate = trunk.current.instanceMatrix.needsUpdate = true
    if (canopy.current.instanceColor) canopy.current.instanceColor.needsUpdate = true
    canopy.current.computeBoundingSphere()
    trunk.current.computeBoundingSphere()
  }, [trees])
  return (
    <>
      <instancedMesh ref={canopy} args={[undefined, undefined, trees.length]} castShadow>
        <icosahedronGeometry args={[1, 2]} />
        <meshStandardMaterial roughness={0.9} flatShading={false} />
      </instancedMesh>
      <instancedMesh ref={trunk} args={[undefined, undefined, trees.length]} castShadow>
        <cylinderGeometry args={[0.13, 0.17, 1.2, 8]} />
        <meshStandardMaterial color="#CBB9A2" roughness={0.9} />
      </instancedMesh>
    </>
  )
}

function CrowdMeshes({ w }: { w: World }) {
  const c: Crowd = w.crowd
  const geo = useMemo(() => {
    const b = new THREE.CapsuleGeometry(0.64, 0.66, 4, 12)
    b.scale(1, 1, 0.9)
    b.translate(0, 1.27, 0)
    // the visor stays inside the silhouette from behind and above (only its front pokes
    // out, as a face); the eyes are painted on (visorFace), so they cost no triangles
    const v = new THREE.SphereGeometry(1, 12, 8)
    v.scale(0.44, 0.32, 0.18)
    v.translate(0, 1.62, 0.44)
    const s = new THREE.PlaneGeometry(1.7, 1.7)
    s.rotateX(-Math.PI / 2)
    s.translate(0, 0.055, 0)
    return { b, v, s }
  }, [])
  const blob = useMemo(() => blobTexture(), [])
  const face = useMemo(() => visorFace(), [])
  useLayoutEffect(() => {
    const body = w.refs.crowdBody.current
    const visor = w.refs.crowdVisor.current
    const shadow = w.refs.crowdShadow.current
    if (!body || !visor || !shadow) return
    // one matrix write per person feeds all three draws
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    visor.instanceMatrix = body.instanceMatrix
    shadow.instanceMatrix = body.instanceMatrix
    crowdColors(c, body)
    crowdReset(c, 0)
    body.visible = visor.visible = shadow.visible = false
    w.crowdOn = false
  }, [c, w])
  return (
    <>
      <instancedMesh ref={w.refs.crowdBody} args={[geo.b, undefined, c.n]} frustumCulled={false} castShadow>
        <meshStandardMaterial roughness={0.5} />
      </instancedMesh>
      <instancedMesh ref={w.refs.crowdVisor} args={[geo.v, undefined, c.n]} frustumCulled={false}>
        <meshStandardMaterial color="#ffffff" map={face} roughness={0.3} emissive="#bdbdb7" emissiveMap={face} />
      </instancedMesh>
      <instancedMesh ref={w.refs.crowdShadow} args={[geo.s, undefined, c.n]} frustumCulled={false} renderOrder={1}>
        <meshBasicMaterial map={blob} transparent opacity={0.14} depthWrite={false} toneMapped={false} />
      </instancedMesh>
    </>
  )
}

/** Three tables in a row with stools; the middle one is empty. */
function Tables({ w }: { w: World }) {
  const items = useMemo(() => {
    const o = ps()
    const at = (beanD: number, lat: number) => {
      sample(beanD, o)
      const yaw = o.heading + Math.PI
      place(beanD, lat, o)
      const bx = o.x
      const bz = o.z
      // the table sits in front of the bean (toward the camera)
      sample(beanD, Q)
      return { bean: [bx, bz] as const, table: [bx - Q.tx * 1.07, bz - Q.tz * 1.07] as const, yaw }
    }
    return BUG_LAT.map((lat) => at(BUG_ROW, lat))
  }, [w])
  return (
    <group>
      {items.map((it, i) => (
        <group key={i}>
          <group position={[it.table[0], 0, it.table[1]]} rotation-y={it.yaw}>
            <mesh position={[0, STOOL + 0.72, 0]} castShadow receiveShadow>
              <boxGeometry args={[1.7, 0.07, 0.95]} />
              <meshStandardMaterial color="#FBF8F2" roughness={0.6} />
            </mesh>
            {[
              [-0.75, -0.38],
              [0.75, -0.38],
              [-0.75, 0.38],
              [0.75, 0.38],
            ].map(([x, z], k) => (
              <mesh key={k} position={[x, (STOOL + 0.72) / 2, z]} castShadow>
                <cylinderGeometry args={[0.035, 0.035, STOOL + 0.72, 8]} />
                <meshStandardMaterial color="#B9AC99" roughness={0.7} />
              </mesh>
            ))}
          </group>
          <mesh position={[it.bean[0], STOOL / 2, it.bean[1]]} castShadow>
            <cylinderGeometry args={[0.42, 0.38, STOOL, 20]} />
            <meshStandardMaterial color="#D9CFC1" roughness={0.8} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

function Thread({ w }: { w: World }) {
  const mesh = w.refs.dots
  useLayoutEffect(() => {
    const m = mesh.current
    if (!m) return
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    for (let i = 0; i <= 40; i++) m.setColorAt(i, i === 40 ? WHITE : GOLD_DOT)
    if (m.instanceColor) m.instanceColor.needsUpdate = true
    m.visible = false
  }, [mesh])
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, 41]} frustumCulled={false}>
      <sphereGeometry args={[1, 10, 8]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  )
}

function Tags({ w }: { w: World }) {
  const tex = useMemo(() => ({ bug: bugTag(), fix: checkTag() }), [])
  return (
    <>
      <sprite ref={w.refs.bugTag} center={[0.5, tex.bug.tail]} renderOrder={10} visible={false}>
        <spriteMaterial map={tex.bug.map} transparent depthTest={false} depthWrite={false} toneMapped={false} />
      </sprite>
      <sprite ref={w.refs.fixTag} center={[0.5, tex.fix.tail]} renderOrder={10} visible={false}>
        <spriteMaterial map={tex.fix.map} transparent depthTest={false} depthWrite={false} toneMapped={false} />
      </sprite>
    </>
  )
}

function AppCard({ w }: { w: World }) {
  const tex = useMemo(() => matchCard(), [])
  return (
    <mesh ref={w.refs.card} visible={false} castShadow>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial map={tex.map} transparent alphaTest={0.02} side={THREE.DoubleSide} toneMapped={false} />
    </mesh>
  )
}

function MeetRing({ w }: { w: World }) {
  return (
    <mesh ref={w.refs.meet} rotation-x={-Math.PI / 2} visible={false} renderOrder={2}>
      <ringGeometry args={[2.14, 2.22, 128]} />
      <meshBasicMaterial color="#FFC93C" transparent opacity={0} depthWrite={false} toneMapped={false} />
    </mesh>
  )
}

function Sun({ w }: { w: World }) {
  const sun = w.refs.sun
  const size = 1024
  const target = useMemo(() => new THREE.Object3D(), [])
  useLayoutEffect(() => {
    if (sun.current) sun.current.target = target
  }, [sun, target])
  return (
    <>
      <hemisphereLight ref={w.refs.hemi} args={['#ffffff', GROUND, 1.25]} />
      <directionalLight
        ref={sun}
        color="#FFF4E5"
        intensity={2}
        castShadow
        shadow-mapSize={[size, size]}
        shadow-camera-left={-11}
        shadow-camera-right={11}
        shadow-camera-top={11}
        shadow-camera-bottom={-11}
        shadow-camera-near={1}
        shadow-camera-far={40}
        shadow-bias={-0.0005}
        shadow-normalBias={0.02}
      />
      <primitive object={target} />
    </>
  )
}

export function Scene({ shared }: { shared: Shared }) {
  const w = useMemo(() => createWorld(), [])
  if (import.meta.env.DEV) (window as unknown as { __world: unknown }).__world = w
  useDirector(w, shared)
  const mt = w.match
  return (
    <>
      <color attach="background" args={[PAPER]} />
      <fog attach="fog" args={[PAPER, FOG_NEAR[0], FOG_FAR[0]]} />
      <Sun w={w} />
      <Ground />
      <Trees />
      <HeroRig w={w} />
      <NpcRig npc={w.friend} look={FRIEND} />
      {w.ring.map((r, i) => (
        <NpcRig key={i} npc={r} look={SMALL[i]} />
      ))}
      <CrowdMeshes w={w} />
      <Tables w={w} />
      <NpcRig npc={w.stuck} look={STUCK} />
      <NpcRig npc={w.fixer} look={FIXER} />
      <Thread w={w} />
      <Tags w={w} />
      <AppCard w={w} />
      <NpcRig npc={mt} look={MATCH} />
      <MeetRing w={w} />
      <Preload all />
    </>
  )
}
