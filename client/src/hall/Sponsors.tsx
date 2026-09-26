import { useMemo } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { SLANT, X0, X1, Z0, ex, wallZ, westSlope, westX } from './layout'
import { FoldingTable, Swag } from './HackTables'
import { metaScreen } from './textures'

// Every sponsor and organizer table in the Klaus atrium, from the on-site photos.
// Tablecloths are real drapes: vertical folds that deepen towards the floor, a
// hem that flares out and puddles, and the print lives in the fabric texture so
// the logo follows the creases.

/* --------------------------------------------------------------- canvases */

function paint(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

function center(g: CanvasRenderingContext2D, text: string, font: string, color: string, x: number, y: number, align: CanvasTextAlign = 'center') {
  g.font = font
  g.fillStyle = color
  g.textAlign = align
  g.textBaseline = 'middle'
  g.fillText(text, x, y)
}

function qr(g: CanvasRenderingContext2D, x: number, y: number, s: number, seed = 1) {
  g.fillStyle = '#fff'
  g.fillRect(x, y, s, s)
  const n = 21
  const c = s / n
  let r = seed
  g.fillStyle = '#111'
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      r = (r * 16807) % 2147483647
      const finder = (i < 7 && j < 7) || (i >= n - 7 && j < 7) || (i < 7 && j >= n - 7)
      const on = finder ? (i % 6 === 0 || j % 6 === 0 || (i % 6 > 1 && i % 6 < 5 && j % 6 > 1 && j % 6 < 5)) : r % 2 === 0
      if (on) g.fillRect(x + i * c, y + j * c, c, c)
    }
}

/** A tablecloth front: base colour + whatever is printed on it. 512 px per metre-ish. */
function print(bg: string, draw?: (g: CanvasRenderingContext2D, w: number, h: number) => void, w = 1024, h = 400) {
  return paint(w, h, (g) => {
    g.fillStyle = bg
    g.fillRect(0, 0, w, h)
    draw?.(g, w, h)
  })
}

/* ------------------------------------------------------------ drape geometry */

/**
 * One side of a tablecloth: a hanging panel whose folds grow toward the floor
 * and whose hem kicks out, like the draped cloths in the photos.
 */
function drape(len: number, h: number, seed: number, loose = 1) {
  const g = new THREE.PlaneGeometry(len, h + 0.03, Math.max(24, Math.round(len * 34)), 12)
  const p = g.getAttribute('position')
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const v = (y + h / 2) / h // 0 at the floor, 1 at the table edge
    const hang = Math.pow(1 - Math.min(1, Math.max(0, v)), 1.3)
    const folds = Math.sin(x * 19 + seed) + 0.55 * Math.sin(x * 43 + seed * 2.3) + 0.3 * Math.sin(x * 7 + seed * 5)
    const corner = Math.max(0, Math.abs(x) - (len / 2 - 0.22)) * 0.45 // corners bunch outward
    p.setZ(i, (0.022 * folds * hang + 0.06 * Math.pow(hang, 2.5)) * loose + corner * hang)
    if (v < 0.02) p.setY(i, y - 0.02) // hem touches the floor
  }
  g.computeVertexNormals()
  return g
}

/**
 * A draped rectangular table. The +z side is the front (faces the aisle);
 * `front` is the printed fabric for that side.
 */
export function Cloth({ w, d, color, front, h = 0.76, seed = 1, loose = 1 }: { w: number; d: number; color: string; front?: THREE.Texture; h?: number; seed?: number; loose?: number }) {
  const geos = useMemo(
    () => ({
      front: drape(w, h, seed, loose),
      back: drape(w, h, seed + 3, loose * 0.7),
      side: drape(d, h, seed + 7, loose * 0.8),
    }),
    [w, d, h, seed, loose],
  )
  return (
    <group>
      <mesh position={[0, h, 0]} rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[w + 0.02, d + 0.02]} />
        <meshLambertMaterial color={color} />
      </mesh>
      <mesh geometry={geos.front} position={[0, h / 2, d / 2]} castShadow receiveShadow>
        <meshLambertMaterial color={front ? '#ffffff' : color} map={front} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geos.back} position={[0, h / 2, -d / 2]} rotation-y={Math.PI}>
        <meshLambertMaterial color={color} side={THREE.DoubleSide} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} geometry={geos.side} position={[(s * w) / 2, h / 2, 0]} rotation-y={(s * Math.PI) / 2}>
          <meshLambertMaterial color={color} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  )
}

/* ----------------------------------------------------------------- props */

/**
 * White resin garden folding chair, like the ones all over the atrium: rounded
 * seat lip, three-slat back, splayed legs, stretchers and side braces.
 * Built once and merged so each chair is a single draw call.
 */
let chairGeo: THREE.BufferGeometry | null = null
function chairGeometry() {
  if (chairGeo) return chairGeo
  const parts: THREE.BufferGeometry[] = []
  const up = new THREE.Vector3(0, 1, 0)
  const rod = (a: THREE.Vector3Tuple, b: THREE.Vector3Tuple, r = 0.016) => {
    const A = new THREE.Vector3(...a)
    const B = new THREE.Vector3(...b)
    const dir = B.clone().sub(A)
    const g = new THREE.CylinderGeometry(r, r, dir.length(), 8)
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize()))
    g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2)
    parts.push(g)
  }
  const slab = (w: number, h: number, d: number, p: THREE.Vector3Tuple, tilt = 0) => {
    const g = new THREE.BoxGeometry(w, h, d)
    g.rotateX(tilt)
    g.translate(...p)
    parts.push(g)
  }
  // seat with a rolled front lip
  slab(0.44, 0.035, 0.4, [0, 0.45, 0.005])
  rod([-0.22, 0.442, 0.205], [0.22, 0.442, 0.205], 0.02)
  // rear legs run up into the back uprights; front legs splay forward
  for (const x of [-0.205, 0.205]) {
    rod([x, 0, -0.27], [x, 0.9, -0.2], 0.017)
    rod([x, 0, 0.25], [x * 0.95, 0.44, 0.17], 0.016)
    rod([x, 0.06, 0.22], [x, 0.4, -0.22], 0.011) // side brace
    rod([x, 0.43, 0.19], [x, 0.43, -0.2], 0.012) // seat rail
  }
  // stretchers between the legs
  rod([-0.205, 0.13, 0.235], [0.205, 0.13, 0.235], 0.012)
  rod([-0.205, 0.13, -0.26], [0.205, 0.13, -0.26], 0.012)
  // three back slats, the top one wide, following the back's lean
  slab(0.43, 0.1, 0.022, [0, 0.83, -0.205], -0.07)
  slab(0.41, 0.045, 0.02, [0, 0.71, -0.212], -0.07)
  slab(0.41, 0.045, 0.02, [0, 0.6, -0.22], -0.07)
  chairGeo = mergeGeometries(parts.map((g) => g.toNonIndexed()))!
  chairGeo.computeVertexNormals()
  return chairGeo
}

