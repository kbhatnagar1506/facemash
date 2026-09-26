import { useMemo } from 'react'
import * as THREE from 'three'
import { BALCONY, CEIL, COLUMNS, DOORS_Z, HALL, L1, MEZZ_WEST_Z, MEZZ_X0, MEZZ_Z, STAIR, X0, X1, Z0, Z1 } from './layout'
import { Entrance } from './Entrance'
import { ceilingTiles, checkerWall, netTexture, terrazzo, textCard, windowWall } from './textures'

const WHITE = '#f4f2ee'

/** Recessed downlights in the low ceiling under the entrance mezzanine (and its west wing). */
const MEZZ_LIGHTS: [number, number][] = []
for (let x = X0 + 2.5; x < X1; x += 4) for (let z = MEZZ_Z + 2; z < Z1; z += 4) if (x > MEZZ_X0 || z > MEZZ_WEST_Z) MEZZ_LIGHTS.push([x, z])
const BRONZE = '#6f655b'
const HANDRAIL = '#b07a45'

/** Soft radial glow texture for the downlight reflections on the polished floor. */
function glowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grd.addColorStop(0, 'rgba(255,250,235,1)')
  grd.addColorStop(0.25, 'rgba(255,248,230,.45)')
  grd.addColorStop(1, 'rgba(255,248,230,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

function Floor() {
  const map = useMemo(terrazzo, [])
  const glow = useMemo(glowTexture, [])
  // Polished terrazzo: the photos show every downlight mirrored in the floor.
  // A real mirror pass halves the frame rate, so fake it with soft light pools.
  const pools = useMemo(() => {
    const out: [number, number][] = []
    for (let x = X0 + 3; x < X1; x += 4.2) for (let z = Z0 + 3; z < MEZZ_Z; z += 4.4) if (!(x < -13 && z < STAIR.zTop)) out.push([x, z])
    out.push(...MEZZ_LIGHTS)
    return out
  }, [])
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[HALL.w, HALL.d]} />
        <meshStandardMaterial map={map} roughness={0.32} metalness={0} />
      </mesh>
      <instancedMesh
        args={[undefined, undefined, pools.length]}
        ref={(m) => {
          if (!m) return
          const mat = new THREE.Matrix4()
          const rot = new THREE.Matrix4().makeRotationX(-Math.PI / 2)
          pools.forEach(([x, z], i) => m.setMatrixAt(i, mat.makeTranslation(x, 0.015, z).multiply(rot)))
          m.instanceMatrix.needsUpdate = true
        }}
      >
        <planeGeometry args={[1.6, 1.6]} />
        <meshBasicMaterial map={glow} transparent opacity={0.4} depthWrite={false} blending={THREE.AdditiveBlending} />
      </instancedMesh>
    </group>
  )
}

