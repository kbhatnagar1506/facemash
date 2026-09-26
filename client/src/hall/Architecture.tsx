import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { BALCONY, CEIL, COLUMNS, CX, CXB, SAG, SLANT, WEST_ZS, XB, ceilY, eastX, wallZ, westX, DOORS_Z, HALL, L1, MEZZ_WEST_Z, MEZZ_X0, MEZZ_Z, STAIR, X0, X1, Z0, Z1 } from './layout'
import { Entrance } from './Entrance'
import { addTerrazzo } from './detail'
import { ceilingTiles, checkerWall, glassPanes, netTexture, terrazzo } from './textures'

const WHITE = '#f4f2ee'

/** z stops along [z0, z1] where the west wall changes direction (for straight runs). */
function westStops(z0: number, z1: number) {
  return [z0, ...WEST_ZS.filter((z) => z > z0 && z < z1), z1]
}

/** A vertical strip following the west wall (optionally offset inward), y0..y1. */
function westStrip(y0: number, y1: number, off = 0, z0 = Z0, z1 = Z1) {
  const zs = westStops(z0, z1)
  const pos: number[] = []
  const uv: number[] = []
  let len = 0
  const total = zs.slice(1).reduce((a, z, i) => a + Math.hypot(z - zs[i], westX(z) - westX(zs[i])), 0)
  for (let i = 0; i < zs.length - 1; i++) {
    const za = zs[i]
    const zb = zs[i + 1]
    const xa = westX(za) + off
    const xb = westX(zb) + off
    const seg = Math.hypot(zb - za, xb - xa)
    const ua = len / total
    const ub = (len + seg) / total
    len += seg
    pos.push(xa, y0, za, xb, y0, zb, xb, y1, zb, xa, y0, za, xb, y1, zb, xa, y1, za)
    uv.push(ua, 0, ub, 0, ub, 1, ua, 0, ub, 1, ua, 1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.computeVertexNormals()
  return g
}

/** A floor slab whose west edge follows the wall; east edge at xEast (fixed x or offset from the wall). */
function WestSlab({ z0, z1, top, thick = 0.5, east, eastOff }: { z0: number; z1: number; top: number; thick?: number; east?: number; eastOff?: number }) {
  const geo = useMemo(() => {
    const zs = westStops(z0, z1)
    const ex = (z: number) => (east !== undefined ? east : westX(z) + (eastOff ?? 3))
    const pts = [...zs.map((z) => new THREE.Vector2(westX(z) - 0.3, -z)), ...[...zs].reverse().map((z) => new THREE.Vector2(ex(z), -z))]
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: thick, bevelEnabled: false })
    g.rotateX(-Math.PI / 2)
    g.translate(0, top - thick, 0)
    return g
  }, [z0, z1, top, thick, east, eastOff])
  return (
    <mesh geometry={geo} castShadow receiveShadow>
      <meshLambertMaterial color={WHITE} />
    </mesh>
  )
}

/** Railing that follows the west wall line at an offset (e.g. the edge of an upper walkway). */
function WestRailing({ off, y, z0 = Z0 + 0.3, z1 = Z1 - 0.3, glass = false }: { off: number; y: number; z0?: number; z1?: number; glass?: boolean }) {
  const zs = westStops(z0, z1)
  return (
    <group>
      {zs.slice(1).map((z, i) => (
        <Railing key={i} from={[westX(zs[i]) + off, zs[i]]} to={[westX(z) + off, z]} y={y} glass={glass} />
      ))}
    </group>
  )
}

/** Recessed downlights in the low ceiling under the entrance mezzanine (and its west wing). */
const MEZZ_LIGHTS: [number, number][] = []
for (let x = X0 + 2.5; x < X1; x += 4) for (let z = MEZZ_Z + 2; z < Z1; z += 4) if ((x > MEZZ_X0 || z > MEZZ_WEST_Z) && x > westX(z) + 1) MEZZ_LIGHTS.push([x, z])
const BRONZE = '#6f655b'
const HANDRAIL = '#b07a45'

function Floor() {
  const map = useMemo(terrazzo, [])
  return (
    <mesh rotation-x={-Math.PI / 2} position={[CXB, 0, 0]} receiveShadow>
      <planeGeometry args={[XB - X0, HALL.d]} />
      <meshStandardMaterial map={map} roughness={0.22} metalness={0} onUpdate={addTerrazzo} />
    </mesh>
  )
}

