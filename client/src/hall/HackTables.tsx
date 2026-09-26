import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { TABLE, TABLES, type Table } from './layout'
import { metaScreen } from './textures'
import { FoldingChair } from './Sponsors'

// Hacking tables from the on-site photos: pairs of long maple folding tables
// pushed end to end, white T-legs on casters, white resin chairs pulled up, and
// the full hacker spread on top: laptops, water bottles, cans, chip bags, pizza
// plates, coffee, notebooks, chargers, the QR sheet, and backpacks underneath.
// All the small props for one table are merged into a single vertex-coloured mesh.

function rng(seed: number) {
  let s = seed * 9301 + 49297
  return () => ((s = (s * 16807) % 2147483647) / 2147483647)
}

/** Collects coloured primitives under a transform stack and merges them. */
class Kit {
  parts: THREE.BufferGeometry[] = []
  screens: THREE.Matrix4[] = []
  m = new THREE.Matrix4()

  add(g: THREE.BufferGeometry, color: string) {
    const ng = g.index ? g.toNonIndexed() : g
    ng.applyMatrix4(this.m)
    const c = new THREE.Color(color)
    const n = ng.getAttribute('position').count
    const arr = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3)
    ng.setAttribute('color', new THREE.BufferAttribute(arr, 3))
    ng.deleteAttribute('uv')
    this.parts.push(ng)
  }
  box(s: THREE.Vector3Tuple, p: THREE.Vector3Tuple, color: string, ry = 0, rx = 0) {
    const g = new THREE.BoxGeometry(...s)
    g.rotateX(rx)
    g.rotateY(ry)
    g.translate(...p)
    this.add(g, color)
  }
  cyl(rt: number, rb: number, h: number, p: THREE.Vector3Tuple, color: string, seg = 12, rx = 0) {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg)
    g.rotateX(rx)
    g.translate(...p)
    this.add(g, color)
  }
  /** Run `fn` with an extra translate+rotate (Y, then X) applied. */
  at(p: THREE.Vector3Tuple, ry: number, fn: () => void, rx = 0) {
    const prev = this.m.clone()
    const local = new THREE.Matrix4().makeRotationY(ry).multiply(new THREE.Matrix4().makeRotationX(rx)).setPosition(...p)
    this.m.multiply(local)
    fn()
    this.m = prev
  }
  geometry() {
    const g = mergeGeometries(this.parts)!
    g.computeBoundingSphere()
    return g
  }
}

const T = TABLE.h // table-top height
const MAPLE = '#dcb57a'
const LEG = '#eeeeea'
const pick = <V,>(r: () => number, a: V[]) => a[Math.floor(r() * a.length)]

/* ------------------------------------------------------------ table props */