export function FoldingChair({ x, z, rot }: { x: number; z: number; rot: number }) {
  return (
    <mesh geometry={chairGeometry()} position={[x, 0, z]} rotation-y={rot} castShadow receiveShadow>
      <meshLambertMaterial color="#f6f6f3" />
    </mesh>
  )
}

/** Retractable banner stand; faces +z unless rotated. */
function RollUp({ map, x, z, rot = 0, w = 0.85, h = 2.05, dark = false }: { map: THREE.Texture; x: number; z: number; rot?: number; w?: number; h?: number; dark?: boolean }) {
  return (
    <group position={[x, 0, z]} rotation-y={rot}>
      <mesh position={[0, 0.05, 0]}>
        <boxGeometry args={[w + 0.08, 0.1, 0.22]} />
        <meshLambertMaterial color={dark ? '#1b1b1f' : '#b9bdc3'} />
      </mesh>
      <mesh position={[0, h / 2 + 0.1, 0]} castShadow>
        <planeGeometry args={[w, h]} />
        <meshLambertMaterial map={map} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, h + 0.12, 0]}>
        <boxGeometry args={[w + 0.02, 0.03, 0.03]} />
        <meshLambertMaterial color="#8d9096" />
      </mesh>
    </group>
  )
}

function Box({ p, s, color, rot = 0 }: { p: THREE.Vector3Tuple; s: THREE.Vector3Tuple; color: string; rot?: number }) {
  return (
    <mesh position={p} rotation-y={rot} castShadow>
      <boxGeometry args={s} />
      <meshLambertMaterial color={color} />
    </mesh>
  )
}

function Cardboard({ x, z, rot = 0, s = 0.5 }: { x: number; z: number; rot?: number; s?: number }) {
  return (
    <group position={[x, 0, z]} rotation-y={rot}>
      <Box p={[0, s * 0.4, 0]} s={[s, s * 0.8, s * 0.8]} color="#b98d5c" />
      <mesh position={[0, s * 0.8, s * 0.42]} rotation-x={-0.9}>
        <planeGeometry args={[s, s * 0.35]} />
        <meshLambertMaterial color="#a67c4e" side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

function Bin({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.45, 0]} castShadow>
        <cylinderGeometry args={[0.28, 0.25, 0.9, 18]} />
        <meshLambertMaterial color="#5d646b" />
      </mesh>
      <mesh position={[0, 0.91, 0]}>
        <torusGeometry args={[0.27, 0.035, 6, 18]} />
        <meshLambertMaterial color="#141416" />
      </mesh>
    </group>
  )
}

/** Small standing card on a table (QR stands, HELP DESK signs). */
function Card({ p, w, h, map, rot = 0 }: { p: THREE.Vector3Tuple; w: number; h: number; map: THREE.Texture; rot?: number }) {
  return (
    <mesh position={p} rotation-y={rot}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={map} side={THREE.DoubleSide} />
    </mesh>
  )
}

/* ------------------------------------------------------------- artwork */