/** A run of railing: bronze perforated panels, slim posts, wooden handrail. */
function Railing({ from, to, y, glass = false }: { from: [number, number]; to: [number, number]; y: number; glass?: boolean }) {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1])
  const ang = -Math.atan2(to[1] - from[1], to[0] - from[0])
  const mid: [number, number, number] = [(from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2]
  const posts = Math.max(1, Math.round(len / 1.8))
  // Klaus balustrade (photo): tall bays in dark metal frames, each with two stacked
  // panes: a smoked mesh pane below the mid rail and clearer glass above, wooden cap rail.
  void glass
  void posts
  const bays = Math.max(1, Math.round(len / 1.6))
  const bw = len / bays
  const H = 1.75
  return (
    <group position={mid} rotation-y={ang}>
      <mesh position={[0, 0.47, 0]} renderOrder={2}>
        <boxGeometry args={[len, 0.8, 0.02]} />
        <meshStandardMaterial color="#6f6a61" roughness={0.35} metalness={0.4} transparent opacity={0.78} depthWrite={false} />
      </mesh>
      <mesh position={[0, 1.3, 0]} renderOrder={2}>
        <boxGeometry args={[len, 0.78, 0.02]} />
        <meshStandardMaterial color="#a9b8b6" roughness={0.05} metalness={0.3} transparent opacity={0.32} depthWrite={false} />
      </mesh>
      <mesh position={[0, 1.36, 0.013]} renderOrder={3}>
        <planeGeometry args={[len, 0.2]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.08} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {/* frame: base, mid rail, top rail, and a mullion at every bay */}
      {[0.05, 0.89, H - 0.04].map((y) => (
        <mesh key={y} position={[0, y, 0]}>
          <boxGeometry args={[len, 0.06, 0.05]} />
          <meshLambertMaterial color="#4a4a4c" />
        </mesh>
      ))}
      {Array.from({ length: bays + 1 }, (_, i) => (
        <mesh key={i} position={[-len / 2 + bw * i, H / 2, 0]}>
          <boxGeometry args={[0.05, H, 0.05]} />
          <meshLambertMaterial color="#4a4a4c" />
        </mesh>
      ))}
      <mesh position={[0, H + 0.03, 0]}>
        <boxGeometry args={[len + 0.1, 0.07, 0.13]} />
        <meshLambertMaterial color={HANDRAIL} />
      </mesh>
    </group>
  )
}

/** A floor slab with a white fascia; `top` is the walking surface height. */
function Slab({ x0, x1, z0, z1, top, thick = 0.5 }: { x0: number; x1: number; z0: number; z1: number; top: number; thick?: number }) {
  return (
    <mesh position={[(x0 + x1) / 2, top - thick / 2, (z0 + z1) / 2]} castShadow receiveShadow>
      <boxGeometry args={[x1 - x0, thick, z1 - z0]} />
      <meshLambertMaterial color={WHITE} />
    </mesh>
  )
}