// Each prop sits on a surface at height `y`, centred at (x, z) in the current frame.
const Prop = {
  laptop(k: Kit, x: number, z: number, y: number, ry: number, body: string, open = true) {
    k.at([x, y, z], ry, () => {
      if (!open) return k.box([0.32, 0.02, 0.22], [0, 0.01, 0], body)
      k.box([0.34, 0.015, 0.24], [0, 0.008, 0], body)
      k.box([0.28, 0.002, 0.1], [0, 0.017, 0.03], '#3a3c42') // keyboard
      k.at([0, 0.015, -0.12], 0, () => {
        k.box([0.34, 0.22, 0.012], [0, 0.11, 0], body)
        k.screens.push(k.m.clone())
      }, -0.3)
    })
  },
  bottle(k: Kit, x: number, z: number, y: number) {
    k.cyl(0.033, 0.033, 0.2, [x, y + 0.1, z], '#cfe4ee', 10)
    k.cyl(0.034, 0.034, 0.05, [x, y + 0.11, z], '#2f7fd8', 10) // label
    k.cyl(0.016, 0.02, 0.035, [x, y + 0.217, z], '#2a5cc8', 8)
  },
  can(k: Kit, x: number, z: number, y: number, color: string, tall = false) {
    const h = tall ? 0.16 : 0.12
    k.cyl(tall ? 0.028 : 0.033, tall ? 0.028 : 0.033, h, [x, y + h / 2, z], color, 12)
    k.cyl(0.03, 0.03, 0.006, [x, y + h + 0.003, z], '#c9ccd2', 12)
  },
  chips(k: Kit, x: number, z: number, y: number, ry: number, color: string) {
    k.box([0.17, 0.035, 0.24], [x, y + 0.018, z], color, ry)
    k.box([0.18, 0.012, 0.03], [x + Math.sin(ry) * 0.12, y + 0.01, z + Math.cos(ry) * 0.12], '#e9e9e4', ry)
  },
  plate(k: Kit, x: number, z: number, y: number, r: () => number) {
    k.cyl(0.125, 0.105, 0.015, [x, y + 0.008, z], '#f8f6f0', 18)
    // a couple of pizza slices / a scoop of rice and chicken
    if (r() < 0.6) {
      for (let i = 0; i < 2; i++) k.box([0.1, 0.018, 0.12], [x + (i - 0.5) * 0.08, y + 0.025, z + (r() - 0.5) * 0.04], i ? '#e2a64a' : '#d8943c', r() * 3)
      k.box([0.04, 0.012, 0.04], [x + 0.02, y + 0.038, z], '#b8322a')
    } else {
      k.box([0.14, 0.03, 0.1], [x, y + 0.03, z], '#b5773a', r() * 3)
      k.box([0.08, 0.025, 0.06], [x + 0.04, y + 0.04, z + 0.02], '#f1e7c9')
    }
  },
  cup(k: Kit, x: number, z: number, y: number, red: boolean) {
    k.cyl(0.042, 0.032, 0.12, [x, y + 0.06, z], red ? '#c9302c' : '#f4f1ea', 12)
    if (!red) {
      k.cyl(0.044, 0.044, 0.014, [x, y + 0.126, z], '#4e3627', 12)
      k.cyl(0.043, 0.041, 0.035, [x, y + 0.06, z], '#b58a5a', 12) // sleeve
    }
  },
  notebook(k: Kit, x: number, z: number, y: number, ry: number, color: string) {
    k.box([0.21, 0.014, 0.28], [x, y + 0.007, z], color, ry)
    k.box([0.2, 0.003, 0.27], [x + 0.004, y + 0.0155, z], '#f4f2ea', ry)
  },
  phone(k: Kit, x: number, z: number, y: number, ry: number) {
    k.box([0.075, 0.009, 0.155], [x, y + 0.005, z], '#141417', ry)
  },
  charger(k: Kit, x: number, z: number, y: number, ry: number, len: number) {
    k.box([0.05, 0.028, 0.06], [x, y + 0.014, z], '#f2f2ef', ry)
    k.at([x, y + 0.004, z], ry, () => k.box([0.008, 0.006, len], [0, 0, len / 2 + 0.03], '#e9e9e6'))
  },
  paper(k: Kit, x: number, z: number, y: number, ry: number) {
    k.box([0.21, 0.002, 0.28], [x, y + 0.001, z], '#fbfbf8', ry)
    k.box([0.07, 0.001, 0.07], [x, y + 0.0025, z], '#2a2b2e', ry) // the QR code
  },
  mouse(k: Kit, x: number, z: number, y: number) {
    k.box([0.06, 0.028, 0.1], [x, y + 0.014, z], '#2b2d33')
  },
  headphones(k: Kit, x: number, z: number, y: number, ry: number) {
    k.at([x, y + 0.03, z], ry, () => {
      const g = new THREE.TorusGeometry(0.08, 0.012, 6, 16, Math.PI)
      g.rotateX(Math.PI / 2)
      k.add(g, '#1d1e22')
      for (const s of [-1, 1]) k.cyl(0.04, 0.04, 0.04, [s * 0.08, -0.01, 0], '#2a2b30', 12)
    })
  },
  stickers(k: Kit, x: number, z: number, y: number, r: () => number) {
    for (let i = 0; i < 4; i++) k.box([0.07, 0.004, 0.07], [x + (r() - 0.5) * 0.12, y + 0.002 + i * 0.004, z + (r() - 0.5) * 0.1], pick(r, ['#f2c230', '#e8543f', '#56c6d8', '#9ad9b5', '#b8a8e6']), r() * 3)
  },
  pens(k: Kit, x: number, z: number, y: number, r: () => number) {
    k.cyl(0.036, 0.034, 0.1, [x, y + 0.05, z], '#26282d', 12)
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2
      k.at([x + Math.cos(a) * 0.015, y + 0.1, z + Math.sin(a) * 0.015], a, () => k.cyl(0.005, 0.005, 0.14, [0, 0, 0], pick(r, ['#2f80ed', '#e8543f', '#141417', '#f2f2ef']), 5), 0.15)
    }
  },
  candy(k: Kit, x: number, z: number, y: number, r: () => number) {
    k.cyl(0.13, 0.08, 0.07, [x, y + 0.035, z], '#f4f4f0', 18)
    for (let i = 0; i < 9; i++) k.box([0.035, 0.02, 0.05], [x + (r() - 0.5) * 0.16, y + 0.075, z + (r() - 0.5) * 0.16], pick(r, ['#e8543f', '#f2c230', '#6b3f8f', '#2f80ed', '#3aa35c']), r() * 3)
  },
  qrStand(k: Kit, x: number, z: number, y: number, ry: number) {
    k.at([x, y, z], ry, () => {
      k.box([0.2, 0.03, 0.08], [0, 0.015, 0], '#b98652')
      k.box([0.18, 0.24, 0.006], [0, 0.15, 0], '#f7f7f4')
      k.box([0.1, 0.1, 0.002], [0, 0.17, 0.004], '#1d1d20')
    })
  },
  backpack(k: Kit, x: number, z: number, ry: number, color: string, lean = 0) {
    k.at([x, 0, z], ry, () => {
      k.box([0.32, 0.36, 0.2], [0, 0.18, 0], color)
      k.cyl(0.16, 0.16, 0.2, [0, 0.36, 0], color, 12, Math.PI / 2)
      k.box([0.24, 0.16, 0.06], [0, 0.14, 0.12], color) // front pocket
      k.box([0.02, 0.3, 0.02], [0.13, 0.25, -0.11], '#141417')
      k.box([0.02, 0.3, 0.02], [-0.13, 0.25, -0.11], '#141417')
    }, lean)
  },
  jacket(k: Kit, color: string) {
    // draped over a chair back (chair-local frame)
    k.box([0.44, 0.34, 0.06], [0, 0.72, -0.25], color, 0, -0.07)
    k.box([0.42, 0.08, 0.26], [0, 0.9, -0.15], color)
  },
}

