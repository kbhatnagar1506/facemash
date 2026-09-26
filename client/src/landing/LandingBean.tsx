import { useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BeanBody } from '../Bean'
import type { Look } from '../look'
import { clamp, crit, lerp, s1, smoothstep } from './physics'
import type { Pose } from './pose'

// BeanBody's own animation is written for the game: a binary walk flag at a fixed
// cadence, poses that switch in a single frame. On the landing page the bean moves at
// whatever speed the scroll asks for, so this wrapper takes over the pose *after*
// BeanBody's frame (its useFrame subscribes first, being the child) and writes a
// continuous one: cadence and stride from real ground speed, blended walk/idle/sit/
// wave/cheer weights, blinks, and a per-bean clock so nobody breathes in lockstep.
// BeanBody still owns the face swap during a cheer and the hat spin.

const EYE_Y = 1.68 // BeanBody's eye line (FACE_Y + 0.02): blinks squash about it

interface Rig {
  body: THREE.Object3D
  legL: THREE.Object3D
  legR: THREE.Object3D
  armL: THREE.Object3D
  armR: THREE.Object3D
  item: THREE.Object3D | null
  lids: THREE.Object3D[]
}

/** Find BeanBody's joints by their rest positions (legs at x ±0.26, arms at x ±0.6). */
function findRig(outer: THREE.Object3D): Rig | null {
  const body = outer.children[0]
  if (!body) return null
  let legL: THREE.Object3D | null = null
  let legR: THREE.Object3D | null = null
  let armL: THREE.Object3D | null = null
  let armR: THREE.Object3D | null = null
  let eyes: THREE.Object3D | null = null
  for (const c of body.children) {
    const p = c.position
    if ((c as THREE.Mesh).isMesh && Math.abs(Math.abs(p.x) - 0.26) < 1e-3 && Math.abs(p.y - 0.4) < 1e-3) {
      if (p.x < 0) legL = c
      else legR = c
    } else if (c.type === 'Group' && Math.abs(Math.abs(p.x) - 0.6) < 1e-3) {
      if (p.x < 0) armL = c
      else armR = c
    } else if (c.type === 'Group' && !eyes && p.lengthSq() === 0 && c.visible) eyes = c
  }
  if (!legL || !legR || !armL || !armR) return null
  const item = armR.children[2] ?? null
  const lids = eyes ? eyes.children.filter((c) => c.type === 'Group') : []
  return { body, legL, legR, armL, armR, item, lids }
}