function Walls() {
  const back = useMemo(() => checkerWall(18, 11, [2, 3, 6, 7, 10, 11, 14, 15]), [])
  const leftUpper = useMemo(() => checkerWall(24, 7, [3, 4, 9, 10, 15, 16, 21], 9), [])
  const slantLen = Math.hypot(XB - X1, MEZZ_Z - Z0)
  const glassR = useMemo(() => glassPanes(12), [])
  const glassFront = useMemo(() => glassPanes(6), [])
  const h = CEIL
  const westUpper = useMemo(() => westStrip(L1, h), [h])
  const westLower = useMemo(() => westStrip(0, L1), [])
  const curvedWall = useMemo(() => {
    const g = new THREE.PlaneGeometry(XB - X0, h, 48, 1)
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + CXB
      p.setXYZ(i, x, p.getY(i) + h / 2, wallZ(x))
    }
    g.computeVertexNormals()
    return g
  }, [h])
  return (
    <group>
      {/* far (north) wall: full-height checkerboard with windows */}
      <mesh geometry={curvedWall}>
        <meshLambertMaterial map={back} />
      </mesh>
      {/* floor and ceiling carry on into the curve */}
      <mesh rotation-x={-Math.PI / 2} position={[CXB, 0.001, Z0 - SAG / 2]}>
        <planeGeometry args={[XB - X0, SAG]} />
        <meshStandardMaterial color="#e3dfd6" roughness={0.35} />
      </mesh>
      <mesh rotation-x={Math.PI / 2} position={[CXB, h, Z0 - SAG / 2]}>
        <planeGeometry args={[XB - X0, SAG]} />
        <meshLambertMaterial color="#efece6" side={THREE.DoubleSide} />
      </mesh>
      {/* left wall: white corridor wall at ground/2nd floor, checker panels above */}
      {/* west wall: follows the line walked on site (angles in toward the entrance) */}
      <mesh geometry={westUpper}>
        <meshLambertMaterial map={leftUpper} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={westLower}>
        <meshLambertMaterial color="#efece6" side={THREE.DoubleSide} />
      </mesh>
      {/* right wall: tall dark windows at ground level, white above */}
      {/* glass wall north of the entrance doors, plain wall around the doorway */}
      {/* the glass: straight through the lobby end, then splayed outward to the back */}
      <mesh position={[X1, 2.3, (MEZZ_Z + DOORS_Z - 4.7) / 2]} rotation-y={-Math.PI / 2}>
        <planeGeometry args={[DOORS_Z - 4.7 - MEZZ_Z, 4.6]} />
        <meshStandardMaterial map={glassFront} roughness={0.15} metalness={0.1} />
      </mesh>
      <mesh position={[(X1 + XB) / 2, 2.3, (MEZZ_Z + Z0) / 2]} rotation-y={-Math.PI / 2 - SLANT}>
        <planeGeometry args={[slantLen, 4.6]} />
        <meshStandardMaterial map={glassR} roughness={0.15} metalness={0.1} />
      </mesh>
      <mesh position={[X1, (L1 - 0.5) / 2, (DOORS_Z - 4.7 + Z1) / 2]} rotation-y={-Math.PI / 2}>
        <planeGeometry args={[Z1 - DOORS_Z + 4.7, L1 - 0.5]} />
        <meshLambertMaterial color="#efece6" />
      </mesh>
      <mesh position={[X1, L1 + (h - L1) / 2, (MEZZ_Z + Z1) / 2]} rotation-y={-Math.PI / 2}>
        <planeGeometry args={[Z1 - MEZZ_Z, h - L1]} />
        <meshLambertMaterial color="#ecebe7" />
      </mesh>
      <mesh position={[(X1 + XB) / 2, L1 + (h - L1) / 2, (MEZZ_Z + Z0) / 2]} rotation-y={-Math.PI / 2 - SLANT}>
        <planeGeometry args={[slantLen, h - L1]} />
        <meshLambertMaterial color="#ecebe7" />
      </mesh>
      {/* the strip between the glass and the 2nd floor along the splayed wall */}
      <mesh position={[(X1 + XB) / 2, (4.6 + L1) / 2, (MEZZ_Z + Z0) / 2]} rotation-y={-Math.PI / 2 - SLANT}>
        <planeGeometry args={[slantLen, L1 - 4.6 + 0.02]} />
        <meshLambertMaterial color="#ecebe7" />
      </mesh>
      {/* entrance (south) wall above the mezzanine; the lobby level is <Entrance /> */}
      <mesh position={[CX, L1 + (h - L1) / 2, Z1]} rotation-y={Math.PI}>
        <planeGeometry args={[HALL.w, h - L1]} />
        <meshLambertMaterial color="#efece6" />
      </mesh>
    </group>
  )
}