const BODIES = ['#c9ccd2', '#2b2d33', '#b8bcc3', '#8c9097', '#d9d2c7']
const CAN_COLORS = ['#c9302c', '#d8d9dc', '#2a5cc8', '#141417', '#3aa35c', '#f2c230']
const BAG_COLORS = ['#f29a2e', '#f2c230', '#6b3f8f', '#2f80ed', '#c9302c', '#3aa35c']
const PACKS = ['#2b2d33', '#4a3a31', '#1f2f4a', '#5b5f66', '#3d5a3f', '#6d2e2e']
const NOTEBOOKS = ['#1f2f4a', '#c9302c', '#2b2d33', '#3aa35c', '#f2c230']

/** Scatter a hacker's things in front of one seat (seat faces +z in this frame). */
function seatSpread(k: Kit, r: () => number, y: number) {
  const open = r() < 0.8
  Prop.laptop(k, (r() - 0.5) * 0.12, 0.02, y, (r() - 0.5) * 0.35, pick(r, BODIES), open)
  if (r() < 0.5) Prop.mouse(k, 0.28, 0.08, y)
  if (r() < 0.7) Prop.bottle(k, -0.3 + r() * 0.06, -0.12, y)
  if (r() < 0.45) Prop.can(k, 0.3, -0.14, y, pick(r, CAN_COLORS), r() < 0.4)
  if (r() < 0.4) Prop.chips(k, -0.12 + r() * 0.3, -0.26, y, r() * 3, pick(r, BAG_COLORS))
  if (r() < 0.35) Prop.plate(k, 0.05, -0.28, y, r)
  if (r() < 0.3) Prop.cup(k, -0.38, 0.08, y, r() < 0.5)
  if (r() < 0.35) Prop.phone(k, 0.3, 0.14, y, r() - 0.5)
  if (r() < 0.3) Prop.notebook(k, -0.34, -0.2, y, (r() - 0.5) * 0.6, pick(r, NOTEBOOKS))
  if (r() < 0.35) Prop.charger(k, 0.18, -0.2, y, r() * 6, 0.3 + r() * 0.3)
  if (r() < 0.15) Prop.headphones(k, -0.2, 0.2, y, r() * 3)
}

