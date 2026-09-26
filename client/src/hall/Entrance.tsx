import { useMemo } from 'react'
import * as THREE from 'three'
import { CX, DOORS_Z, L1, SEMINAR_Z, X0, X1, Z1 } from './layout'
import { textCard } from './textures'
import { FoldingChair } from './Sponsors'

// The entrance lobby under the mezzanine, from the on-site photos:
//  - the main doors: two pairs of white-framed glass doors, EXIT signs, a white
//    pillar with a sanitizer dispenser, glass sidelights and a trash can;
//  - to the west: Seminar Room West (wooden double doors, one open), a side
//    corridor, recycling bin, and folding tables where people hack;
//  - to the east: the Klaus Research Wing glass vestibule with its EXIT sign,
//    info kiosk, AED, green plaque, the lobby screen and a folding table.

const FRAME = '#f3f2ee'
const WALL = '#efece6'
const Z = Z1 - 0.03 // just in front of the south wall

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

/** Glass looking into the dim vestibule: grey-green, a pale floor, lights and the far doors. */
function vestibuleGlass(tint = '#5d6b6c') {
  return canvas(128, 256, (g) => {
    const grd = g.createLinearGradient(0, 0, 0, 256)
    grd.addColorStop(0, '#3c4548')
    grd.addColorStop(0.62, tint)
    grd.addColorStop(0.63, '#aab3b1')
    grd.addColorStop(1, '#c8cecb')
    g.fillStyle = grd
    g.fillRect(0, 0, 128, 256)
    g.strokeStyle = 'rgba(235,238,236,.55)' // the far pair of doors
    g.lineWidth = 4
    g.strokeRect(34, 70, 60, 110)
    g.fillStyle = '#4a4f55' // entry mat
    g.fillRect(20, 190, 80, 14)
    g.fillStyle = 'rgba(255,255,240,.85)'
    for (const [x, y] of [[30, 30], [96, 42], [64, 18]]) {
      g.beginPath()
      g.ellipse(x, y, 8, 3, 0, 0, Math.PI * 2)
      g.fill()
    }
    g.fillStyle = 'rgba(255,255,255,.12)' // reflection streak
    g.fillRect(10, 0, 10, 256)
  })
}

/** Sidelight: frosted glass with the round white column behind it. */
function sidelight() {
  return canvas(128, 256, (g) => {
    g.fillStyle = '#b9c7c3'
    g.fillRect(0, 0, 128, 256)
    const grd = g.createLinearGradient(20, 0, 108, 0)
    grd.addColorStop(0, '#d4dcd9')
    grd.addColorStop(0.5, '#eef2f0')
    grd.addColorStop(1, '#c2ccc9')
    g.fillStyle = grd
    g.fillRect(24, 0, 84, 232)
    g.fillStyle = 'rgba(90,100,100,.35)'
    g.fillRect(0, 232, 128, 24)
  })
}

function exitSign() {
  return canvas(256, 96, (g) => {
    g.fillStyle = 'rgba(210,255,200,.22)'
    g.fillRect(0, 0, 256, 96)
    g.font = '700 70px Arial, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = '#6cff6a'
    g.shadowColor = '#7dff78'
    g.shadowBlur = 16
    g.fillText('EXIT', 128, 52)
  })
}

function Box({ p, s, color, map }: { p: THREE.Vector3Tuple; s: THREE.Vector3Tuple; color?: string; map?: THREE.Texture }) {
  return (
    <mesh position={p}>
      <boxGeometry args={s} />
      <meshLambertMaterial color={map ? '#ffffff' : color} map={map} />
    </mesh>
  )
}

function Plane({ p, w, h, map, basic, rotY = Math.PI, transparent }: { p: THREE.Vector3Tuple; w: number; h: number; map: THREE.Texture; basic?: boolean; rotY?: number; transparent?: boolean }) {
  return (
    <mesh position={p} rotation-y={rotY}>
      <planeGeometry args={[w, h]} />
      {basic ? <meshBasicMaterial map={map} transparent={transparent} /> : <meshLambertMaterial map={map} transparent={transparent} />}
    </mesh>
  )
}