function Ceiling() {
  const tiles = useMemo(() => ceilingTiles(HALL.w, HALL.d), [])
  const mezzTiles = useMemo(() => ceilingTiles(X1 - MEZZ_X0, Z1 - MEZZ_Z), [])
  const westTiles = useMemo(() => ceilingTiles(MEZZ_X0 - X0, Z1 - MEZZ_WEST_Z), [])
  // Grid of recessed downlights (the atrium photos show dozens).
  const lights = useMemo(() => {
    const out: [number, number, number][] = []
    for (let x = X0 + 3; x < XB; x += 4.2) for (let z = Z0 + 3; z < MEZZ_Z; z += 4.4) if (x < eastX(z) - 1.5) out.push([x, ceilY(z) - 0.05, z])
    for (const [x, z] of MEZZ_LIGHTS) out.push([x, L1 - 0.52, z])
    for (let x = X0 + 2.5; x < BALCONY.left.x1 + 1; x += 3.5) for (let z = Z0 + 2.5; z < STAIR.zTop; z += 4) if (x > westX(z) + 1) out.push([x, L1 - 0.52, z])
    return out
  }, [])
  const slopedCeiling = useMemo(() => {
    const g = new THREE.PlaneGeometry(XB - X0, HALL.d, 1, 8)
    g.rotateX(Math.PI / 2)
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + CXB
      const z = p.getZ(i)
      p.setXYZ(i, x, ceilY(z), z)
    }
    g.computeVertexNormals()
    return g
  }, [])
  const crease = useMemo(() => {
    // a slim soffit strip running diagonally across the ceiling (as in the photos)
    const A = [X0 + 2, Z0 + 26] as const
    const B = [XB - 2, Z0 + 6] as const
    const pos: number[] = []
    const N = 20
    const w = 0.35
    for (let i = 0; i < N; i++) {
      const t0 = i / N
      const t1 = (i + 1) / N
      const pt = (t: number, side: number) => {
        const x = A[0] + (B[0] - A[0]) * t
        const z = A[1] + (B[1] - A[1]) * t + side * w
        return [x, ceilY(z) - 0.06, z]
      }
      pos.push(...pt(t0, -1), ...pt(t1, -1), ...pt(t1, 1), ...pt(t0, -1), ...pt(t1, 1), ...pt(t0, 1))
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.computeVertexNormals()
    return g
  }, [])
  const cove = useMemo(() => {
    // quarter-round cove where the ceiling curves down into the top of the back wall
    const pos: number[] = []
    const R = 1.8
    const segX = 40
    const segA = 6
    for (let i = 0; i < segX; i++)
      for (let j = 0; j < segA; j++) {
        const pt = (ii: number, jj: number) => {
          const x = X0 + ((XB - X0) * ii) / segX
          const a = (jj / segA) * (Math.PI / 2)
          return [x, CEIL - R + Math.sin(a) * R, wallZ(x) + (1 - Math.cos(a)) * R]
        }
        pos.push(...pt(i, j), ...pt(i + 1, j), ...pt(i + 1, j + 1), ...pt(i, j), ...pt(i + 1, j + 1), ...pt(i, j + 1))
      }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.computeVertexNormals()
    return g
  }, [])
  // Camera-style starbursts on the high atrium downlights (like the photos).
  const star = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const g = c.getContext('2d')!
    const glow = g.createRadialGradient(64, 64, 0, 64, 64, 64)
    glow.addColorStop(0, 'rgba(255,252,240,1)')
    glow.addColorStop(0.12, 'rgba(255,248,225,.6)')
    glow.addColorStop(1, 'rgba(255,248,225,0)')
    g.fillStyle = glow
    g.fillRect(0, 0, 128, 128)
    g.globalCompositeOperation = 'lighter'
    for (let k = 0; k < 6; k++) {
      g.save()
      g.translate(64, 64)
      g.rotate((k * Math.PI) / 6)
      const ray = g.createLinearGradient(-64, 0, 64, 0)
      ray.addColorStop(0, 'rgba(255,250,235,0)')
      ray.addColorStop(0.5, `rgba(255,250,235,${k % 3 === 0 ? 0.7 : 0.3})`)
      ray.addColorStop(1, 'rgba(255,250,235,0)')
      g.fillStyle = ray
      g.fillRect(-64, -1, 128, 2)
      g.restore()
    }
    return new THREE.CanvasTexture(c)
  }, [])
  const starGeo = useMemo(() => {
    const hi = lights.filter((l) => l[1] > L1 + 2).map((l) => [l[0], l[1] - 0.1, l[2]]).flat()
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(hi, 3))
    return g
  }, [lights])
  const starMat = useRef<THREE.PointsMaterial>(null!)
  useFrame(({ clock }) => {
    if (starMat.current) starMat.current.size = 2.2 + Math.sin(clock.elapsedTime * 1.3) * 0.15 // gentle shimmer
  })
  return (
    <group>
      <points geometry={starGeo}>
        <pointsMaterial ref={starMat} map={star} size={2.2} sizeAttenuation transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </points>
      {/* sloped ceiling, a diagonal crease across it, and a curved cove into the back wall */}
      <mesh geometry={slopedCeiling}>
        <meshLambertMaterial map={tiles} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={crease}>
        <meshLambertMaterial color="#d9d4ca" side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={cove}>
        <meshLambertMaterial color="#f0ede7" side={THREE.DoubleSide} />
      </mesh>
      {/* low ceiling under the entrance mezzanine, with linear air diffusers */}
      <mesh position={[(MEZZ_X0 + X1) / 2, L1 - 0.51, (MEZZ_Z + Z1) / 2]} rotation-x={Math.PI / 2}>
        <planeGeometry args={[X1 - MEZZ_X0, Z1 - MEZZ_Z]} />
        <meshLambertMaterial map={mezzTiles} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[(X0 + MEZZ_X0) / 2, L1 - 0.51, (MEZZ_WEST_Z + Z1) / 2]} rotation-x={Math.PI / 2}>
        <planeGeometry args={[MEZZ_X0 - X0, Z1 - MEZZ_WEST_Z]} />
        <meshLambertMaterial map={westTiles} side={THREE.DoubleSide} />
      </mesh>
      {[-8, 0, 8, 15].flatMap((x) =>
        [8, 16, 24].map((z) => (
          <mesh key={`${x}${z}`} position={[x, L1 - 0.53, z]} rotation-x={Math.PI / 2}>
            <planeGeometry args={[0.35, 2.4]} />
            <meshBasicMaterial color="#3a3d42" side={THREE.DoubleSide} />
          </mesh>
        )),
      )}
      <instancedMesh
        args={[undefined, undefined, lights.length]}
        ref={(m) => {
          if (!m) return
          const mat = new THREE.Matrix4()
          const rot = new THREE.Matrix4().makeRotationX(Math.PI / 2)
          lights.forEach(([x, y, z], i) => m.setMatrixAt(i, mat.makeTranslation(x, y, z).multiply(rot)))
          m.instanceMatrix.needsUpdate = true
        }}
      >
        <circleGeometry args={[0.28, 16]} />
        <meshBasicMaterial color="#fffbe6" side={THREE.DoubleSide} />
      </instancedMesh>
    </group>
  )
}