function useArt() {
  return useMemo(() => {
    const qrCard = paint(200, 280, (g) => {
      g.fillStyle = '#fff'
      g.fillRect(0, 0, 200, 280)
      qr(g, 30, 50, 140, 7)
      center(g, 'Scan me', '600 22px Arial', '#1f3a70', 100, 230)
    })
    const helpDesk = paint(300, 200, (g) => {
      const grd = g.createLinearGradient(0, 0, 0, 200)
      grd.addColorStop(0, '#bfe3f7')
      grd.addColorStop(1, '#f2f8fc')
      g.fillStyle = grd
      g.fillRect(0, 0, 300, 200)
      g.fillStyle = '#6f8fa5'
      g.fillRect(0, 160, 300, 40)
      center(g, 'HELP DESK', '800 40px Arial', '#1d2c3a', 150, 90)
    })
    const hardwareSign = paint(300, 200, (g) => {
      const grd = g.createLinearGradient(0, 0, 0, 200)
      grd.addColorStop(0, '#bfe3f7')
      grd.addColorStop(1, '#f2f8fc')
      g.fillStyle = grd
      g.fillRect(0, 0, 300, 200)
      center(g, 'HARDWARE', '800 38px Arial', '#1d2c3a', 150, 80)
      center(g, 'DESK', '800 38px Arial', '#1d2c3a', 150, 125)
    })
    const tv = paint(400, 240, (g) => {
      g.fillStyle = '#f7fbfd'
      g.fillRect(0, 0, 400, 240)
      center(g, 'Happening now @ HackGT', '700 16px Arial', '#3a5a78', 200, 16)
      ;[['Aramco Room', 'Klaus 1447 · 9:00 AM – 9:00 PM'], ['Hacking', 'Ends Sun 8:00 AM'], ['Karaoke', 'Main stage · 10:30 PM – 12:00 AM']].forEach(([a, b], i) => {
        center(g, a, '800 24px Arial', '#1d2c3a', 24, 60 + i * 62, 'left')
        center(g, b, '500 15px Arial', '#5a6f82', 24, 84 + i * 62, 'left')
      })
    })
    return {
      qrCard,
      helpDesk,
      hardwareSign,
      tv,
      /* ---- tablecloth prints ---- */
      hackgt: print('#101114', (g, w, h) => {
        for (const cx of [w * 0.27, w * 0.73]) {
          g.strokeStyle = '#d9d9dc'
          g.lineWidth = 9
          for (const [dx, dy] of [[-44, -18], [16, 22]]) {
            g.beginPath()
            for (let k = 0; k < 6; k++) {
              const a = (Math.PI / 3) * k + Math.PI / 6
              g.lineTo(cx - 120 + dx + 36 * Math.cos(a), h * 0.52 + dy + 36 * Math.sin(a))
            }
            g.closePath()
            g.stroke()
          }
          center(g, 'HackGT', '500 92px Arial', '#e4e4e6', cx + 40, h * 0.54)
        }
      }),
      nsa: print('#18264a', (g, w, h) => {
        g.fillStyle = '#e8eef8'
        g.beginPath()
        g.arc(w * 0.3, h * 0.42, 78, 0, Math.PI * 2)
        g.fill()
        g.fillStyle = '#1d3c7a'
        g.beginPath()
        g.arc(w * 0.3, h * 0.42, 62, 0, Math.PI * 2)
        g.fill()
        g.fillStyle = '#c9a54a' // the eagle, abstracted
        g.beginPath()
        g.moveTo(w * 0.3, h * 0.42 - 34)
        g.lineTo(w * 0.3 + 30, h * 0.42 + 26)
        g.lineTo(w * 0.3 - 30, h * 0.42 + 26)
        g.fill()
        g.fillStyle = '#e8eef8'
        g.fillRect(w * 0.41, h * 0.2, 3, 170)
        ;['NATIONAL', 'SECURITY', 'AGENCY'].forEach((t, i) => center(g, t, '500 44px Georgia, serif', '#f2f4f8', w * 0.44, h * 0.26 + i * 48, 'left'))
        center(g, 'IntelligenceCareers.gov/NSA', '600 36px Arial', '#f2f4f8', w * 0.43, h * 0.84)
      }),
      aramco: print('#63676e', (_g, w, h) => center(_g, 'aramco', '600 150px "Arial Rounded MT Bold", Arial, sans-serif', '#f2f2f2', w / 2, h * 0.5)),
      visa: print('#1a47b0', (g, w, h) => center(g, 'VISA', 'italic 900 150px Arial, sans-serif', '#ffffff', w / 2, h * 0.5)),
      tmobile: print('#e20074', (g, w, h) => {
        center(g, 'T', '900 150px Georgia, serif', '#ffffff', w * 0.3, h * 0.5)
        g.fillStyle = '#fff'
        g.fillRect(w * 0.24, h * 0.3, 18, 18)
        g.fillRect(w * 0.345, h * 0.3, 18, 18)
        center(g, 'Mobile', '500 130px Georgia, serif', '#ffffff', w * 0.37, h * 0.52, 'left')
      }),
      citadel: print('#1f5fc4', (g, w, h) => {
        g.fillStyle = '#e8eef8' // battlements logo
        const x0 = w / 2 - 70
        const y0 = h * 0.4
        for (let i = 0; i < 3; i++) g.fillRect(x0 + i * 52, y0, 36, 26)
        g.fillRect(x0, y0 + 34, 140, 20)
        g.fillRect(x0, y0 + 62, 60, 20)
        g.fillRect(x0 + 70, y0 + 62, 70, 20)
      }),
      notability: print('#63b8ea', (g, w, h) => {
        g.strokeStyle = '#1a2330'
        g.lineWidth = 7
        g.strokeRect(w * 0.33, h * 0.44, 38, 38)
        center(g, 'notability', '700 70px Arial', '#1a2330', w * 0.39, h * 0.5, 'left')
      }),
      impiricus: print('#0c0c10', (g, w, h) => {
        g.strokeStyle = '#ffffff'
        g.lineWidth = 6
        g.beginPath()
        g.arc(w * 0.22, h * 0.34, 34, 0, Math.PI * 2)
        g.stroke()
        center(g, 'IMPIRICUS', '700 90px Arial', '#ffffff', w * 0.3, h * 0.34, 'left')
        center(g, 'The Agentic Commercialization', '600 50px Arial', '#b5c9f2', w / 2, h * 0.62)
        center(g, 'Platform for Healthcare.', '600 50px Arial', '#f0a3c3', w / 2, h * 0.78)
      }),
      mlh: print('#1b2a4a', (g, w, h) => {
        g.font = '900 170px "Arial Black", Arial, sans-serif'
        g.textBaseline = 'middle'
        let x = w * 0.3
        for (const [ch, col] of [['M', '#e73427'], ['L', '#f3f3f3'], ['H', '#f8b92a']]) {
          g.fillStyle = col
          g.fillText(ch, x, h * 0.42)
          x += g.measureText(ch).width + 4
        }
        center(g, 'MAJOR LEAGUE HACKING', '800 50px Arial', '#f3f3f3', w / 2, h * 0.78)
      }),
      striped: paint(512, 64, (g) => {
        for (let i = 0; i < 16; i++) {
          g.fillStyle = i % 2 ? '#f4f6fa' : '#2455a8'
          g.fillRect(i * 32, 0, 32, 64)
        }
      }),
      /* ---- banners & backdrops ---- */
      notabilityWall: paint(900, 700, (g) => {
        g.fillStyle = '#fbfbf9'
        g.fillRect(0, 0, 900, 700)
        g.strokeStyle = '#c9d6ea'
        g.lineWidth = 2
        for (let y = 90; y < 700; y += 38) {
          g.beginPath()
          g.moveTo(0, y)
          g.lineTo(900, y)
          g.stroke()
        }
        center(g, 'REMEMBER!!', '700 34px "Comic Sans MS", "Chalkboard SE", sans-serif', '#222', 60, 60, 'left')
        g.fillStyle = '#e9e6ff'
        g.strokeStyle = '#222'
        g.lineWidth = 5
        g.beginPath()
        g.roundRect(620, 25, 240, 70, 35)
        g.fill()
        g.stroke()
        center(g, 'notability', '800 40px Arial', '#222', 740, 62)
        center(g, 'n', '900 220px Georgia, serif', '#1d2440', 70, 300, 'left')
        center(g, 'the app your', '700 64px "Comic Sans MS", "Chalkboard SE", sans-serif', '#1d1d1d', 260, 200, 'left')
        center(g, 'semester runs on', '700 64px "Comic Sans MS", "Chalkboard SE", sans-serif', '#1d1d1d', 260, 270, 'left')
        center(g, 'to-do by end of week:', '600 34px "Comic Sans MS", "Chalkboard SE", sans-serif', '#222', 60, 420, 'left')
        ;['project research', 'presentation deck', 'finish wireframes', 'group project'].forEach((t, i) => {
          const x = i < 2 ? 70 : 460
          const y = 470 + (i % 2) * 44
          g.strokeRect(x, y - 12, 22, 22)
          center(g, t, '500 28px "Comic Sans MS", sans-serif', '#222', x + 34, y, 'left')
        })
        g.fillStyle = '#ffd966'
        g.fillRect(560, 330, 70, 34)
        center(g, 'Mia', '600 22px Arial', '#222', 595, 347)
        g.fillStyle = '#d9d3ff'
        g.fillRect(620, 560, 80, 34)
        center(g, 'Kami', '600 22px Arial', '#222', 660, 577)
      }),
      notabilityRoll: paint(300, 720, (g) => {
        g.fillStyle = '#0f0f12'
        g.fillRect(0, 0, 300, 720)
        center(g, 'Download', '500 52px Georgia, serif', '#fff', 26, 70, 'left')
        center(g, 'Notability', '500 52px Georgia, serif', '#fff', 26, 130, 'left')
        center(g, 'now', '500 52px Georgia, serif', '#fff', 26, 190, 'left')
        qr(g, 40, 250, 180, 3)
      }),
      tmoTogether: paint(320, 760, (g) => {
        g.fillStyle = '#16161a'
        g.fillRect(0, 0, 320, 760)
        g.fillStyle = '#e20074'
        g.fillRect(24, 30, 80, 80)
        center(g, 'T', '900 64px Georgia', '#fff', 64, 72)
        qr(g, 140, 30, 90, 5)
        center(g, 'Unstoppable.', '800 40px Arial', '#ffffff', 18, 170, 'left')
        center(g, 'Together.', 'italic 800 40px Arial', '#ff4fa6', 18, 215, 'left')
        for (let i = 0; i < 3; i++) {
          g.fillStyle = ['#d8c3b1', '#3a3f4a', '#6b8ab8'][i]
          g.beginPath()
          g.arc(70 + i * 90, 300, 26, 0, Math.PI * 2)
          g.fill()
          g.fillRect(44 + i * 90, 330, 52, 190)
        }
        g.fillStyle = '#e20074'
        g.fillRect(0, 560, 320, 200)
        qr(g, 20, 580, 90, 9)
        center(g, 'Explore what’s possible', '700 20px Arial', '#fff', 124, 610, 'left')
        center(g, '—apply today!', '700 20px Arial', '#fff', 124, 640, 'left')
      }),
      tmoCollage: paint(320, 760, (g) => {
        g.fillStyle = '#f5f5f5'
        g.fillRect(0, 0, 320, 760)
        const cols = ['#e20074', '#f5a9cf', '#6b8f5e', '#f0e0e8', '#d6337f', '#8fb2d8']
        for (let i = 0; i < 2; i++)
          for (let j = 0; j < 5; j++) {
            g.fillStyle = cols[(i * 5 + j) % cols.length]
            g.fillRect(10 + i * 152, 10 + j * 150, 144, 142)
            g.fillStyle = 'rgba(40,30,30,.55)'
            for (let k = 0; k < 3; k++) {
              g.beginPath()
              g.arc(40 + i * 152 + k * 40, 60 + j * 150, 13, 0, Math.PI * 2)
              g.fill()
              g.fillRect(28 + i * 152 + k * 40, 76 + j * 150, 24, 60)
            }
          }
        g.fillStyle = '#e20074'
        g.fillRect(10, 460, 144, 142)
        center(g, 'LOVE OUR', '800 22px Arial', '#fff', 82, 515)
        center(g, 'CUSTOMERS.', '800 22px Arial', '#fff', 82, 545)
      }),
      citadelWelcome: paint(420, 900, (g) => {
        const grd = g.createLinearGradient(0, 0, 420, 900)
        grd.addColorStop(0, '#e9ebec')
        grd.addColorStop(1, '#c9cdd0')
        g.fillStyle = grd
        g.fillRect(0, 0, 420, 900)
        center(g, '▦ CITADEL  |  ▦ CITADEL Securities', '600 18px Georgia', '#2b3645', 26, 60, 'left')
        g.fillStyle = '#56b7c2'
        g.fillRect(26, 120, 40, 5)
        center(g, 'Welcome', '400 76px Georgia, serif', '#1f2a3a', 26, 200, 'left')
        g.fillStyle = '#a9aeb3' // the grey 3D blocks
        for (const [x, y, w, h] of [[26, 470, 120, 100], [260, 470, 120, 100], [26, 590, 240, 90], [290, 590, 90, 90], [26, 700, 360, 110]]) {
          g.fillRect(x, y, w, h)
          g.fillStyle = '#8d9398'
          g.fillRect(x, y + h - 10, w, 10)
          g.fillStyle = '#a9aeb3'
        }
      }),
      aramcoBack: paint(1600, 960, (g) => {
        g.fillStyle = '#f6f7f8'
        g.fillRect(0, 0, 1600, 960)
        for (let row = 0; row < 6; row++)
          for (let col = 0; col < 5; col++) {
            const x = 150 + col * 330 + (row % 2) * 165
            const y = 90 + row * 150
            center(g, 'aramco', '700 52px Arial', '#2a2d33', x, y)
            g.fillStyle = '#1aa37a'
            g.fillRect(x + 95, y - 22, 34, 34)
            g.fillStyle = '#1f7fd0'
            g.fillRect(x + 95, y - 22, 34, 14)
          }
      }),
      aramcoRoll: paint(300, 900, (g) => {
        g.fillStyle = '#3e9fe0'
        g.fillRect(0, 0, 300, 900)
        g.save()
        g.translate(150, 450)
        g.rotate(-Math.PI / 2)
        center(g, 'aramco', '700 150px Arial', '#ffffff', 0, 0)
        g.restore()
      }),
      spacex: paint(700, 400, (g) => {
        g.fillStyle = '#0d0d0f'
        g.fillRect(0, 0, 700, 400)
        center(g, 'SPACEX', '500 84px "Arial", sans-serif', '#f2f2f2', 350, 210)
        g.strokeStyle = '#f2f2f2'
        g.lineWidth = 6
        g.beginPath()
        g.moveTo(420, 230)
        g.quadraticCurveTo(520, 150, 610, 140)
        g.stroke()
      }),
      impRoll: paint(360, 900, (g) => {
        const grd = g.createLinearGradient(0, 0, 0, 900)
        grd.addColorStop(0, '#0f1c3a')
        grd.addColorStop(1, '#0a1226')
        g.fillStyle = grd
        g.fillRect(0, 0, 360, 900)
        center(g, 'IMPIRICUS', '700 46px Arial', '#fff', 180, 70)
        center(g, 'The Agentic Commercialization', '500 20px Arial', '#9fc0ff', 180, 120)
        center(g, 'Platform for Healthcare.', '500 20px Arial', '#f0a3c3', 180, 148)
        ;['Field Representatives', 'Samples', 'Patient Support', 'Medical Information', 'Clinical Resources', 'Next Best Action'].forEach((t, i) => {
          g.strokeStyle = '#4a6fb5'
          g.strokeRect(150, 300 + i * 50, 180, 36)
          center(g, t, '500 16px Arial', '#dfe8ff', 240, 318 + i * 50)
        })
        qr(g, 40, 700, 110, 4)
      }),
      selfBuild: paint(360, 900, (g) => {
        g.fillStyle = '#0b0b0e'
        g.fillRect(0, 0, 360, 900)
        center(g, 'IMPIRICUS', '700 40px Arial', '#fff', 180, 70)
        center(g, 'The Agentic Commercialization', '500 18px Arial', '#9fc0ff', 180, 115)
        center(g, 'Platform for Healthcare.', '500 18px Arial', '#f0a3c3', 180, 140)
        g.fillStyle = '#e25a8c'
        g.fillRect(150, 185, 60, 3)
        center(g, 'self.build()', '500 46px Menlo, monospace', '#fff', 180, 250)
        g.strokeStyle = '#d7d9e0' // line-drawn minifigure
        g.lineWidth = 3
        g.strokeRect(140, 330, 80, 70)
        g.strokeRect(110, 405, 140, 170)
        g.strokeRect(120, 580, 55, 190)
        g.strokeRect(185, 580, 55, 190)
        g.strokeStyle = '#e25a8c'
        g.beginPath()
        g.moveTo(180, 420)
        g.lineTo(180, 560)
        g.lineTo(230, 560)
        g.stroke()
      }),
      metaQR: paint(300, 300, (g) => {
        g.fillStyle = '#f7f7f5'
        g.fillRect(0, 0, 300, 300)
        center(g, 'Get your free Meta', '700 20px Arial', '#1c2b33', 150, 26)
        center(g, 'Model API credits', '700 20px Arial', '#1c2b33', 150, 50)
        qr(g, 22, 90, 110, 11)
        qr(g, 168, 90, 110, 12)
        center(g, '1. Create an account', '500 13px Arial', '#444', 77, 222)
        center(g, '2. Complete the form', '500 13px Arial', '#444', 223, 222)
        center(g, '∞ Meta', '600 16px Arial', '#1d64d8', 250, 280)
      }),
      gameScreen: paint(320, 200, (g) => {
        const grd = g.createLinearGradient(0, 0, 0, 200)
        grd.addColorStop(0, '#8fd3ff')
        grd.addColorStop(1, '#d9f1ff')
        g.fillStyle = grd
        g.fillRect(0, 0, 320, 200)
        g.fillStyle = '#7fd06a'
        g.beginPath()
        g.arc(160, 330, 200, 0, Math.PI * 2)
        g.fill()
        g.fillStyle = '#fffdf6'
        g.strokeStyle = '#2b2a33'
        g.lineWidth = 4
        g.fillRect(90, 40, 140, 110)
        g.strokeRect(90, 40, 140, 110)
        center(g, 'Campus Quest', '800 18px Arial', '#f5b700', 160, 64)
        g.fillStyle = '#e0564f'
        g.fillRect(105, 118, 110, 20)
        center(g, 'Start ▸', '700 11px Arial', '#fff', 160, 128)
      }),
      metaLong: print('#2d434d', (g, w, h) => center(g, '∞ Meta', '600 150px Arial', '#e9eef8', w / 2, h * 0.45)),
      meta: paint(400, 1000, (g) => {
        g.fillStyle = '#f6f8fb'
        g.fillRect(0, 0, 400, 1000)
        center(g, '∞ Meta', '600 64px Arial', '#1d64d8', 200, 150)
        center(g, 'Make Every', '500 30px Arial', '#1c2b33', 200, 380)
        center(g, 'Connection Matter', '500 30px Arial', '#1c2b33', 200, 420)
      }),
      plaque: paint(300, 400, (g) => {
        g.fillStyle = '#d7dadd'
        g.fillRect(0, 0, 300, 400)
        center(g, 'CHRISTOPHER W. KLAUS', '700 18px Georgia', '#2b2f35', 150, 40)
        center(g, 'ADVANCED COMPUTING BUILDING', '600 13px Georgia', '#2b2f35', 150, 64)
        g.fillStyle = '#3a3d44'
        g.fillRect(40, 90, 90, 110)
        g.fillStyle = '#9aa0a6'
        for (let i = 0; i < 9; i++) g.fillRect(30, 230 + i * 16, 240, 5)
      }),
    }
  }, [])
}