/** One door leaf: white frame, glass, push bar; faces into the lobby (-z). */
function Leaf({ x, w, glass, sticker }: { x: number; w: number; glass: THREE.Texture; sticker?: boolean }) {
  return (
    <group position={[x, 0, Z - 0.06]}>
      <Box p={[0, 1.25, 0]} s={[w, 2.5, 0.08]} color={FRAME} />
      <Plane p={[0, 1.3, -0.045]} w={w - 0.32} h={2.05} map={glass} basic />
      <mesh position={[0, 1.02, -0.11]} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.022, 0.022, w - 0.18, 8]} />
        <meshLambertMaterial color="#b8bcc2" />
      </mesh>
      {sticker && (
        <mesh position={[0.05, 1.25, -0.05]} rotation-y={Math.PI}>
          <circleGeometry args={[0.1, 20]} />
          <meshBasicMaterial color="#f2c230" />
        </mesh>
      )}
    </group>
  )
}

function MainDoors() {
  const glass = useMemo(() => vestibuleGlass(), [])
  const side = useMemo(() => sidelight(), [])
  const exit = useMemo(() => exitSign(), [])
  const leaves = [-1.87, -0.8, 0.8, 1.87]
  return (
    <group>
      {/* surround */}
      <Box p={[0, 2.7, Z - 0.02]} s={[9.2, 0.4, 0.14]} color={FRAME} />
      {[-4.6, -2.45, 2.45, 4.6].map((x) => (
        <Box key={x} p={[x, 1.35, Z - 0.02]} s={[0.12, 2.7, 0.14]} color={FRAME} />
      ))}
      {/* sidelights with the round column behind */}
      {[-3.52, 3.52].map((x) => (
        <Plane key={x} p={[x, 1.35, Z - 0.03]} w={2.05} h={2.6} map={side} basic />
      ))}
      {/* the two pairs of doors, pillar with sanitizer between */}
      {leaves.map((x, i) => (
        <Leaf key={x} x={x} w={1.04} glass={glass} sticker={i === 1} />
      ))}
      <Box p={[0, 1.25, Z - 0.05]} s={[0.5, 2.5, 0.16]} color={FRAME} />
      <Box p={[0, 1.12, Z - 0.16]} s={[0.16, 0.26, 0.1]} color="#fbfbfb" />
      <Box p={[0, 1.02, Z - 0.2]} s={[0.1, 0.06, 0.04]} color="#b8dff0" />
      <Box p={[0, 1.55, Z - 0.14]} s={[0.1, 0.16, 0.02]} color="#c9ccd0" />
      {/* door operators on the header */}
      {[-1.6, 1.1].map((x) => (
        <Box key={x} p={[x, 2.42, Z - 0.16]} s={[0.7, 0.12, 0.12]} color="#b6b9bd" />
      ))}
      {/* edge-lit EXIT signs */}
      {[-1.35, 1.35].map((x) => (
        <group key={x}>
          <Box p={[x, 3.28, Z - 0.35]} s={[0.62, 0.05, 0.12]} color="#c9ccd0" />
          <Plane p={[x, 3.08, Z - 0.35]} w={0.6} h={0.24} map={exit} basic transparent />
        </group>
      ))}
      {/* trash can */}
      <mesh position={[5.6, 0.45, Z - 0.35]}>
        <cylinderGeometry args={[0.28, 0.26, 0.9, 20]} />
        <meshLambertMaterial color="#9da2a8" />
      </mesh>
      <mesh position={[5.6, 0.92, Z - 0.35]}>
        <torusGeometry args={[0.27, 0.04, 6, 20]} />
        <meshLambertMaterial color="#1a1a1c" />
      </mesh>
    </group>
  )
}