/** The raised entrance mezzanine: walkable, reaches out over the hacking floor to the Table 7 row. */
function Mezzanine() {
  return (
    <group>
      <Slab x0={MEZZ_X0} x1={X1} z0={MEZZ_Z} z1={Z1} top={L1} thick={0.5} />
      <WestSlab z0={MEZZ_WEST_Z} z1={Z1} top={L1} thick={0.5} east={MEZZ_X0} />
      {/* white fascia on the edge facing the atrium */}
      <mesh position={[(BALCONY.left.x1 + X1) / 2, L1 - 0.95, MEZZ_Z - 0.02]}>
        <boxGeometry args={[X1 - BALCONY.left.x1, 1.3, 0.12]} />
        <meshLambertMaterial color={WHITE} />
      </mesh>
      <Railing from={[BALCONY.left.x1, MEZZ_Z]} to={[X1 - 0.3, MEZZ_Z]} y={L1} />
      {/* over the stairwell */}
      <Railing from={[MEZZ_X0, STAIR.zTop]} to={[MEZZ_X0, MEZZ_WEST_Z]} y={L1} />
      <Railing from={[westX(MEZZ_WEST_Z) + 0.3, MEZZ_WEST_Z]} to={[MEZZ_X0, MEZZ_WEST_Z]} y={L1} />
    </group>
  )
}

