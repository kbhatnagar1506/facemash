import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { CEIL, DOORS_Z, X0, X1, Z0, Z1 } from './layout'

// Light and air in the Klaus atrium: morning sunbeams raking in through the
// east windows, dust drifting through them, and pools of sun on the terrazzo.

function beamTexture() {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 256
  const g = c.getContext('2d')!
  // bright at the window, fading out along the beam; soft at both edges
  const along = g.createLinearGradient(0, 0, 0, 256)
  along.addColorStop(0, 'rgba(255,236,196,0.9)')
  along.addColorStop(0.55, 'rgba(255,228,180,0.35)')
  along.addColorStop(1, 'rgba(255,220,170,0)')
  g.fillStyle = along
  g.fillRect(0, 0, 64, 256)
  g.globalCompositeOperation = 'destination-in'
  const across = g.createLinearGradient(0, 0, 64, 0)
  across.addColorStop(0, 'rgba(0,0,0,0)')
  across.addColorStop(0.5, 'rgba(0,0,0,1)')
  across.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = across
  g.fillRect(0, 0, 64, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.flipY = false // bright end at the window
  return t
}

function poolTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grd.addColorStop(0, 'rgba(255,232,190,0.85)')
  grd.addColorStop(0.6, 'rgba(255,228,180,0.3)')
  grd.addColorStop(1, 'rgba(255,228,180,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(c)
}

/** Beams start at the east windows (x = X1) and slope down westward into the room. */
const BEAMS = [-22, -16, -9.5, -3, 3.5, 10].filter((z) => Math.abs(z - DOORS_Z) > 4)

function Sunbeams() {
  const tex = useMemo(beamTexture, [])
  const pool = useMemo(poolTexture, [])
  const mats = useRef<THREE.MeshBasicMaterial[]>([])
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    mats.current.forEach((m, i) => {
      if (m) m.opacity = 0.22 + 0.07 * Math.sin(t * 0.6 + i * 1.7) // clouds drifting past the sun
    })
  })
  const len = 16
  const drop = 4.2 // metres the beam falls over its length
  const tilt = Math.atan2(drop, len)
  return (
    <group>
      {BEAMS.map((z, i) => (
        <group key={z}>
          {/* two crossed planes around the beam's own axis so it reads from any angle */}
          <group position={[X1 - len / 2, 4.2 - drop / 2, z]} rotation-z={Math.PI / 2 + tilt}>
            {[0, Math.PI / 2].map((roll) => (
              <mesh key={roll} rotation-y={roll}>
                <planeGeometry args={[2.4, Math.hypot(len, drop)]} />
                <meshBasicMaterial
                  ref={(m) => { if (m) mats.current[i * 2 + (roll ? 1 : 0)] = m }}
                  map={tex}
                  transparent
                  opacity={0.25}
                  depthWrite={false}
                  blending={THREE.AdditiveBlending}
                  side={THREE.DoubleSide}
                  toneMapped={false}
                />
              </mesh>
            ))}
          </group>
          {/* where it lands on the floor */}
          <mesh rotation-x={-Math.PI / 2} position={[X1 - len + 1, 0.02, z]}>
            <planeGeometry args={[7, 3.2]} />
            <meshBasicMaterial map={pool} transparent opacity={0.55} depthWrite={false} blending={THREE.AdditiveBlending} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/** Dust motes floating through the atrium, drifting slowly and twinkling in the light. */
function Dust({ count = 900 }: { count?: number }) {
  const pts = useRef<THREE.Points>(null!)
  const { geo, seeds } = useMemo(() => {
    const pos = new Float32Array(count * 3)
    const seeds = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      pos[i * 3] = X0 + Math.random() * (X1 - X0)
      pos[i * 3 + 1] = 0.5 + Math.random() * (CEIL - 3)
      pos[i * 3 + 2] = Z0 + Math.random() * (Z1 - Z0)
      seeds[i] = Math.random() * 100
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    return { geo, seeds }
  }, [count])
  const sprite = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = c.height = 32
    const g = c.getContext('2d')!
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16)
    grd.addColorStop(0, 'rgba(255,248,225,1)')
    grd.addColorStop(1, 'rgba(255,248,225,0)')
    g.fillStyle = grd
    g.fillRect(0, 0, 32, 32)
    return new THREE.CanvasTexture(c)
  }, [])
  useFrame((_, dt) => {
    const p = geo.getAttribute('position') as THREE.BufferAttribute
    const a = p.array as Float32Array
    const t = performance.now() / 1000
    for (let i = 0; i < count; i++) {
      const s = seeds[i]
      a[i * 3] += Math.sin(t * 0.3 + s) * 0.08 * dt
      a[i * 3 + 1] += (Math.sin(t * 0.5 + s * 2) * 0.05 + 0.02) * dt
      a[i * 3 + 2] += Math.cos(t * 0.25 + s) * 0.08 * dt
      if (a[i * 3 + 1] > CEIL - 2) a[i * 3 + 1] = 0.5
    }
    p.needsUpdate = true
  })
  return (
    <points ref={pts} geometry={geo}>
      <pointsMaterial
        map={sprite}
        size={0.09}
        sizeAttenuation
        transparent
        opacity={0.8}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        color="#fff2d6"
        toneMapped={false}
      />
    </points>
  )
}

export function Atmosphere() {
  return (
    <group>
      <Sunbeams />
      <Dust />
    </group>
  )
}
