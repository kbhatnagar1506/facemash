import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { DOORS_Z, X1, Z0 } from './layout'

// Light and air in the Klaus atrium: morning sunbeams raking in through the
// east windows, dust drifting through them, and pools of sun on the terrazzo.

/** Soft, spread-out morning light: a wash across the floor and a glow just inside the glass. */
function washTexture(horizontal: boolean) {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 64
  const g = c.getContext('2d')!
  // bright at the window edge (left of the canvas), fading smoothly into the room
  const grd = g.createLinearGradient(0, 0, 256, 0)
  grd.addColorStop(0, 'rgba(255,236,200,0.9)')
  grd.addColorStop(0.35, 'rgba(255,232,192,0.45)')
  grd.addColorStop(1, 'rgba(255,228,185,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 256, 64)
  if (horizontal) {
    // soften the two ends so the wash doesn't stop in a hard line
    g.globalCompositeOperation = 'destination-in'
    const ends = g.createLinearGradient(0, 0, 0, 64)
    ends.addColorStop(0, 'rgba(0,0,0,0)')
    ends.addColorStop(0.12, 'rgba(0,0,0,1)')
    ends.addColorStop(0.88, 'rgba(0,0,0,1)')
    ends.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = ends
    g.fillRect(0, 0, 256, 64)
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function SunWash() {
  const floorTex = useMemo(() => washTexture(true), [])
  const hazeTex = useMemo(() => {
    // vertical haze: brightest low down near the glass, fading upward and at the ends
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 128
    const g = c.getContext('2d')!
    const up = g.createLinearGradient(0, 128, 0, 0)
    up.addColorStop(0, 'rgba(255,238,205,0.8)')
    up.addColorStop(1, 'rgba(255,238,205,0)')
    g.fillStyle = up
    g.fillRect(0, 0, 256, 128)
    g.globalCompositeOperation = 'destination-in'
    const ends = g.createLinearGradient(0, 0, 256, 0)
    ends.addColorStop(0, 'rgba(0,0,0,0)')
    ends.addColorStop(0.1, 'rgba(0,0,0,1)')
    ends.addColorStop(0.9, 'rgba(0,0,0,1)')
    ends.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = ends
    g.fillRect(0, 0, 256, 128)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [])
  const air = useRef<THREE.MeshBasicMaterial>(null!)
  useFrame(({ clock }) => {
    if (air.current) air.current.opacity = 0.2 + 0.05 * Math.sin(clock.elapsedTime * 0.5) // clouds passing
  })
  const z0 = Z0 + 1
  const z1 = DOORS_Z - 5
  const len = z1 - z0
  const depth = 18 // metres the light spreads into the room
  return (
    <group>
      {/* warm wash spreading across the floor from the east windows */}
      <mesh rotation-x={-Math.PI / 2} position={[X1 - depth / 2, 0.02, (z0 + z1) / 2]}>
        <planeGeometry args={[depth, len]} />
        <meshBasicMaterial map={floorTex} transparent opacity={0.55} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
      {/* layered haze just inside the glass: the light spreads and softens into the room */}
      {[0.4, 2.2, 4.6, 7.5].map((d, i) => (
        <mesh key={d} position={[X1 - d, 3, (z0 + z1) / 2]} rotation-y={-Math.PI / 2}>
          <planeGeometry args={[len, 6]} />
          <meshBasicMaterial
            ref={i === 0 ? air : undefined}
            map={hazeTex}
            transparent
            opacity={[0.22, 0.12, 0.08, 0.05][i]}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  )
}

export function Atmosphere() {
  return (
    <group>
      <SunWash />
    </group>
  )
}