export function LandingBean({ look, pose, shadows = true }: { look: Look; pose: Pose; shadows?: boolean }) {
  const outer = useRef<THREE.Group>(null!)
  const state = useMemo(() => ({ current: pose.av }), [pose])
  const rig = useRef<Rig | null>(null)
  const [seed] = useState(() => Math.random() * 60)
  const m = useRef({ walk: 0, sit: 0, wave: 0, cheerArms: 0, phase: 0, nextBlink: -1, blinkT: -1, pk: s1(1.35) })
  const holdsLaptop = look.item === 'laptop'
  const blinks = look.eyes === 'dots' || look.eyes === 'star' || look.eyes === 'wink'

  useFrame(({ clock }, rawDt) => {
    if (!rig.current) rig.current = findRig(outer.current)
    const r = rig.current
    if (!r) return
    const dt = Math.min(Math.max(rawDt, 0), 1 / 20)
    const k = m.current
    const t = clock.elapsedTime + seed
    const e8 = 1 - Math.exp(-8 * dt)
    const e10 = 1 - Math.exp(-10 * dt)
    const v = pose.speed
    pose.av.moving = false // BeanBody stays in its idle branch; the pose below replaces it

    k.walk += (smoothstep(v, 0.05, 0.6) - k.walk) * e10
    k.sit += ((pose.sit ? 1 : 0) - k.sit) * (1 - Math.exp(-12 * dt))
    k.wave += ((pose.wave && !holdsLaptop ? 1 : 0) - k.wave) * e10

    // cadence from speed (stride grows with speed, capped at 3.2 Hz); when stopping,
    // finish the step so the feet come together instead of freezing mid-stride
    const hz = Math.min(3.2, v / (1.1 + 0.18 * v))
    if (k.walk > 0.02) k.phase += 2 * Math.PI * hz * dt
    else k.phase += (Math.round(k.phase / Math.PI) * Math.PI - k.phase) * e8
    const run = smoothstep(v, 3, 9)
    const amp = (0.35 + 0.5 * smoothstep(v, 0, 5)) * k.walk
    const sn = Math.sin(k.phase)
    const cs = Math.cos(k.phase)
    const s = sn * amp
    r.legL.rotation.x = lerp(s, -1.4, k.sit)
    r.legR.rotation.x = lerp(-s, -1.4, k.sit)

    const idle = Math.sin(t * 1.6) * 0.06 * (1 - k.walk)
    const hold = holdsLaptop ? -1.05 : 0
    const swing = holdsLaptop ? 0.15 : 0.9 + 0.25 * run
    let lx = lerp(hold - s * swing, -0.9, k.sit)
    let rx = lerp(hold + s * swing, -0.9, k.sit)
    let lz = holdsLaptop ? -0.12 : -0.28 - idle
    let rz = holdsLaptop ? 0.12 : 0.28 + idle
    rx = lerp(rx, -2.7, k.wave)
    rz = lerp(rz, 0.5 + Math.sin(t * 9) * 0.35, k.wave)

    // cheer: BeanBody's 1.25 s timeline (crouch, spring up, land squishy), arms blended in
    const c = pose.av.cheer ? (performance.now() - pose.av.cheer) / 1000 : 9
    let jump = 0
    let squash = 1
    if (c < 1.25) {
      if (c < 0.18) squash = 1 - 0.2 * (c / 0.18)
      else if (c < 0.78) {
        const q = (c - 0.18) / 0.6
        jump = Math.sin(q * Math.PI) * 0.95 * (pose.calm ? 0.3 : 1)
        squash = 1.1 - 0.1 * q
      } else if (c < 1.0) squash = 0.82 + 0.18 * ((c - 0.78) / 0.22)
    }
    k.cheerArms += ((c > 0.18 && c < 0.78 && !holdsLaptop ? 1 : 0) - k.cheerArms) * (1 - Math.exp(-18 * dt))
    const wob = Math.sin(t * 14) * 0.15
    lx = lerp(lx, -2.8, k.cheerArms)
    rx = lerp(rx, -2.8, k.cheerArms)
    lz = lerp(lz, -0.5 - wob, k.cheerArms)
    rz = lerp(rz, 0.5 + wob, k.cheerArms)
    r.armL.rotation.x = lx
    r.armR.rotation.x = rx
    r.armL.rotation.z = lz
    r.armR.rotation.z = rz

    // waddle, bounce (highest mid-stance), a little squash at each heel strike, breathing
    const bounceH = 0.04 + 0.1 * run
    r.body.rotation.z = sn * 0.1 * (1 - 0.5 * run) * k.walk
    r.body.position.y = lerp(Math.abs(cs) * bounceH * k.walk, -0.3, k.sit) + jump
    const contact = (1 - Math.abs(cs)) ** 2
    const gaitSq = k.walk * ((0.03 + 0.05 * run) * contact - 0.025 * run * Math.abs(cs) ** 6)
    const breathe = (1 + Math.sin(t * 2.2) * 0.018 * (1 - k.walk)) * squash * (1 - gaitSq)
    const side = 1 / Math.sqrt(breathe)
    r.body.scale.set(side, breathe, side)

    // blink every 2.5–5.5 s, 110 ms
    if (blinks && r.lids.length) {
      if (k.nextBlink < 0) k.nextBlink = t + 1 + Math.random() * 3
      if (t > k.nextBlink) {
        k.blinkT = 0
        k.nextBlink = t + 2.5 + Math.random() * 3
      }
      let sy = 1
      if (k.blinkT >= 0) {
        k.blinkT += dt
        sy = 1 - 0.9 * Math.sin(Math.PI * Math.min(1, k.blinkT / 0.11))
        if (k.blinkT > 0.11) {
          k.blinkT = -1
          sy = 1
        }
      }
      for (let i = 0; i < r.lids.length; i++) {
        r.lids[i].scale.y = sy
        r.lids[i].position.y = EYE_Y * (1 - sy)
      }
    }

    // the held item goes away into a pocket (and comes back out)
    if (r.item) {
      const sc = crit(k.pk, pose.pocket ? 0 : 1.35, 9, dt)
      r.item.scale.setScalar(clamp(sc, 0.0001, 2))
      r.item.visible = sc > 0.01
    }
  })

  return (
    <group ref={outer}>
      <BeanBody look={look} state={state} shadows={shadows} />
    </group>
  )
}