/** The walkable 2nd-floor balcony (left + back-left) with the Klaus lettering under it. */
function LeftBalcony() {
  const { left, back } = BALCONY
  const letters = useMemo(() => {
    // brushed-steel serif letters standing off the fascia: a crisp dark cast shadow,
    // a steel face with a top-lit gradient, and a thin bright edge so it reads from afar
    const W = 2048
    const H = 400
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const g = c.getContext('2d')!
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const lines: [string, number, number][] = [
      ['CHRISTOPHER W. KLAUS', 116, 130],
      ['ADVANCED COMPUTING BUILDING', 96, 280],
    ]
    for (const [text, size, y] of lines) {
      g.font = `700 ${size}px Georgia, "Times New Roman", serif`
      g.fillStyle = 'rgba(40,44,50,0.55)'
      g.fillText(text, W / 2 + 7, y + 9)
      const grd = g.createLinearGradient(0, y - size / 2, 0, y + size / 2)
      grd.addColorStop(0, '#9aa1a9')
      grd.addColorStop(0.5, '#5f666e')
      grd.addColorStop(1, '#474d54')
      g.fillStyle = grd
      g.fillText(text, W / 2, y)
      g.lineWidth = 2
      g.strokeStyle = 'rgba(235,238,242,0.7)'
      g.strokeText(text, W / 2 - 1, y - 1)
    }
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 16
    return { map: t, aspect: W / H }
  }, [])
  return (
    <group>
      <WestSlab z0={left.z0} z1={left.z1} top={L1} east={left.x1} />
      <Slab x0={left.x1} x1={back.x1} z0={back.z0} z1={back.z1} top={L1} />
      {/* deeper white fascia band under the front edges */}
      <mesh position={[(left.x1 + back.x1) / 2, L1 - 0.95, back.z1 + 0.02]}>
        <boxGeometry args={[back.x1 - left.x1 + 0.3, 1.3, 0.12]} />
        <meshLambertMaterial color={WHITE} />
      </mesh>
      {/* the Klaus lettering on the balcony's front edge, facing into the atrium */}
      {/* between the columns (z = -5 and the back), so nothing stands in front of it */}
      <mesh position={[left.x1 + 0.1, L1 - 1.05, -9.6]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[8.2, 8.2 / letters.aspect]} />
        <meshBasicMaterial map={letters.map} transparent toneMapped={false} />
      </mesh>
      <mesh position={[left.x1 + 0.02, L1 - 0.95, (MEZZ_Z + back.z1) / 2]} rotation-y={Math.PI / 2}>
        <boxGeometry args={[MEZZ_Z - back.z1, 1.3, 0.12]} />
        <meshLambertMaterial color={WHITE} />
      </mesh>
      {/* railings along every open edge; gap where the stair lands */}
      <Railing from={[left.x1, back.z1]} to={[left.x1, MEZZ_Z]} y={L1} />
      <Railing from={[left.x1, back.z1]} to={[back.x1, back.z1]} y={L1} />
      <Railing from={[back.x1, back.z1]} to={[back.x1, back.z0 + 0.3]} y={L1} />
      <Railing from={[westX(left.z1) + 0.3, left.z1]} to={[STAIR.x0, left.z1]} y={L1} />
      <Railing from={[STAIR.x1, left.z1]} to={[MEZZ_X0, left.z1]} y={L1} />
    </group>
  )
}

/** Decorative upper floors: stacked balconies left and right, and the back bridge. */
/** East-side floor slab over the splayed part of the wall (z from the back wall to the mezzanine edge). */
function SlantSlab({ top, thick }: { top: number; thick: number }) {
  const geo = useMemo(() => {
    const sh = new THREE.Shape([
      new THREE.Vector2(X1 - 3.4, -MEZZ_Z),
      new THREE.Vector2(X1, -MEZZ_Z),
      new THREE.Vector2(XB, -Z0),
      new THREE.Vector2(XB - 3.4, -Z0),
    ])
    const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false })
    g.rotateX(-Math.PI / 2)
    g.translate(0, top - thick, 0)
    return g
  }, [top, thick])
  return (
    <mesh geometry={geo} castShadow receiveShadow>
      <meshLambertMaterial color={WHITE} />
    </mesh>
  )
}