/** Long maple folding table (one leaf), centred, long axis along x. */
function leaf(k: Kit, x: number, len: number, d: number) {
  k.box([len, 0.03, d], [x, T - 0.015, 0], MAPLE)
  k.box([len + 0.01, 0.022, d + 0.01], [x, T - 0.036, 0], '#c7c2b6') // edge band
  k.box([len - 0.2, 0.04, 0.05], [x, T - 0.07, 0], LEG) // apron rail
  for (const s of [-1, 1]) {
    const lx = x + s * (len / 2 - 0.14)
    k.box([0.05, 0.04, d - 0.1], [lx, T - 0.07, 0], LEG) // top support
    k.cyl(0.024, 0.024, T - 0.17, [lx, (T - 0.09 + 0.08) / 2, 0], LEG, 10)
    k.box([0.05, 0.04, d - 0.16], [lx, 0.075, 0], LEG) // foot bar
    for (const z of [-1, 1]) {
      k.cyl(0.02, 0.02, 0.05, [lx, 0.03, z * (d / 2 - 0.1)], '#1d1e22', 10, Math.PI / 2) // caster
      k.box([0.03, 0.03, 0.03], [lx, 0.055, z * (d / 2 - 0.1)], '#c9ccd2')
    }
  }
}

export interface FoldingTableProps {
  len?: number
  d?: number
  leaves?: number
  seed?: number
  seats?: number[] // x positions of seats on the +z side
  seatsBack?: number[] // x positions on the -z side
  chairs?: boolean
}

/** Build one table: leaves, chairs (returned as transforms), and the spread. */
function buildTable({ len = TABLE.w, d = TABLE.d, leaves = 2, seed = 1, seats = [], seatsBack = [], chairs = true }: FoldingTableProps) {
  const r = rng(seed)
  const k = new Kit()
  const L = len / leaves
  for (let i = 0; i < leaves; i++) leaf(k, -len / 2 + L / 2 + i * L, L - 0.01, d)
  const chairList: { x: number; z: number; rot: number }[] = []
  const place = (x: number, side: 1 | -1) => {
    const used = r() < 0.82
    const out = used ? 0.5 + r() * 0.12 : 0.75 + r() * 0.25
    const cx = x + (r() - 0.5) * 0.15
    const cz = side * (d / 2 + out - 0.05)
    const rot = (side > 0 ? Math.PI : 0) + (r() - 0.5) * (used ? 0.25 : 0.7)
    if (chairs && r() > 0.08) {
      chairList.push({ x: cx, z: cz, rot })
      if (r() < 0.25) k.at([cx, 0, cz], rot, () => Prop.jacket(k, pick(r, ['#b98a55', '#2b2d33', '#556b8a', '#8a2f3a', '#d8d2c4'])))
    }
    if (used) {
      k.at([x, 0, side * (d / 2 - 0.28)], side > 0 ? 0 : Math.PI, () => seatSpread(k, r, T))
      if (r() < 0.6) Prop.backpack(k, cx + (r() < 0.5 ? -0.42 : 0.42), cz + side * 0.1, r() * 3, pick(r, PACKS), r() < 0.3 ? 0.25 : 0)
    }
  }
  seats.forEach((x) => place(x, 1))
  seatsBack.forEach((x) => place(x, -1))
  // shared things down the middle: the QR sheet, a power strip, snacks, a candy/sticker pile
  Prop.paper(k, (r() - 0.5) * len * 0.5, (r() - 0.5) * 0.1, T, (r() - 0.5) * 0.8)
  if (r() < 0.6) Prop.stickers(k, (r() - 0.5) * len * 0.6, 0, T, r)
  if (r() < 0.5) Prop.chips(k, (r() - 0.5) * len * 0.6, 0.02, T, r() * 3, pick(r, BAG_COLORS))
  if (r() < 0.5) Prop.bottle(k, (r() - 0.5) * len * 0.7, -0.02, T)
  k.box([0.3, 0.04, 0.06], [(r() - 0.5) * len * 0.5, 0.02, 0], '#f2f2ef') // power strip on the floor
  return { geo: k.geometry(), screens: k.screens, chairs: chairList }
}

function screenFlicker(mats: React.MutableRefObject<THREE.MeshBasicMaterial[]>, phase: number) {
  return ({ clock }: { clock: THREE.Clock }) => {
    mats.current.forEach((m, i) => {
      if (m) m.color.setScalar(0.92 + 0.08 * Math.sin(clock.elapsedTime * 3 + i * 1.7 + phase))
    })
  }
}