/** A run of railing: bronze perforated panels, slim posts, wooden handrail. */
function Railing({ from, to, y, glass = false }: { from: [number, number]; to: [number, number]; y: number; glass?: boolean }) {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1])
  const ang = -Math.atan2(to[1] - from[1], to[0] - from[0])
  const mid: [number, number, number] = [(from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2]
  const posts = Math.max(1, Math.round(len / 1.8))
  return (
    <group position={mid} rotation-y={ang}>
      <mesh position={[0, 0.55, 0]}>
        <boxGeometry args={[len, 1.0, 0.04]} />
        {glass ? (
          <meshLambertMaterial color="#cfe8e2" transparent opacity={0.28} depthWrite={false} />
        ) : (
          <meshLambertMaterial color={BRONZE} transparent opacity={0.88} />
        )}
      </mesh>
      <mesh position={[0, 1.1, 0]}>
        <boxGeometry args={[len + 0.1, 0.08, 0.16]} />
        <meshLambertMaterial color={glass ? '#b9bec4' : HANDRAIL} />
      </mesh>
      {Array.from({ length: posts + 1 }, (_, i) => (
        <mesh key={i} position={[-len / 2 + (len / posts) * i, 0.55, 0.03]}>
          <boxGeometry args={[0.05, 1.1, 0.05]} />
          <meshLambertMaterial color="#8d9096" />
        </mesh>
      ))}
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
  const back = useMemo(() => checkerWall(12, 8, [1, 3, 4, 6, 8, 9, 11]), [])
  const leftUpper = useMemo(() => checkerWall(14, 5, [2, 5, 8, 11], 9), [])
  const glassR = useMemo(() => windowWall(15), [])
  const h = CEIL
  return (
    <group>
      {/* far (north) wall: full-height checkerboard with windows */}
      <mesh position={[0, h / 2, Z0]}>
        <planeGeometry args={[HALL.w, h]} />
        <meshLambertMaterial map={back} />
      </mesh>
      {/* left wall: white corridor wall at ground/2nd floor, checker panels above */}
      <mesh position={[X0, L1 + (h - L1) / 2, 0]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[HALL.d, h - L1]} />
        <meshLambertMaterial map={leftUpper} />
      </mesh>
      <mesh position={[X0, L1 / 2, 0]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[HALL.d, L1]} />
        <meshLambertMaterial color="#efece6" />
      </mesh>
      {/* wooden doors to the ground-floor hallway (under the balcony) */}
      {[-18, -9, 9].map((z) => (
        <mesh key={z} position={[X0 + 0.02, 1.2, z]} rotation-y={Math.PI / 2}>
          <planeGeometry args={[1.8, 2.4]} />
          <meshLambertMaterial color="#c58e4d" />
        </mesh>
      ))}
      {/* right wall: tall dark windows at ground level, white above */}
      {/* glass wall north of the entrance doors, plain wall around the doorway */}
      <mesh position={[X1, 2.3, (Z0 + DOORS_Z - 4.7) / 2]} rotation-y={-Math.PI / 2}>
        <planeGeometry args={[DOORS_Z - 4.7 - Z0, 4.6]} />
        <meshLambertMaterial map={glassR} />
      </mesh>
      <mesh position={[X1, (L1 - 0.5) / 2, (DOORS_Z - 4.7 + Z1) / 2]} rotation-y={-Math.PI / 2}>
        <planeGeometry args={[Z1 - DOORS_Z + 4.7, L1 - 0.5]} />
        <meshLambertMaterial color="#efece6" />
      </mesh>
      <mesh position={[X1, L1 + (h - L1) / 2, 0]} rotation-y={-Math.PI / 2}>
        <planeGeometry args={[HALL.d, h - L1]} />
        <meshLambertMaterial color="#ecebe7" />
      </mesh>
      {/* entrance (south) wall above the mezzanine; the lobby level is <Entrance /> */}
      <mesh position={[0, L1 + (h - L1) / 2, Z1]} rotation-y={Math.PI}>
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
    for (let x = X0 + 3; x < X1; x += 4.2) for (let z = Z0 + 3; z < MEZZ_Z; z += 4.4) out.push([x, CEIL - 0.02, z])
    for (const [x, z] of MEZZ_LIGHTS) out.push([x, L1 - 0.52, z])
    for (let x = X0 + 2.5; x < -12; x += 3.5) for (let z = Z0 + 2.5; z < STAIR.zTop; z += 4) out.push([x, L1 - 0.52, z])
    return out
  }, [])
  return (
    <group>
      <mesh position={[0, CEIL, 0]} rotation-x={Math.PI / 2}>
        <planeGeometry args={[HALL.w, HALL.d]} />
        <meshLambertMaterial map={tiles} side={THREE.DoubleSide} />
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
      <Slab x0={X0} x1={MEZZ_X0} z0={MEZZ_WEST_Z} z1={Z1} top={L1} thick={0.5} />
      {/* white fascia on the edge facing the atrium */}
      <mesh position={[(BALCONY.left.x1 + X1) / 2, L1 - 0.95, MEZZ_Z - 0.02]}>
        <boxGeometry args={[X1 - BALCONY.left.x1, 1.3, 0.12]} />
        <meshLambertMaterial color={WHITE} />
      </mesh>
      <Railing from={[BALCONY.left.x1, MEZZ_Z]} to={[X1 - 0.3, MEZZ_Z]} y={L1} />
      {/* over the stairwell */}
      <Railing from={[MEZZ_X0, STAIR.zTop]} to={[MEZZ_X0, MEZZ_WEST_Z]} y={L1} />
      <Railing from={[X0 + 0.3, MEZZ_WEST_Z]} to={[MEZZ_X0, MEZZ_WEST_Z]} y={L1} />
    </group>
  )
}