function UpperFloors() {
  const levels = [9.6, 14.2]
  return (
    <group>
      {levels.map((y) => (
        <group key={y}>
          {/* left upper walkways */}
          {y === levels[0] ? (
            <>
              {/* opening where the upper stair comes up */}
              <WestSlab z0={Z0} z1={-9} top={y} thick={0.6} eastOff={4} />
              <WestSlab z0={2.5} z1={Z1} top={y} thick={0.6} eastOff={4} />
            </>
          ) : (
            <WestSlab z0={Z0} z1={Z1} top={y} thick={0.6} eastOff={4} />
          )}
          <WestRailing off={4} y={y} glass />
          {/* right stacked balconies (following the splayed east wall at the back) */}
          <Slab x0={(X1 - 3.4)} x1={X1} z0={MEZZ_Z} z1={Z1} top={y} thick={0.6} />
          <SlantSlab top={y} thick={0.6} />
          <Railing from={[(X1 - 3.4), MEZZ_Z]} to={[(X1 - 3.4), Z1 - 0.3]} y={y} glass />
          <Railing from={[(XB - 3.4), Z0 + 0.3]} to={[(X1 - 3.4), MEZZ_Z]} y={y} glass />
          <Slab x0={westX(Z1 - 1.5) + 4} x1={(X1 - 3.4)} z0={Z1 - 3} z1={Z1} top={y} thick={0.6} />
          <Railing from={[westX(Z1 - 3) + 4, Z1 - 3]} to={[(X1 - 3.4), Z1 - 3]} y={y} glass />
        </group>
      ))}
      <UpperStair />
      {/* right 2nd floor too (over the sponsor booths) */}
      <SlantSlab top={L1} thick={0.55} />
      <Railing from={[(XB - 3.4), Z0 + 0.3]} to={[(X1 - 3.4), MEZZ_Z - 0.3]} y={L1} />
      {/* bridge across the back at the 3rd floor (seen from the entrance) */}
      <Slab x0={westX(Z0 + 1.6) + 4} x1={(XB - 3.4)} z0={Z0} z1={Z0 + 3.2} top={levels[0]} thick={0.6} />
      <Railing from={[westX(Z0 + 3.2) + 4, Z0 + 3.2]} to={[(XB - 3.4), Z0 + 3.2]} y={levels[0]} glass />
      {/* projecting study box on the left upper level (photo 6) */}
      <mesh position={[westX(-10) + 4.2, 11.2, -10]} castShadow>
        <boxGeometry args={[7, 2.6, 6]} />
        <meshLambertMaterial color={BRONZE} transparent opacity={0.9} />
      </mesh>
      <mesh position={[westX(-10) + 4.2, 12.55, -10]}>
        <boxGeometry args={[7.1, 0.1, 6.1]} />
        <meshLambertMaterial color={HANDRAIL} />
      </mesh>
    </group>
  )
}

function Columns() {
  return (
    <group>
      {COLUMNS.map(([x, z, r, h], i) => (
        <mesh key={i} position={[x, h / 2, z]} castShadow receiveShadow>
          <cylinderGeometry args={[r, r, h, 20]} />
          <meshLambertMaterial color={WHITE} />
        </mesh>
      ))}
    </group>
  )
}

/** The glass-railed staircase on the left as you walk in, with garlands and a net. */
/** The second glass stair: from the 2nd-floor balcony up to the 3rd floor (top left in the photos). */
function UpperStair() {
  // runs up along the west wall from the 2nd-floor balcony (z = 2.5) to the 3rd floor (z = -9)
  const zB = 2.5
  const zT = -9
  const x0 = westX(zB) + 0.5
  const ang = Math.atan((westX(zB) - westX(zT)) / (zB - zT)) // follow the wall's angle
  const w = 2.2
  const L = Math.hypot(zB - zT, westX(zB) - westX(zT))
  const steps = 22
  const rise = (9.6 - L1) / steps
  const run = L / steps
  const slope = Math.atan2(9.6 - L1, L)
  const len = Math.hypot(L, 9.6 - L1)
  return (
    <group position={[x0, 0, zB]} rotation-y={ang}>
      {Array.from({ length: steps }, (_, i) => (
        <mesh key={i} position={[w / 2, L1 + rise * (i + 0.5), -run * (i + 0.5)]} castShadow>
          <boxGeometry args={[w, 0.06, run * 0.92]} />
          <meshLambertMaterial color="#dce6e3" transparent opacity={0.9} />
        </mesh>
      ))}
      <mesh position={[w, L1 + (9.6 - L1) / 2 - 0.3, -L / 2]} rotation-x={slope}>
        <boxGeometry args={[0.12, 0.45, len]} />
        <meshLambertMaterial color={WHITE} />
      </mesh>
      <mesh position={[w + 0.05, L1 + (9.6 - L1) / 2 + 0.55, -L / 2]} rotation-x={slope}>
        <boxGeometry args={[0.02, 1.0, len]} />
        <meshLambertMaterial color="#cfe8e2" transparent opacity={0.3} depthWrite={false} />
      </mesh>
      <mesh position={[w + 0.05, L1 + (9.6 - L1) / 2 + 1.08, -L / 2]} rotation-x={slope}>
        <boxGeometry args={[0.06, 0.06, len]} />
        <meshLambertMaterial color="#b9bec4" />
      </mesh>
    </group>
  )
}