/** Laptop screens for a built table (planes on each open lid). */
function Screens({ list, phase }: { list: THREE.Matrix4[]; phase: number }) {
  const mats = useRef<THREE.MeshBasicMaterial[]>([])
  useFrame(screenFlicker(mats, phase))
  return (
    <>
      {list.map((m, i) => (
        <group key={i} matrix={m} matrixAutoUpdate={false}>
          <mesh position={[0, 0.11, 0.0065]}>
            <planeGeometry args={[0.31, 0.2]} />
            <meshBasicMaterial ref={(mm) => { if (mm) mats.current[i] = mm }} map={metaScreen()} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </>
  )
}

export function FoldingTable(props: FoldingTableProps) {
  const built = useMemo(() => buildTable(props), [props.len, props.d, props.leaves, props.seed, props.seats?.join(), props.seatsBack?.join(), props.chairs]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <group>
      <mesh geometry={built.geo} castShadow receiveShadow>
        <meshLambertMaterial vertexColors />
      </mesh>
      <Screens list={built.screens} phase={props.seed ?? 0} />
      {built.chairs.map((c, i) => (
        <FoldingChair key={i} x={c.x} z={c.z} rot={c.rot} />
      ))}
    </group>
  )
}

/** One numbered hacking table on the open floor: two leaves, three seats a side. */
function HackTable({ t }: { t: Table }) {
  const s = TABLE.w / 3
  return (
    <group position={[t.x, 0, t.z]}>
      <FoldingTable seed={t.n * 7 + 3} seats={[-s, 0, s]} seatsBack={[-s, 0, s]} />
    </group>
  )
}

export function HackTables() {
  return (
    <>
      {TABLES.map((t) => (
        <HackTable key={t.n} t={t} />
      ))}
    </>
  )
}

/* ------------------------------------------------------------ sponsor swag */

/**
 * The spread on a sponsor table (top at y = h, front toward +z): QR stands,
 * sticker piles, pens, candy, water, a laptop or two, and business cards.
 */
export function Swag({ w, seed = 1, h = 0.76, laptops = 1 }: { w: number; seed?: number; h?: number; laptops?: number }) {
  const built = useMemo(() => {
    const r = rng(seed + 101)
    const k = new Kit()
    const slots = Math.max(4, Math.round(w / 0.36))
    const xs = Array.from({ length: slots }, (_, i) => -w / 2 + 0.22 + (i * (w - 0.44)) / (slots - 1))
    // laptops at the back, facing the sponsor reps (away from the aisle)
    for (let i = 0; i < laptops; i++) Prop.laptop(k, xs[Math.floor(((i + 0.5) / laptops) * slots)] + (r() - 0.5) * 0.1, -0.2, h, Math.PI + (r() - 0.5) * 0.3, pick(r, BODIES))
    xs.forEach((x, i) => {
      const v = r()
      const z = 0.12 + (r() - 0.5) * 0.12
      if (i % 3 === 0) Prop.qrStand(k, x, 0.18, h, (r() - 0.5) * 0.4)
      else if (v < 0.25) Prop.stickers(k, x, z, h, r)
      else if (v < 0.4) Prop.pens(k, x, z, h, r)
      else if (v < 0.55) Prop.candy(k, x, z, h, r)
      else if (v < 0.7) {
        Prop.bottle(k, x - 0.05, z, h)
        Prop.bottle(k, x + 0.05, z + 0.04, h)
      } else if (v < 0.85) k.box([0.1, 0.03, 0.07], [x, h + 0.015, z], '#f4f4f0', r() - 0.5) // business cards
      else Prop.notebook(k, x, z, h, (r() - 0.5) * 0.5, pick(r, NOTEBOOKS))
    })
    if (r() < 0.6) Prop.bottle(k, xs[slots - 1] + 0.05, -0.28, h)
    if (r() < 0.5) Prop.cup(k, xs[0], -0.3, h, false)
    return { geo: k.geometry(), screens: k.screens }
  }, [w, seed, h, laptops])
  return (
    <group>
      <mesh geometry={built.geo} castShadow>
        <meshLambertMaterial vertexColors />
      </mesh>
      <Screens list={built.screens} phase={seed} />
    </group>
  )
}