function SeminarRoom() {
  const room = useMemo(
    () =>
      canvas(256, 320, (g) => {
        g.fillStyle = '#f2f2ef'
        g.fillRect(0, 0, 256, 320)
        g.fillStyle = '#dfe3e6' // ceiling lights
        for (let i = 0; i < 4; i++) g.fillRect(20 + i * 60, 18, 40, 8)
        g.fillStyle = '#6b6f78' // carpet
        g.fillRect(0, 230, 256, 90)
        g.fillStyle = '#c9a36c' // lectern with the GT logo
        g.fillRect(120, 160, 90, 80)
        g.fillStyle = '#003057'
        g.fillRect(140, 175, 50, 22)
        g.fillStyle = '#ffffff'
        g.fillRect(40, 70, 70, 90) // whiteboard
        g.strokeStyle = '#8b8f96'
        g.strokeRect(40, 70, 70, 90)
      }),
    [],
  )
  const plate = useMemo(
    () =>
      textCard(
        [
          { text: 'SEMINAR', font: '700 52px Arial, sans-serif', color: '#ffffff' },
          { text: 'ROOM WEST', font: '700 52px Arial, sans-serif', color: '#ffffff' },
        ],
        { bg: '#1f3350', w: 320, h: 220 },
      ),
    [],
  )
  const poster = useMemo(
    () =>
      canvas(160, 120, (g) => {
        const grd = g.createLinearGradient(0, 0, 0, 120)
        grd.addColorStop(0, '#9ccbee')
        grd.addColorStop(1, '#e8f3fb')
        g.fillStyle = grd
        g.fillRect(0, 0, 160, 120)
        g.fillStyle = '#4b6a8a'
        g.beginPath()
        g.moveTo(0, 100)
        g.lineTo(50, 70)
        g.lineTo(90, 90)
        g.lineTo(160, 60)
        g.lineTo(160, 120)
        g.lineTo(0, 120)
        g.fill()
        g.font = '700 22px Arial'
        g.fillStyle = '#1b2a3b'
        g.textAlign = 'center'
        g.fillText('EXIT', 80, 50)
      }),
    [],
  )
  const corridor = useMemo(
    () =>
      canvas(256, 256, (g) => {
        g.fillStyle = '#e9e8e3'
        g.fillRect(0, 0, 256, 256)
        g.fillStyle = '#d7d3c9' // floor in perspective
        g.beginPath()
        g.moveTo(0, 256)
        g.lineTo(96, 150)
        g.lineTo(160, 150)
        g.lineTo(256, 256)
        g.fill()
        g.fillStyle = '#1e2630' // night windows at the far end
        g.fillRect(100, 70, 56, 80)
        g.strokeStyle = '#e9e8e3'
        g.lineWidth = 3
        g.strokeRect(100, 70, 28, 80)
        g.fillStyle = '#ffffff'
        for (const y of [30, 55]) g.fillRect(118, y, 20, 5)
      }),
    [],
  )
  const x0 = -9.6 // left hinge of the double door
  return (
    <group>
      {/* Drawn in south-wall coordinates (door centre x=-8.6), then turned onto the
          west wall facing east, centred on SEMINAR_Z, as in the lobby photos. */}
      <group position={[X0, 0, SEMINAR_Z + 8.6]} rotation-y={-Math.PI / 2}>
        <group position={[0, 0, -Z1]}>
      {/* recessed alcove */}
      <Box p={[-8.6, 2.75, Z - 0.35]} s={[3.2, 0.3, 0.7]} color={WALL} />
      {[-10.25, -6.95].map((x) => (
        <Box key={x} p={[x, 1.3, Z - 0.35]} s={[0.1, 2.6, 0.7]} color={WALL} />
      ))}
      {/* the lit seminar room through the open door */}
      <Plane p={[-8.6, 1.25, Z - 0.02]} w={2.1} h={2.5} map={room} basic />
      {/* right leaf closed, left leaf swung open into the lobby */}
      <Box p={[-8.05, 1.25, Z - 0.08]} s={[1.05, 2.45, 0.06]} color="#c68a4c" />
      <group position={[x0, 0, Z - 0.1]} rotation-y={-1.1}>
        <Box p={[0.52, 1.25, 0]} s={[1.05, 2.45, 0.06]} color="#c68a4c" />
      </group>
      <Box p={[-8.35, 1.1, Z - 0.15]} s={[0.04, 0.2, 0.05]} color="#9aa0a6" />
      {/* room sign and the HackGT "EXIT" posters */}
      <Plane p={[-10.75, 1.45, Z - 0.02]} w={0.5} h={0.34} map={plate.map} basic />
      {[-10.75, -7.5].map((x) => (
        <Plane key={x} p={[x, 1.9, x > -9 ? Z - 0.1 : Z - 0.02]} w={0.5} h={0.38} map={poster} basic />
      ))}
      {/* PLASTIC recycling bin */}
      <Box p={[-11.6, 0.55, Z - 0.3]} s={[0.8, 1.1, 0.55]} color="#4a4540" />
      <Box p={[-11.6, 0.8, Z - 0.58]} s={[0.3, 0.4, 0.01]} color="#f4f4f0" />
        </group>
      </group>
      {/* side corridor off the lobby */}
      <Plane p={[-13.6, 1.6, Z - 0.02]} w={4.2} h={3.2} map={corridor} basic />
      {/* folding tables where people hack in the lobby */}
      {[[-10.6, 22.5], [-6, 24.1]].map(([x, z]) => (
        <group key={x} position={[x, 0, z]}>
          <Box p={[0, 0.74, 0]} s={[3, 0.05, 1.2]} color="#e2c79c" />
          {[[-1.35, -0.5], [1.35, -0.5], [-1.35, 0.5], [1.35, 0.5]].map(([lx, lz], i) => (
            <Box key={i} p={[lx, 0.37, lz]} s={[0.04, 0.74, 0.04]} color="#bfc3c7" />
          ))}
          <Box p={[0.8, 0.8, 0.1]} s={[0.45, 0.03, 0.32]} color="#2b2d33" />
          <mesh position={[-0.9, 0.86, -0.2]}>
            <cylinderGeometry args={[0.04, 0.04, 0.24, 10]} />
            <meshLambertMaterial color="#1a1b1f" />
          </mesh>
        </group>
      ))}
    </group>
  )
}