function Stair() {
  const { x0, x1, zBottom, zTop, steps } = STAIR
  const run = (zBottom - zTop) / steps
  const rise = L1 / steps
  const w = x1 - x0
  const net = useMemo(() => {
    const t = netTexture()
    t.repeat.set(6, 1.2)
    return t
  }, [])
  // Parallelogram following the stair slope, for the net/stringer panels.
  const slopePanel = (lo: number, hi: number) => {
    const g = new THREE.BufferGeometry()
    const v = new Float32Array([
      0, lo, zBottom, 0, hi, zBottom, 0, L1 + hi, zTop,
      0, lo, zBottom, 0, L1 + hi, zTop, 0, L1 + lo, zTop,
    ])
    g.setAttribute('position', new THREE.BufferAttribute(v, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]), 2))
    g.computeVertexNormals()
    return g
  }
  const stringer = useMemo(() => slopePanel(-0.7, 0.05), [])
  const netGeo = useMemo(() => slopePanel(-0.6, 1.05), [])
  // Scalloped paper garlands swagging between the rail posts.
  const garlands = useMemo(() => {
    const make = (x: number, sag: number, phase: number) => {
      const pts: THREE.Vector3[] = []
      const N = 160
      for (let i = 0; i <= N; i++) {
        const t = i / N
        const z = zBottom - t * (zBottom - zTop)
        const y = t * L1 + 1.05 - sag * Math.abs(Math.sin(Math.PI * 7 * t + phase))
        pts.push(new THREE.Vector3(x, y, z))
      }
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 400, 0.11, 8, false)
    }
    // hung clear of the glass, the net and each other so nothing interpenetrates
    return [make(x1 + 0.34, 0.55, 0), make(x1 + 0.62, 0.4, 0.8), make(x0 - 0.3, 0.5, 0.4)]
  }, [x0, x1, zBottom, zTop])
  return (
    <group>
      {Array.from({ length: steps }, (_, i) => (
        <mesh key={i} position={[(x0 + x1) / 2, rise * (i + 0.5), zBottom - run * (i + 0.5)]} castShadow receiveShadow>
          <boxGeometry args={[w, rise, run]} />
          <meshLambertMaterial color={i % 2 ? '#dfe7e4' : '#d4dedb'} />
        </mesh>
      ))}
      {/* white stringers under both sides */}
      {[x0, x1].map((x) => (
        <mesh key={x} geometry={stringer} position={[x, 0, 0]}>
          <meshLambertMaterial color={WHITE} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {/* glass balustrades + steel handrails */}
      {[x0, x1].map((x) => (
        <group key={`r${x}`}>
          <mesh geometry={netGeo} position={[x, 0, 0]} renderOrder={1}>
            <meshLambertMaterial color="#cfe8e2" transparent opacity={0.25} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          <mesh
            position={[x, L1 / 2 + 1.1, (zBottom + zTop) / 2]}
            rotation-x={Math.atan2(L1, zBottom - zTop)}
          >
            <boxGeometry args={[0.06, 0.06, Math.hypot(L1, zBottom - zTop)]} />
            <meshLambertMaterial color="#b9bec4" />
          </mesh>
        </group>
      ))}
      {/* the fishing net draped over the room side */}
      <mesh geometry={netGeo} position={[x1 + 0.14, 0, 0]}>
        <meshBasicMaterial map={net} alphaTest={0.35} side={THREE.DoubleSide} />
      </mesh>
      {garlands.map((g, i) => (
        <mesh key={i} geometry={g}>
          <meshToonMaterial color={['#5fd07a', '#2e9e57', '#8ee29a'][i]} />
        </mesh>
      ))}
    </group>
  )
}

export function Architecture() {
  return (
    <group>
      <Floor />
      <Walls />
      <Ceiling />
      <Mezzanine />
      <LeftBalcony />
      <UpperFloors />
      <Columns />
      <Stair />
      <Entrance />
    </group>
  )
}