/** The walkable 2nd-floor balcony (left + back-left) with the Klaus lettering under it. */
function LeftBalcony() {
  const { left, back } = BALCONY
  const letters = useMemo(
    () =>
      textCard(
        [
          { text: 'CHRISTOPHER W. KLAUS', font: '600 92px Georgia, "Times New Roman", serif', color: '#9ea3a8' },
          { text: 'ADVANCED COMPUTING BUILDING', font: '600 92px Georgia, "Times New Roman", serif', color: '#9ea3a8' },
        ],
        { w: 2048, h: 360 },
      ),
    [],
  )
  return (
    <group>
      <Slab x0={left.x0} x1={left.x1} z0={left.z0} z1={left.z1} top={L1} />
      <Slab x0={left.x1} x1={back.x1} z0={back.z0} z1={back.z1} top={L1} />
      {/* deeper white fascia band under the front edges */}
      <mesh position={[(left.x1 + back.x1) / 2, L1 - 0.95, back.z1 + 0.02]}>
        <boxGeometry args={[back.x1 - left.x1 + 0.3, 1.3, 0.12]} />
        <meshLambertMaterial color={WHITE} />
      </mesh>
      <mesh position={[-7, L1 - 1.1, back.z1 + 0.1]}>
        <planeGeometry args={[11, 11 / letters.aspect]} />
        <meshBasicMaterial map={letters.map} transparent />
      </mesh>
      <mesh position={[left.x1 + 0.02, L1 - 0.95, (MEZZ_Z + back.z1) / 2]} rotation-y={Math.PI / 2}>
        <boxGeometry args={[MEZZ_Z - back.z1, 1.3, 0.12]} />
        <meshLambertMaterial color={WHITE} />
      </mesh>
      {/* railings along every open edge; gap where the stair lands */}
      <Railing from={[left.x1, back.z1]} to={[left.x1, MEZZ_Z]} y={L1} />
      <Railing from={[left.x1, back.z1]} to={[back.x1, back.z1]} y={L1} />
      <Railing from={[back.x1, back.z1]} to={[back.x1, back.z0 + 0.3]} y={L1} />
      <Railing from={[X0 + 0.3, left.z1]} to={[STAIR.x0, left.z1]} y={L1} />
      <Railing from={[STAIR.x1, left.z1]} to={[MEZZ_X0, left.z1]} y={L1} />
    </group>
  )
}

/** Decorative upper floors: stacked balconies left and right, and the back bridge. */
function UpperFloors() {
  const levels = [9.6, 14.2]
  return (
    <group>
      {levels.map((y) => (
        <group key={y}>
          {/* left upper walkways */}
          <Slab x0={X0} x1={-17} z0={Z0} z1={Z1} top={y} thick={0.6} />
          <Railing from={[-17, Z0 + 0.3]} to={[-17, Z1 - 0.3]} y={y} />
          {/* right stacked balconies */}
          <Slab x0={18.6} x1={X1} z0={Z0} z1={Z1} top={y} thick={0.6} />
          <Railing from={[18.6, Z0 + 0.3]} to={[18.6, Z1 - 0.3]} y={y} />
          <Slab x0={-17} x1={18.6} z0={Z1 - 3} z1={Z1} top={y} thick={0.6} />
          <Railing from={[-17, Z1 - 3]} to={[18.6, Z1 - 3]} y={y} />
        </group>
      ))}
      {/* right 2nd floor too (over the sponsor booths) */}
      <Slab x0={18.6} x1={X1} z0={Z0} z1={MEZZ_Z} top={L1} thick={0.55} />
      <Railing from={[18.6, Z0 + 0.3]} to={[18.6, MEZZ_Z - 0.3]} y={L1} />
      {/* bridge across the back at the 3rd floor (seen from the entrance) */}
      <Slab x0={-17} x1={18.6} z0={Z0} z1={Z0 + 3.2} top={levels[0]} thick={0.6} />
      <Railing from={[-17, Z0 + 3.2]} to={[18.6, Z0 + 3.2]} y={levels[0]} />
      {/* projecting study box on the left upper level (photo 6) */}
      <mesh position={[-13.5, 11.2, -10]} castShadow>
        <boxGeometry args={[7, 2.6, 6]} />
        <meshLambertMaterial color={BRONZE} transparent opacity={0.9} />
      </mesh>
      <mesh position={[-13.5, 12.55, -10]}>
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
        const y = t * L1 + 1.12 - sag * Math.abs(Math.sin(Math.PI * 7 * t + phase))
        pts.push(new THREE.Vector3(x, y, z))
      }
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 400, 0.13, 8, false)
    }
    return [make(x1 + 0.05, 0.55, 0), make(x1 + 0.12, 0.4, 0.8), make(x0 - 0.05, 0.5, 0.4)]
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
          <mesh geometry={netGeo} position={[x, 0, 0]}>
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
      <mesh geometry={netGeo} position={[x1 + 0.08, 0, 0]}>
        <meshBasicMaterial map={net} transparent side={THREE.DoubleSide} depthWrite={false} />
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