function ResearchWing() {
  const glass = useMemo(
    () =>
      canvas(128, 256, (g) => {
        const grd = g.createLinearGradient(0, 0, 0, 256)
        grd.addColorStop(0, '#1b2233')
        grd.addColorStop(0.5, '#27407a') // the blue-lit vestibule
        grd.addColorStop(1, '#8c919a')
        g.fillStyle = grd
        g.fillRect(0, 0, 128, 256)
        g.fillStyle = 'rgba(90,120,255,.35)'
        g.fillRect(40, 60, 60, 90)
      }),
    [],
  )
  const exit = useMemo(() => exitSign(), [])
  const kiosk = useMemo(
    () =>
      canvas(200, 480, (g) => {
        g.fillStyle = '#f7f7f5'
        g.fillRect(0, 0, 200, 480)
        g.strokeStyle = '#222'
        g.lineWidth = 4
        g.beginPath()
        g.arc(100, 40, 20, 0, Math.PI * 2)
        g.stroke()
        g.font = '700 26px Georgia'
        g.fillStyle = '#222'
        g.textAlign = 'center'
        g.fillText('i', 100, 49)
        g.fillStyle = '#2d2f33'
        g.fillRect(0, 75, 200, 44)
        g.fillStyle = '#fff'
        g.font = '600 13px Arial'
        g.fillText('You are in the', 100, 92)
        g.font = '700 15px Arial'
        g.fillText('KLAUS RESEARCH WING', 100, 111)
        g.fillStyle = '#444'
        g.font = '500 11px Arial'
        ;['Directions to 1400’s/2400’s', 'KLAUS CLASSROOM WING', 'Exit Building.', 'Turn left, the Classroom Wing', 'will be the next right.'].forEach((t, i) =>
          g.fillText(t, 100, 140 + i * 15),
        )
        // the colourful wing map
        const cols = ['#f08a24', '#e8543f', '#3aa6dd', '#62b845', '#f2c230']
        cols.forEach((c, i) => {
          g.fillStyle = c
          g.beginPath()
          g.ellipse(70 + i * 16, 280 + (i % 2) * 8, 24, 12, -0.4, 0, Math.PI * 2)
          g.fill()
        })
        g.fillStyle = '#444'
        ;['Directions to', 'CCB CLASSROOMS', 'Exit Building.', 'Turn right and take stairs', 'up, the CCB Building will', 'be on your right.'].forEach((t, i) =>
          g.fillText(t, 100, 340 + i * 15),
        )
      }),
    [],
  )
  const tv = useMemo(
    () =>
      canvas(220, 380, (g) => {
        const grd = g.createLinearGradient(0, 0, 0, 380)
        grd.addColorStop(0, '#1b2a6b')
        grd.addColorStop(1, '#3257c9')
        g.fillStyle = grd
        g.fillRect(0, 0, 220, 380)
        g.fillStyle = '#d9d9e8'
        g.fillRect(120, 20, 90, 110) // event photo
        g.fillStyle = '#f08a24'
        g.font = '900 30px Arial'
        g.fillText('AI4OPT', 12, 70)
        g.font = '800 18px Arial'
        g.fillText('SHOWCASE & SOCIAL', 12, 96)
        g.fillStyle = '#ffffff'
        for (let i = 0; i < 5; i++) g.fillRect(12, 112 + i * 12, 100, 5)
        g.fillStyle = '#f2c230'
        g.fillRect(12, 200, 96, 50)
        g.fillRect(114, 200, 96, 50)
        g.fillStyle = '#2b3f9e'
        g.fillRect(12, 262, 96, 60)
        g.fillRect(114, 262, 96, 60)
        g.fillStyle = '#ffffff'
        g.font = '700 10px Arial'
        g.fillText('Georgia Tech Space Week', 16, 214)
        g.fillText('Leading at Tech', 118, 214)
      }),
    [],
  )
  const cx = 10 // centre of the vestibule door
  return (
    <group>
      {/* storefront: sidelights in three rows, a single glass door, transom above */}
      <Plane p={[cx, 1.5, Z - 0.02]} w={3.6} h={3} map={glass} basic />
      {[-1.8, -0.62, 0.62, 1.8].map((dx) => (
        <Box key={dx} p={[cx + dx, 1.5, Z - 0.06]} s={[0.1, 3, 0.1]} color={FRAME} />
      ))}
      {[0.05, 2.4, 3].map((y) => (
        <Box key={y} p={[cx, y, Z - 0.06]} s={[3.7, 0.1, 0.1]} color={FRAME} />
      ))}
      {[-1.21, 1.21].flatMap((dx) =>
        [0.95, 1.7].map((y) => <Box key={`${dx}${y}`} p={[cx + dx, y, Z - 0.06]} s={[1.18, 0.07, 0.08]} color={FRAME} />),
      )}
      <mesh position={[cx, 1.02, Z - 0.14]} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.022, 0.022, 1.0, 8]} />
        <meshLambertMaterial color="#b8bcc2" />
      </mesh>
      <Box p={[cx, 2.28, Z - 0.13]} s={[1.1, 0.14, 0.12]} color="#b6b9bd" />
      <Box p={[cx, 3.45, Z - 0.3]} s={[0.62, 0.05, 0.12]} color="#c9ccd0" />
      <Plane p={[cx, 3.25, Z - 0.3]} w={0.6} h={0.24} map={exit} basic transparent />
      {/* info kiosk, AED cabinet, green plaque */}
      <group position={[6.85, 0, Z - 0.9]} rotation-y={Math.PI + 0.35}>
        <mesh position={[0, 0.05, 0]}>
          <cylinderGeometry args={[0.55, 0.55, 0.06, 24, 1, false, -0.9, 1.8]} />
          <meshLambertMaterial color="#c9ccd0" />
        </mesh>
        <mesh position={[0, 0.95, 0]}>
          <planeGeometry args={[0.72, 1.75]} />
          <meshLambertMaterial map={kiosk} side={THREE.DoubleSide} />
        </mesh>
      </group>
      <Box p={[6.05, 1.35, Z - 0.1]} s={[0.55, 0.62, 0.16]} color="#f4f4f2" />
      <Box p={[6.05, 1.55, Z - 0.19]} s={[0.24, 0.1, 0.01]} color="#d6423a" />
      <Box p={[6.05, 1.28, Z - 0.19]} s={[0.26, 0.26, 0.01]} color="#f2c230" />
      <mesh position={[7.3, 2.05, Z - 0.05]} rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[0.3, 0.3, 0.05, 28]} />
        <meshLambertMaterial color="#5c8f78" />
      </mesh>
      {/* the lobby screen, in its wall niche */}
      <Box p={[13.6, 2.35, Z - 0.03]} s={[1.6, 1.9, 0.04]} color="#e6e3dd" />
      <Box p={[13.5, 2.4, Z - 0.18]} s={[1.18, 1.98, 0.08]} color="#15171c" />
      <Plane p={[13.5, 2.4, Z - 0.23]} w={1.04} h={1.8} map={tv} basic />
      {/* folding table + chair with someone's orange jacket */}
      <group position={[14.6, 0, 26.7]}>
        <Box p={[0.4, 0.74, 0]} s={[1.6, 0.05, 0.9]} color="#e2c79c" />
        {[[-0.35, -0.4], [1.15, -0.4], [-0.35, 0.4], [1.15, 0.4]].map(([lx, lz], i) => (
          <Box key={i} p={[lx, 0.37, lz]} s={[0.04, 0.74, 0.04]} color="#bfc3c7" />
        ))}
        <FoldingChair x={-0.8} z={0.1} rot={Math.PI} />
        <Box p={[-0.8, 0.72, 0.36]} s={[0.5, 0.55, 0.12]} color="#e0662e" />
        <Box p={[-0.65, 0.55, -0.05]} s={[0.3, 0.25, 0.2]} color="#f4f4f2" />
      </group>
    </group>
  )
}

export function Entrance() {
  return (
    <group>
      {/* lobby wall under the mezzanine */}
      <mesh position={[CX, (L1 - 0.5) / 2, Z1]} rotation-y={Math.PI}>
        <planeGeometry args={[X1 - X0, L1 - 0.5]} />
        <meshLambertMaterial color={WALL} />
      </mesh>
      {/* main doors, drawn in south-wall coordinates and turned onto the east wall */}
      <group position={[X1, 0, DOORS_Z]} rotation-y={Math.PI / 2}>
        <group position={[0, 0, -Z1]}>
          <MainDoors />
        </group>
      </group>
      <SeminarRoom />
      <ResearchWing />
    </group>
  )
}