/* ------------------------------------------------------------ the booths */

type Art = ReturnType<typeof useArt>

/** Blue paper waves + life rings taped along the back wall behind the sponsor row. */
function WaveWall() {
  // Two torn-paper wave bands taped along the base of the curved back wall.
  const geo = useMemo(() => {
    const strip = (top: number, amp: number, seed: number, off: number) => {
      const pos: number[] = []
      const x0 = X0 + 0.5
      const x1 = 16.5
      const step = 0.2
      for (let x = x0; x < x1; x += step) {
        const y = (xx: number) => top + amp * Math.sin(xx * 2.3 + seed) + amp * 0.6 * Math.sin(xx * 5.1 + seed * 2)
        const za = wallZ(x) + off
        const zb = wallZ(x + step) + off
        pos.push(x, 0.25, za, x + step, 0.25, zb, x + step, y(x + step), zb, x, 0.25, za, x + step, y(x + step), zb, x, y(x), za)
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.computeVertexNormals()
      return g
    }
    return { teal: strip(1.75, 0.1, 4, 0.04), navy: strip(1.25, 0.08, 1, 0.06) }
  }, [])
  return (
    <group>
      <mesh geometry={geo.teal}>
        <meshLambertMaterial color="#2fb3d8" side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geo.navy}>
        <meshLambertMaterial color="#27479a" side={THREE.DoubleSide} />
      </mesh>
      {[-9, 1.2, 6.2, 10.8].map((x) => (
        <group key={x} position={[x, 1.7, wallZ(x) + 0.14]}>
          <mesh>
            <torusGeometry args={[0.32, 0.1, 10, 28]} />
            <meshLambertMaterial color="#f6f3ee" />
          </mesh>
          {[0, 1, 2, 3].map((k) => (
            <mesh key={k} rotation-z={(k * Math.PI) / 2}>
              <torusGeometry args={[0.32, 0.105, 10, 6, Math.PI / 5]} />
              <meshLambertMaterial color="#e2433b" />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  )
}

function BackRow({ art }: { art: Art }) {
  const zT = -25.6 // table row along the back wall, fronts facing the atrium
  return (
    <group>
      <WaveWall />
      {/* Notability: notebook backdrop, black QR roll-up, light-blue table (under the lettering) */}
      <mesh position={[-5.6, 1.35, Z0 + 1.1]} castShadow>
        <planeGeometry args={[3.2, 2.5]} />
        <meshLambertMaterial map={art.notabilityWall} side={THREE.DoubleSide} />
      </mesh>
      <RollUp map={art.notabilityRoll} x={-3.5} z={Z0 + 1.5} w={0.8} h={2} dark />
      <group position={[-6, 0, -24.6]}>
        <Cloth w={2.8} d={0.9} color="#63b8ea" front={art.notability} seed={2} />
        <Swag w={2.8} seed={2} />
      </group>
      <Cardboard x={-3.1} z={-25} rot={0.4} />
      <Cardboard x={-2.7} z={-24.4} rot={-0.3} s={0.4} />
      <mesh position={[-8.1, 0.32, -24.2]} rotation-y={0.4}>
        <coneGeometry args={[0.18, 0.64, 4]} />
        <meshLambertMaterial color="#f2c230" />
      </mesh>

      {/* Visa */}
      <group position={[0.6, 0, zT]}>
        <Cloth w={2.8} d={0.9} color="#1a47b0" front={art.visa} seed={5} loose={1.3} />
        <Swag w={2.8} seed={5} />
      </group>
      {[0.1, 1.1].map((x) => (
        <FoldingChair key={x} x={x} z={-26.7} rot={0} />
      ))}
      <Cardboard x={2.2} z={-26.8} />

      {/* T-Mobile: photo-collage roll-up, table, "Unstoppable. Together.", road case */}
      <RollUp map={art.tmoCollage} x={2.9} z={-26.7} />
      <group position={[4.6, 0, zT]}>
        <Cloth w={2.8} d={0.9} color="#e20074" front={art.tmobile} seed={9} loose={1.2} />
        <Swag w={2.8} seed={9} />
      </group>
      <Card p={[4.6, 0.9, zT]} w={0.2} h={0.28} map={art.qrCard} />
      <RollUp map={art.tmoTogether} x={6.3} z={-26.5} />
      <Box p={[7.3, 0.55, -26.8]} s={[0.8, 1.1, 0.6]} color="#141417" />

      {/* Citadel: silver "Welcome" roll-up + royal-blue table with QR stands */}
      <RollUp map={art.citadelWelcome} x={8.5} z={-26.5} w={1.1} h={2.3} />
      <group position={[10.5, 0, zT]}>
        <Cloth w={2.8} d={0.9} color="#1f5fc4" front={art.citadel} seed={4} loose={1.4} />
        <Swag w={2.8} seed={4} laptops={0} />
      </group>
      {[9.8, 11.2].map((x) => (
        <Card key={x} p={[x, 0.93, zT]} w={0.22} h={0.3} map={art.qrCard} />
      ))}
      <FoldingChair x={10.5} z={-26.6} rot={0} />

      {/* Aramco: blue roll-up, step-and-repeat, two grey cloths, bin, and the man in the folding chair */}
      <RollUp map={art.aramcoRoll} x={12.6} z={-26.4} w={0.8} h={2.3} />
      <mesh position={[15.3, 1.3, Z0 + 0.6]} castShadow>
        <planeGeometry args={[4, 2.3]} />
        <meshLambertMaterial map={art.aramcoBack} side={THREE.DoubleSide} />
      </mesh>
      <group position={[14.3, 0, -26]}>
        <Cloth w={1.95} d={0.9} color="#63676e" seed={6} />
        <Swag w={1.95} seed={6} laptops={0} />
      </group>
      <group position={[16.3, 0, -26]}>
        <Cloth w={2.05} d={0.9} color="#63676e" front={art.aramco} seed={8} />
        <Swag w={2.05} seed={8} />
      </group>
      {[14.3, 16.3].map((x) => (
        <FoldingChair key={x} x={x} z={-26.9} rot={0} />
      ))}
      <Bin x={18.1} z={-26.8} />
      <FoldingChair x={18.9} z={-24.3} rot={-Math.PI / 2} />
    </group>
  )
}

/** A booth frame along the east glass: x = glass - `in` metres, following the splay. */
function Along({ z, children }: { z: number; children: React.ReactNode }) {
  const splay = z < 3
  return (
    <group position={[X1 + ex(z), 0, z]} rotation-y={splay ? -SLANT : 0}>
      <group position={[-X1, 0, -z]}>{children}</group>
    </group>
  )
}

const TX = X1 - 1.15 // sponsor table centre line, reps' chairs between it and the glass
const REP = X1 - 0.45
const FRONT = TX - 1.05 // a visitor chair on the aisle side

function SuitCase({ x, z, rot = 0 }: { x: number; z: number; rot?: number }) {
  return (
    <group position={[x, 0, z]} rotation-y={rot}>
      <Box p={[0, 0.38, 0]} s={[0.42, 0.66, 0.26]} color="#2c63c9" />
      {[-0.1, 0.1].map((x) => <Box key={x} p={[x, 0.95, -0.08]} s={[0.02, 0.5, 0.02]} color="#9aa0a6" />)}
      <Box p={[0, 1.2, -0.08]} s={[0.24, 0.03, 0.03]} color="#1d1e22" />
      {[-0.15, 0.15].map((x) => <Box key={x} p={[x, 0.03, 0.08]} s={[0.05, 0.05, 0.05]} color="#141417" />)}
      {/* T-Mobile swag tote hanging off the handle */}
      <Box p={[0, 0.95, 0.12]} s={[0.36, 0.42, 0.08]} color="#e20074" />
      <Box p={[0, 1.02, 0.165]} s={[0.26, 0.1, 0.005]} color="#f4f4f0" />
    </group>
  )
}

function Backpack({ x, z, rot = 0, color = '#2b2d33', y = 0 }: { x: number; z: number; rot?: number; color?: string; y?: number }) {
  return (
    <group position={[x, y, z]} rotation-y={rot}>
      <Box p={[0, 0.2, 0]} s={[0.34, 0.4, 0.2]} color={color} />
      <mesh position={[0, 0.4, 0]} rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[0.17, 0.17, 0.2, 12]} />
        <meshLambertMaterial color={color} />
      </mesh>
      <Box p={[0, 0.15, 0.12]} s={[0.26, 0.18, 0.06]} color={color} />
    </group>
  )
}

function EastRow({ art }: { art: Art }) {
  // Along the east windows, back corner to the lobby; table fronts face west, into the atrium.
  const west = -Math.PI / 2
  return (
    <group>
      {/* NSA: navy cloth, swag and blue cups, two reps' chairs, a spare pair of chairs by the bin */}
      <Along z={-20}>
        <group position={[TX, 0, -20]} rotation-y={west}>
          <Cloth w={3} d={0.9} color="#18264a" front={art.nsa} seed={3} />
          <Swag w={3} seed={3} />
          <Box p={[-1.1, 0.83, 0.2]} s={[0.3, 0.14, 0.2]} color="#2a5cc8" />
          <Box p={[-0.8, 0.82, 0.25]} s={[0.22, 0.12, 0.16]} color="#2a5cc8" />
        </group>
        {[-20.8, -19.2].map((z) => <FoldingChair key={z} x={REP} z={z} rot={west} />)}
        <Backpack x={REP + 0.05} z={-18.3} rot={0.4} color="#1f2f4a" />
        <Bin x={REP} z={-22.4} />
        {[-23.2, -22.5].map((z, i) => <FoldingChair key={z} x={TX - 0.2 - i * 0.2} z={z - 0.4} rot={west + 0.3 * i} />)}
      </Along>

      {/* Meta: long navy table, QR stands, two laptops, the white roll-up at the south end */}
      <Along z={-12.5}>
        <group position={[TX, 0, -12.5]} rotation-y={west}>
          <Cloth w={3} d={0.9} color="#2d434d" front={art.metaLong} seed={15} />
          {[-1.2, -0.7].map((x, i) => (
            <group key={x} position={[x, 0.76, -0.15]} rotation-y={0.25 - i * 0.2}>
              <Box p={[0, 0.03, 0]} s={[0.34, 0.05, 0.1]} color="#b98652" />
              <mesh position={[0, 0.2, 0]}>
                <planeGeometry args={[0.3, 0.3]} />
                <meshBasicMaterial map={art.metaQR} side={THREE.DoubleSide} />
              </mesh>
            </group>
          ))}
          <mesh position={[-1.35, 0.88, 0.2]}>
            <cylinderGeometry args={[0.035, 0.035, 0.24, 12]} />
            <meshLambertMaterial color="#d8ecf8" transparent opacity={0.75} />
          </mesh>
          {[0.2, 0.85].map((x, i) => (
            <group key={x} position={[x, 0.77, -0.05]} rotation-y={Math.PI + (i ? -0.15 : 0.1)}>
              <Box p={[0, 0.01, 0]} s={[0.34, 0.015, 0.24]} color={i ? '#2b2d33' : '#c9ccd2'} />
              <group position={[0, 0.01, -0.12]} rotation-x={-0.25}>
                <Box p={[0, 0.11, 0]} s={[0.34, 0.22, 0.012]} color={i ? '#2b2d33' : '#c9ccd2'} />
                <mesh position={[0, 0.11, 0.007]}>
                  <planeGeometry args={[0.31, 0.2]} />
                  <meshBasicMaterial map={metaScreen()} toneMapped={false} />
                </mesh>
              </group>
            </group>
          ))}
          <Box p={[-0.2, 0.77, 0.2]} s={[0.08, 0.01, 0.16]} color="#141417" />
          <Box p={[1.3, 0.77, 0.25]} s={[0.12, 0.005, 0.18]} color="#f2c230" />
        </group>
        {[-13.3, -11.7].map((z) => <FoldingChair key={z} x={REP} z={z} rot={west} />)}
        <FoldingChair x={FRONT} z={-12.9} rot={Math.PI / 2 + 0.35} />
        <Backpack x={REP} z={-10.9} rot={-0.3} />
        <RollUp map={art.meta} x={TX - 0.1} z={-10.5} rot={-1.28} w={1} h={2.3} />
      </Along>

      {/* Impiricus: roll-ups either side of the black cloth, swag spread, reps behind */}
      <Along z={-4.2}>
        <RollUp map={art.impRoll} x={TX} z={-6.6} rot={west} w={0.9} h={2.1} dark />
        <group position={[TX, 0, -4.2]} rotation-y={west}>
          <Cloth w={3} d={0.9} color="#0c0c10" front={art.impiricus} seed={11} />
          <Swag w={3} seed={11} laptops={2} />
        </group>
        {[-5, -3.4].map((z) => <FoldingChair key={z} x={REP} z={z} rot={west} />)}
        <Backpack x={REP + 0.05} z={-6} rot={0.2} color="#6d2e2e" />
        <RollUp map={art.selfBuild} x={TX} z={-1.9} rot={west} w={0.95} h={2.2} dark />
        <SuitCase x={TX - 0.2} z={-1.2} rot={0.3} />
      </Along>

      {/* maple folding table where two hackers set up, the big carton leaning on the column */}
      <Along z={0.6}>
        <group position={[TX - 0.2, 0, 0.6]} rotation-y={Math.PI / 2}>
          <FoldingTable len={1.9} leaves={1} seed={41} seats={[-0.4, 0.4]} seatsBack={[0]} />
        </group>
        <group position={[REP, 0, 2]} rotation-z={0.1}>
          <Box p={[0, 0.8, 0]} s={[0.3, 1.6, 0.8]} color="#b98d5c" />
        </group>
      </Along>

      {/* SpaceX: plain black cloth, the banner on the glass, bags on the reps' chairs */}
      <group position={[TX, 0, 4.8]} rotation-y={west}>
        <Cloth w={2.8} d={0.9} color="#0d0d10" seed={13} loose={1.5} />
        <Swag w={2.8} seed={13} laptops={0} />
      </group>
      {[4.1, 5.5].map((z) => <FoldingChair key={z} x={REP} z={z} rot={west} />)}
      <Box p={[REP, 0.72, 4.1]} s={[0.4, 0.34, 0.14]} color="#b98a55" />
      <Backpack x={REP} z={5.5} y={0.46} rot={Math.PI / 2} color="#4a3a31" />
      <mesh position={[X1 - 0.03, 2.5, 4.8]} rotation-y={west}>
        <planeGeometry args={[1.6, 0.9]} />
        <meshBasicMaterial map={art.spacex} />
      </mesh>

      {/* maple tables along the glass where people eat and hack */}
      {[8.6, 11.6].map((z, i) => (
        <group key={z} position={[X1 - 0.95, 0, z]} rotation-y={Math.PI / 2}>
          <FoldingTable len={1.9} leaves={1} seed={51 + i * 4} seats={i ? [0] : [-0.45, 0.45]} seatsBack={[0.3]} />
        </group>
      ))}
    </group>
  )
}

export function Bear({ x, z, rot, y = 0, chair = true }: { x: number; z: number; rot: number; y?: number; chair?: boolean }) {
  const teal = '#56c6d8'
  return (
    <group position={[x, y, z]} rotation-y={rot}>
      {chair && <FoldingChair x={0} z={0} rot={0} />}
      <group position={[0, 0.5, 0.02]}>
        <mesh position={[0, 0.32, 0]} scale={[1, 1.1, 0.85]}>
          <sphereGeometry args={[0.28, 16, 12]} />
          <meshToonMaterial color={teal} />
        </mesh>
        <mesh position={[0, 0.8, 0]}>
          <sphereGeometry args={[0.22, 16, 12]} />
          <meshToonMaterial color={teal} />
        </mesh>
        {[-0.15, 0.15].map((ex) => (
          <mesh key={ex} position={[ex, 0.98, 0]}>
            <sphereGeometry args={[0.07, 10, 8]} />
            <meshToonMaterial color={teal} />
          </mesh>
        ))}
        <mesh position={[0, 0.76, 0.19]}>
          <sphereGeometry args={[0.08, 10, 8]} />
          <meshToonMaterial color="#cdeef3" />
        </mesh>
        {/* bucket hat */}
        <mesh position={[0, 0.97, 0]}>
          <cylinderGeometry args={[0.17, 0.2, 0.14, 16]} />
          <meshLambertMaterial color="#b89a6a" />
        </mesh>
        <mesh position={[0, 0.91, 0]}>
          <cylinderGeometry args={[0.3, 0.3, 0.02, 20]} />
          <meshLambertMaterial color="#a88a5a" />
        </mesh>
        {[-0.22, 0.22].map((lx) => (
          <mesh key={lx} position={[lx, 0.05, 0.2]} rotation-x={-1.3}>
            <capsuleGeometry args={[0.09, 0.2, 4, 8]} />
            <meshToonMaterial color={teal} />
          </mesh>
        ))}
      </group>
    </group>
  )
}

function Organizers({ art }: { art: Art }) {
  return (
    <group>
      {/* HackGT Help Desk in the open floor beside Tables 1 & 3, facing the tables: TV, signs, the bear */}
      <group position={[-2.8, 0, -9.2]} rotation-y={Math.PI / 2}>
        <Cloth w={4.2} d={0.9} color="#101114" front={art.hackgt} seed={2} />
        <mesh position={[-1.2, 1.2, -0.1]}>
          <boxGeometry args={[1.25, 0.74, 0.05]} />
          <meshLambertMaterial color="#111" />
        </mesh>
        <mesh position={[-1.2, 1.2, -0.07]}>
          <planeGeometry args={[1.18, 0.67]} />
          <meshBasicMaterial map={art.tv} />
        </mesh>
        <Box p={[-1.2, 0.8, -0.1]} s={[0.3, 0.05, 0.2]} color="#222" />
        {[-1.6, 0.1, 1.5].map((x) => (
          <Card key={x} p={[x, 0.62, 0.47]} w={0.36} h={0.24} map={art.helpDesk} />
        ))}
        <Box p={[0.5, 0.8, 0]} s={[0.4, 0.03, 0.28]} color="#2b2d33" />
      </group>
      <Bear x={-2.9} z={-6.3} rot={Math.PI / 2 - 0.3} />

      {/* Hardware Desk under the high end of the stair: striped cloth, parts bins, the line */}
      <group position={[-3.3, 0, 7.5]} rotation-y={Math.PI / 2}>
        <Cloth w={3.6} d={1.2} color="#2455a8" front={art.striped} seed={7} />
        {[-1.3, -0.65, 0, 0.65, 1.3].map((x, i) => (
          <Box key={x} p={[x, 0.84, 0.05]} s={[0.5, 0.12, 0.34]} color={['#e9eef2', '#cfd8df', '#f4f4f0', '#dfe6ea', '#e9eef2'][i]} />
        ))}
        <Card p={[0.4, 0.5, 0.63]} w={0.4} h={0.28} map={art.hardwareSign} />
      </group>
      <mesh position={[westX(1.2) + 0.04, 1.7, 1.2]} rotation-y={Math.PI / 2 + Math.atan(westSlope(1.2))}>
        <planeGeometry args={[0.75, 1]} />
        <meshLambertMaterial map={art.plaque} />
      </mesh>

      {/* MLH at the stair foot: card towers on the cloth, balloons piled under the stair */}
      <group position={[-1.8, 0, 15.5]} rotation-y={Math.PI / 2}>
        <Cloth w={3.2} d={1.2} color="#1b2a4a" front={art.mlh} seed={5} />
        {[-1.2, 1.2].map((x) =>
          [0, 1, 2, 3].map((k) => (
            <Box
              key={`${x}${k}`}
              p={[x, 0.93 + k * 0.3, 0]}
              s={[0.3, 0.29, 0.3]}
              rot={k * 0.2}
              color={['#f2c230', '#e8543f', '#1d1d20', '#f4f4f0'][(k + (x > 0 ? 2 : 0)) % 4]}
            />
          )),
        )}
        {[-0.6, -0.2, 0.3, 0.7].map((x) => (
          <Box key={x} p={[x, 0.79, 0.15]} s={[0.25, 0.02, 0.18]} color="#f4f4f0" />
        ))}
      </group>
    </group>
  )
}

const BALLOONS: [number, number, number, string][] = (() => {
  const out: [number, number, number, string][] = []
  const cols = ['#f2c230', '#3f8ea0', '#e07a6a', '#efe2c0', '#9fd0e0', '#1f6f7f']
  let r = 11
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 34; i++) {
    const x = -7.9 + rnd() * 3.2
    const z = 12 + rnd() * 3.6
    const s = 0.22 + rnd() * 0.08
    out.push([x, z, s, cols[Math.floor(rnd() * cols.length)]])
  }
  return out
})()

function Balloons() {
  return (
    <group>
      {BALLOONS.map(([x, z, s, c], i) => (
        <mesh key={i} position={[x, s + (i % 3 === 0 ? s * 1.4 : 0), z]}>
          <sphereGeometry args={[s, 14, 10]} />
          <meshLambertMaterial color={c} />
        </mesh>
      ))}
    </group>
  )
}

export function Sponsors() {
  const art = useArt()
  return (
    <group>
      <BackRow art={art} />
      {/* drawn against the old 44 m wall line; the room is now 40 m wide */}
      <group position={[-2, 0, 0]}>
        <EastRow art={art} />
      </group>
      <Organizers art={art} />
      <Balloons />
    </group>
  )
}
