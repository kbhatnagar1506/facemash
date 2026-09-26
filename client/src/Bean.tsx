import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Look, Pattern } from './look'
import type { AvatarState } from './Avatar'

// A cute jellybean (Fall Guys–style): a soft capsule body with a white face visor
// and two little eyes, stubby arms and legs, a pattern and a hat. It waddles when
// it walks, breathes when idle, waves and sits. About 2.4 units tall with a hat.

const patternCache = new Map<string, THREE.Texture>()
function patternTexture(body: string, accent: string, pattern: Pattern) {
  const key = `${body}|${accent}|${pattern}`
  const hit = patternCache.get(key)
  if (hit) return hit
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  g.fillStyle = body
  g.fillRect(0, 0, S, S)
  g.fillStyle = accent
  // canvas top = top of the bean, bottom = its feet
  if (pattern === 'split') g.fillRect(0, S * 0.6, S, S * 0.4)
  else if (pattern === 'stripes') for (let y = S * 0.42; y < S; y += 34) g.fillRect(0, y, S, 15)
  else if (pattern === 'dots')
    for (let y = 18; y < S; y += 36)
      for (let x = (y / 36) % 2 ? 18 : 0; x < S + 20; x += 36) {
        if (y < S * 0.46 && (x < S * 0.2 || x > S * 0.8)) continue // keep the face clear
        // the texture wraps ~1.5× wider than it is tall, so squash to land round
        g.beginPath()
        g.ellipse(x, y, 7, 10.5, 0, 0, Math.PI * 2)
        g.fill()
      }
  else if (pattern === 'zigzag') {
    g.beginPath()
    g.moveTo(0, S)
    for (let x = 0; x <= S; x += 16) g.lineTo(x, (x / 16) % 2 ? S * 0.6 : S * 0.7)
    g.lineTo(S, S)
    g.fill()
  } else if (pattern === 'hearts') {
    const heart = (x: number, y: number, r: number) => {
      g.beginPath()
      g.moveTo(x, y + r * 0.9)
      g.bezierCurveTo(x - r * 1.4, y - r * 0.2, x - r * 0.6, y - r * 1.2, x, y - r * 0.35)
      g.bezierCurveTo(x + r * 0.6, y - r * 1.2, x + r * 1.4, y - r * 0.2, x, y + r * 0.9)
      g.fill()
    }
    for (let y = S * 0.55; y < S; y += 40)
      for (let x = ((y / 40) % 2) * 20; x < S + 20; x += 40) {
        g.save()
        g.translate(x, y)
        g.scale(0.66, 1) // pre-squash: the wrap stretches it back to a proper heart
        heart(0, 0, 12)
        g.restore()
      }
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = THREE.RepeatWrapping
  patternCache.set(key, t)
  return t
}

/** Limb capsule that pivots from its top, so rotation swings it. */
const limbCache = new Map<string, THREE.BufferGeometry>()
function limb(len: number, r: number) {
  const k = `${len}|${r}`
  let g = limbCache.get(k)
  if (!g) {
    g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 4, 10)
    g.translate(0, -len / 2 + r, 0)
    limbCache.set(k, g)
  }
  return g
}

// The body is an egg: a rounder, wider bottom, a slightly smaller dome on top.
const RB = 0.68 // bottom radius
const RT = 0.6 // top (head) radius
const Y0 = 0.3 + RB // centre of the bottom curve
const Y1 = Y0 + 0.66 // centre of the head dome
const BODY_Y = (Y0 + Y1) / 2
const TOP = Y1 + RT // crown of the head
const FACE_Y = Y1 + 0.02
const FACE_Z = 0.43

let eggGeo: THREE.BufferGeometry | null = null
function eggGeometry() {
  if (eggGeo) return eggGeo
  const pts: THREE.Vector2[] = []
  for (let i = 0; i <= 16; i++) {
    const t = -Math.PI / 2 + (i / 16) * (Math.PI / 2)
    pts.push(new THREE.Vector2(Math.max(0.0001, RB * Math.cos(t)), Y0 + RB * Math.sin(t)))
  }
  for (let i = 1; i <= 16; i++) {
    const t = (i / 16) * (Math.PI / 2)
    pts.push(new THREE.Vector2(Math.max(0.0001, RT * Math.cos(t)), Y1 + RT * Math.sin(t)))
  }
  eggGeo = new THREE.LatheGeometry(pts, 40)
  eggGeo.computeVertexNormals()
  return eggGeo
}

function Eyes({ look }: { look: Look }) {
  const ink = <meshBasicMaterial color="#15161c" />
  const dot = (x: number) => (
    <group key={`d${x}`}>
      <mesh position={[x, FACE_Y + 0.02, FACE_Z + 0.218]}>
        <capsuleGeometry args={[0.052, 0.1, 4, 10]} />
        {ink}
      </mesh>
      {/* sparkle */}
      <mesh position={[x + 0.02, FACE_Y + 0.07, FACE_Z + 0.276]}>
        <circleGeometry args={[0.018, 10]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
    </group>
  )
  const arc = (x: number) => (
    <mesh key={`a${x}`} position={[x, FACE_Y, FACE_Z + 0.218]}>
      <torusGeometry args={[0.055, 0.018, 6, 14, Math.PI]} />
      {ink}
    </mesh>
  )
  const line = (x: number) => (
    <mesh key={`l${x}`} position={[x, FACE_Y, FACE_Z + 0.218]}>
      <boxGeometry args={[0.11, 0.022, 0.01]} />
      {ink}
    </mesh>
  )
  switch (look.eyes) {
    case 'happy':
      return <>{[-0.13, 0.13].map(arc)}</>
    case 'sleepy':
      return <>{[-0.13, 0.13].map(line)}</>
    case 'wink':
      return (
        <>
          {dot(-0.13)}
          {arc(0.13)}
        </>
      )
    case 'star':
      return (
        <>
          {[-0.13, 0.13].map((x) => (
            <group key={x}>
              {dot(x)}
              <mesh position={[x + 0.018, FACE_Y + 0.06, FACE_Z + 0.276]}>
                <circleGeometry args={[0.016, 10]} />
                <meshBasicMaterial color="#ffffff" />
              </mesh>
              {/* rosy cheeks */}
              <mesh position={[x * 1.75, FACE_Y - 0.09, FACE_Z + 0.185]}>
                <circleGeometry args={[0.045, 14]} />
                <meshBasicMaterial color="#ff9eb5" transparent opacity={0.8} />
              </mesh>
            </group>
          ))}
        </>
      )
    case 'shades':
      return (
        <group position={[0, FACE_Y + 0.02, FACE_Z + 0.228]}>
          {[-0.13, 0.13].map((x) => (
            <mesh key={x} position={[x, 0, 0]} scale={[1, 0.7, 0.4]}>
              <sphereGeometry args={[0.1, 14, 10]} />
              <meshStandardMaterial color="#101116" roughness={0.15} metalness={0.4} />
            </mesh>
          ))}
          <mesh>
            <boxGeometry args={[0.1, 0.02, 0.02]} />
            <meshBasicMaterial color="#101116" />
          </mesh>
        </group>
      )
    default:
      return <>{[-0.13, 0.13].map(dot)}</>
  }
}

function HatMesh({ look, spin }: { look: Look; spin: React.RefObject<THREE.Group | null> }) {
  const y = TOP - 0.06
  const a = look.accent
  switch (look.hat) {
    case 'cap':
      return (
        <group position={[0, y - 0.14, 0]}>
          <mesh castShadow>
            <sphereGeometry args={[0.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial roughness={0.42} color={a} />
          </mesh>
          <mesh position={[0, 0.02, 0.42]} rotation-x={0.14}>
            <cylinderGeometry args={[0.34, 0.34, 0.05, 16, 1, false, -Math.PI / 2, Math.PI]} />
            <meshStandardMaterial roughness={0.42} color={a} />
          </mesh>
          <mesh position={[0, 0.48, 0]}>
            <sphereGeometry args={[0.06, 10, 8]} />
            <meshStandardMaterial roughness={0.42} color={look.body} />
          </mesh>
        </group>
      )
    case 'crown':
      return (
        <group position={[0, y + 0.02, 0]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.3, 0.33, 0.18, 20, 1, true]} />
            <meshStandardMaterial color="#ffc93c" metalness={0.6} roughness={0.3} side={THREE.DoubleSide} />
          </mesh>
          {Array.from({ length: 6 }, (_, i) => {
            const t = (i / 6) * Math.PI * 2
            return (
              <mesh key={i} position={[Math.sin(t) * 0.3, 0.16, Math.cos(t) * 0.3]}>
                <coneGeometry args={[0.06, 0.16, 6]} />
                <meshStandardMaterial color="#ffc93c" metalness={0.6} roughness={0.3} />
              </mesh>
            )
          })}
          <mesh position={[0, 0.02, 0.33]}>
            <sphereGeometry args={[0.045, 10, 8]} />
            <meshStandardMaterial color="#ff5d6c" roughness={0.2} />
          </mesh>
        </group>
      )
    case 'bunny':
      return (
        <group position={[0, y - 0.05, 0]}>
          {[-1, 1].map((s) => (
            <group key={s} position={[s * 0.2, 0, 0]} rotation-z={-s * 0.18}>
              <mesh position={[0, 0.3, 0]} scale={[1, 1, 0.55]} castShadow>
                <capsuleGeometry args={[0.1, 0.42, 4, 10]} />
                <meshStandardMaterial roughness={0.42} color={a} />
              </mesh>
              <mesh position={[0, 0.3, 0.05]} scale={[0.55, 0.8, 0.3]}>
                <capsuleGeometry args={[0.1, 0.42, 4, 10]} />
                <meshStandardMaterial roughness={0.42} color="#ffb3c6" />
              </mesh>
            </group>
          ))}
        </group>
      )
    case 'bucket':
      return (
        <group position={[0, y - 0.1, 0]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.36, 0.44, 0.3, 20]} />
            <meshStandardMaterial roughness={0.42} color={a} />
          </mesh>
          <mesh position={[0, -0.13, 0]} rotation-x={0}>
            <cylinderGeometry args={[0.66, 0.7, 0.05, 24]} />
            <meshStandardMaterial roughness={0.42} color={a} />
          </mesh>
          <mesh position={[0, -0.05, 0]}>
            <cylinderGeometry args={[0.445, 0.445, 0.07, 20]} />
            <meshStandardMaterial roughness={0.42} color={look.body} />
          </mesh>
        </group>
      )
    case 'propeller':
      return (
        <group position={[0, y - 0.12, 0]}>
          {[0, 1, 2, 3].map((i) => (
            <mesh key={i} rotation-y={(i * Math.PI) / 2}>
              <sphereGeometry args={[0.48, 12, 8, 0, Math.PI / 2, 0, Math.PI / 2]} />
              <meshStandardMaterial roughness={0.42} color={['#ff5d6c', '#ffc93c', '#3fc5f0', '#7ad36b'][i]} />
            </mesh>
          ))}
          <mesh position={[0, 0.55, 0]}>
            <cylinderGeometry args={[0.02, 0.02, 0.16, 6]} />
            <meshStandardMaterial roughness={0.42} color="#555" />
          </mesh>
          <group ref={spin} position={[0, 0.63, 0]}>
            {[0, 1].map((i) => (
              <mesh key={i} rotation-y={i * Math.PI} position={[Math.cos(i * Math.PI) * 0.16, 0, 0]} rotation-x={0.3}>
                <boxGeometry args={[0.3, 0.015, 0.08]} />
                <meshStandardMaterial roughness={0.42} color={a} />
              </mesh>
            ))}
          </group>
        </group>
      )
    case 'halo':
      return (
        <group ref={spin} position={[0, TOP + 0.28, 0]}>
          <mesh rotation-x={Math.PI / 2}>
            <torusGeometry args={[0.32, 0.045, 10, 30]} />
            <meshBasicMaterial color="#ffe27a" toneMapped={false} />
          </mesh>
        </group>
      )
    case 'headphones':
      return (
        <group position={[0, Y1 - 0.02, 0]}>
          {/* band arcs over the top of the head, ear to ear */}
          <mesh>
            <torusGeometry args={[0.66, 0.05, 8, 28, Math.PI]} />
            <meshStandardMaterial roughness={0.42} color="#2a2c33" />
          </mesh>
          {[-1, 1].map((s) => (
            <group key={s} position={[s * 0.64, 0, 0]}>
              <mesh rotation-z={Math.PI / 2} scale={[1, 0.55, 1]}>
                <cylinderGeometry args={[0.2, 0.2, 0.16, 20]} />
                <meshStandardMaterial roughness={0.42} color={a} />
              </mesh>
              <mesh position={[s * 0.085, 0, 0]} rotation-z={Math.PI / 2} scale={[1, 0.3, 1]}>
                <cylinderGeometry args={[0.13, 0.13, 0.05, 16]} />
                <meshStandardMaterial roughness={0.42} color="#2a2c33" />
              </mesh>
            </group>
          ))}
        </group>
      )
    case 'party':
      return (
        <group position={[0, y + 0.22, 0]} rotation-z={0.12}>
          <mesh castShadow>
            <coneGeometry args={[0.24, 0.55, 18]} />
            <meshStandardMaterial roughness={0.42} color={a} />
          </mesh>
          {[-0.1, 0.06].map((yy) => (
            <mesh key={yy} position={[0, yy, 0]}>
              <cylinderGeometry args={[0.24 * (0.5 - yy / 0.55 * 0.9), 0.24 * (0.5 - yy / 0.55 * 0.9) + 0.02, 0.05, 18]} />
              <meshStandardMaterial roughness={0.42} color={look.body} />
            </mesh>
          ))}
          <mesh position={[0, 0.3, 0]}>
            <sphereGeometry args={[0.07, 10, 8]} />
            <meshStandardMaterial roughness={0.42} color="#ffffff" />
          </mesh>
        </group>
      )
    default:
      return null
  }
}

/** The laptop, held open in front with both hands (screen toward the bean). */
function Laptop({ look }: { look: Look }) {
  const sticker = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const g = c.getContext('2d')!
    g.fillStyle = '#c9ccd2'
    g.fillRect(0, 0, 128, 128)
    g.fillStyle = look.accent === '#ffffff' ? '#3fc5f0' : look.accent
    g.beginPath()
    g.arc(64, 60, 30, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = '#ffffff'
    g.font = '800 22px Nunito, Arial'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('GT', 64, 61)
    g.fillStyle = '#ffd23f'
    g.fillRect(20, 100, 30, 12)
    g.fillStyle = '#ff5d6c'
    g.fillRect(80, 96, 22, 18)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [look.accent])
  return (
    <group position={[0, BODY_Y - 0.22, 0.78]} rotation-x={0.25}>
      <mesh castShadow>
        <boxGeometry args={[0.66, 0.035, 0.44]} />
        <meshStandardMaterial roughness={0.42} color="#c9ccd2" />
      </mesh>
      <mesh position={[0, 0.02, -0.02]}>
        <boxGeometry args={[0.56, 0.005, 0.26]} />
        <meshStandardMaterial roughness={0.42} color="#3a3d45" />
      </mesh>
      {/* lid stands up at the front edge: screen toward the bean, stickers toward everyone else */}
      <group position={[0, 0.02, 0.21]} rotation-x={-0.3}>
        <mesh position={[0, 0.22, 0]} castShadow>
          <boxGeometry args={[0.66, 0.44, 0.025]} />
          <meshStandardMaterial roughness={0.42} color="#c9ccd2" />
        </mesh>
        <mesh position={[0, 0.22, 0.0135]}>
          <planeGeometry args={[0.58, 0.38]} />
          <meshBasicMaterial map={sticker} />
        </mesh>
        <mesh position={[0, 0.22, -0.0135]} rotation-y={Math.PI}>
          <planeGeometry args={[0.58, 0.37]} />
          <meshBasicMaterial color="#7fd3ff" toneMapped={false} />
        </mesh>
      </group>
    </group>
  )
}

/** Small things held in the right hand. */
function HandItem({ look }: { look: Look }) {
  const a = look.accent === '#ffffff' ? '#ff5d6c' : look.accent
  switch (look.item) {
    case 'coffee':
      return (
        <group position={[0, -0.7, 0.14]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.1, 0.08, 0.24, 16]} />
            <meshStandardMaterial roughness={0.42} color="#f5f1e6" />
          </mesh>
          <mesh>
            <cylinderGeometry args={[0.101, 0.09, 0.09, 16]} />
            <meshStandardMaterial roughness={0.42} color="#b88a5a" />
          </mesh>
          <mesh position={[0, 0.13, 0]}>
            <cylinderGeometry args={[0.105, 0.105, 0.03, 16]} />
            <meshStandardMaterial roughness={0.42} color="#4e3627" />
          </mesh>
        </group>
      )
    case 'boba':
      return (
        <group position={[0, -0.7, 0.14]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.1, 0.08, 0.28, 16]} />
            <meshStandardMaterial roughness={0.42} color="#e8c9a2" />
          </mesh>
          {[0, 1, 2, 3, 4].map((i) => (
            <mesh key={i} position={[Math.cos(i * 1.3) * 0.05, -0.1, Math.sin(i * 1.3) * 0.05]}>
              <sphereGeometry args={[0.025, 8, 6]} />
              <meshStandardMaterial roughness={0.42} color="#2a1a14" />
            </mesh>
          ))}
          <mesh position={[0.03, 0.22, 0]} rotation-z={-0.2}>
            <cylinderGeometry args={[0.018, 0.018, 0.22, 8]} />
            <meshStandardMaterial roughness={0.42} color={a} />
          </mesh>
          <mesh position={[0, 0.15, 0]}>
            <sphereGeometry args={[0.1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial roughness={0.42} color="#ffffff" transparent opacity={0.6} />
          </mesh>
        </group>
      )
    case 'phone':
      return (
        <group position={[0, -0.66, 0.14]} rotation-x={-0.5}>
          <mesh castShadow>
            <boxGeometry args={[0.12, 0.22, 0.02]} />
            <meshStandardMaterial roughness={0.42} color="#1f2430" />
          </mesh>
          <mesh position={[0, 0, 0.011]}>
            <planeGeometry args={[0.1, 0.19]} />
            <meshBasicMaterial color="#8fd6ff" toneMapped={false} />
          </mesh>
        </group>
      )
    case 'duck':
      return (
        <group position={[0, -0.74, 0.16]}>
          <mesh castShadow scale={[1, 0.8, 1.2]}>
            <sphereGeometry args={[0.12, 14, 10]} />
            <meshStandardMaterial roughness={0.42} color="#ffd23f" />
          </mesh>
          <mesh position={[0, 0.12, 0.05]}>
            <sphereGeometry args={[0.08, 12, 10]} />
            <meshStandardMaterial roughness={0.42} color="#ffd23f" />
          </mesh>
          <mesh position={[0, 0.11, 0.14]} rotation-x={Math.PI / 2}>
            <coneGeometry args={[0.035, 0.07, 8]} />
            <meshStandardMaterial roughness={0.42} color="#ff8a3d" />
          </mesh>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 0.035, 0.15, 0.115]}>
              <sphereGeometry args={[0.012, 6, 6]} />
              <meshBasicMaterial color="#15161c" />
            </mesh>
          ))}
        </group>
      )
    case 'energy':
      return (
        <group position={[0, -0.7, 0.14]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.065, 0.065, 0.24, 16]} />
            <meshStandardMaterial roughness={0.42} color="#1f2430" />
          </mesh>
          <mesh>
            <cylinderGeometry args={[0.066, 0.066, 0.08, 16]} />
            <meshStandardMaterial roughness={0.42} color={a} />
          </mesh>
          <mesh position={[0, 0.125, 0]}>
            <cylinderGeometry args={[0.06, 0.06, 0.01, 16]} />
            <meshStandardMaterial roughness={0.42} color="#c9ccd2" />
          </mesh>
        </group>
      )
    case 'trophy':
      return (
        <group position={[0, -0.68, 0.16]}>
          <mesh position={[0, 0.1, 0]} castShadow>
            <cylinderGeometry args={[0.13, 0.05, 0.18, 18]} />
            <meshStandardMaterial color="#ffc93c" metalness={0.7} roughness={0.25} />
          </mesh>
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * 0.13, 0.11, 0]} rotation-y={s > 0 ? 0 : Math.PI}>
              <torusGeometry args={[0.05, 0.015, 6, 12, Math.PI]} />
              <meshStandardMaterial color="#ffc93c" metalness={0.7} roughness={0.25} />
            </mesh>
          ))}
          <mesh position={[0, -0.02, 0]}>
            <cylinderGeometry args={[0.025, 0.025, 0.08, 8]} />
            <meshStandardMaterial color="#ffc93c" metalness={0.7} roughness={0.25} />
          </mesh>
          <mesh position={[0, -0.08, 0]}>
            <boxGeometry args={[0.14, 0.05, 0.1]} />
            <meshStandardMaterial roughness={0.42} color="#5a3a22" />
          </mesh>
        </group>
      )
    default:
      return null
  }
}

/** The celebration face: one eye open, one winking, and a big smile with rosy cheeks. */
function CheerFace() {
  const ink = <meshBasicMaterial color="#15161c" />
  return (
    <group>
      <mesh position={[-0.13, FACE_Y + 0.03, FACE_Z + 0.218]}>
        <capsuleGeometry args={[0.042, 0.08, 4, 8]} />
        {ink}
      </mesh>
      <mesh position={[0.13, FACE_Y + 0.02, FACE_Z + 0.218]}>
        <torusGeometry args={[0.055, 0.018, 6, 14, Math.PI]} />
        {ink}
      </mesh>
      <mesh position={[0, FACE_Y - 0.08, FACE_Z + 0.228]} rotation-z={Math.PI}>
        <torusGeometry args={[0.08, 0.018, 6, 16, Math.PI]} />
        {ink}
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * 0.23, FACE_Y - 0.07, FACE_Z + 0.182]}>
          <circleGeometry args={[0.045, 14]} />
          <meshBasicMaterial color="#ff9eb5" transparent opacity={0.85} />
        </mesh>
      ))}
    </group>
  )
}

export function BeanBody({ look, state, shadows = true }: { look: Look; state: React.MutableRefObject<AvatarState>; shadows?: boolean }) {
  const body = useRef<THREE.Group>(null!)
  const legL = useRef<THREE.Mesh>(null!)
  const legR = useRef<THREE.Mesh>(null!)
  const armL = useRef<THREE.Group>(null!)
  const armR = useRef<THREE.Group>(null!)
  const spin = useRef<THREE.Group>(null)
  const eyes = useRef<THREE.Group>(null!)
  const cheerFace = useRef<THREE.Group>(null!)
  const phase = useRef(0)
  const holdsLaptop = look.item === 'laptop'
  const map = useMemo(() => patternTexture(look.body, look.accent, look.pattern), [look.body, look.accent, look.pattern])

  useFrame(({ clock }, dt) => {
    const { moving, sit, wave } = state.current
    const t = clock.elapsedTime
    phase.current = moving ? phase.current + dt * 11 : phase.current * 0.85
    const s = Math.sin(phase.current) * (moving ? 0.85 : 0)
    legL.current.rotation.x = sit ? -1.4 : s
    legR.current.rotation.x = sit ? -1.4 : -s
    // arms swing when walking, sway a little when idle, reach forward when seated;
    // with a laptop both hands hold it out in front
    const idle = moving ? 0 : Math.sin(t * 1.6) * 0.06
    const hold = holdsLaptop ? -1.05 : 0
    const swing = holdsLaptop ? 0.15 : 0.9
    armL.current.rotation.x = sit ? -0.9 : hold - s * swing
    armR.current.rotation.x = sit ? -0.9 : hold + s * swing
    armL.current.rotation.z = holdsLaptop ? -0.12 : -0.28 - idle
    armR.current.rotation.z = holdsLaptop ? 0.12 : 0.28 + idle
    if (wave && !holdsLaptop) {
      armR.current.rotation.x = -2.7
      armR.current.rotation.z = 0.5 + Math.sin(t * 9) * 0.35
    }
    // cheer: crouch, spring up with arms in the air (smiling and winking), land squishy
    const c = state.current.cheer ? (performance.now() - state.current.cheer) / 1000 : 9
    const cheering = c < 1.25
    eyes.current.visible = !cheering
    cheerFace.current.visible = cheering
    let jump = 0
    let squash = 1
    if (cheering) {
      if (c < 0.18) squash = 1 - 0.2 * (c / 0.18)
      else if (c < 0.78) {
        const k = (c - 0.18) / 0.6
        jump = Math.sin(k * Math.PI) * 0.95
        squash = 1.1 - 0.1 * k
        if (!holdsLaptop) {
          armL.current.rotation.x = armR.current.rotation.x = -2.8
          armL.current.rotation.z = -0.5 - Math.sin(t * 14) * 0.15
          armR.current.rotation.z = 0.5 + Math.sin(t * 14) * 0.15
        }
      } else if (c < 1.0) squash = 0.82 + 0.18 * ((c - 0.78) / 0.22)
    }
    // waddle + bounce when walking, gentle breathing when idle
    body.current.rotation.z = moving ? Math.sin(phase.current) * 0.1 : 0
    body.current.position.y = (sit ? -0.3 : moving ? Math.abs(Math.cos(phase.current)) * 0.1 : 0) + jump
    const breathe = (moving ? 1 : 1 + Math.sin(t * 2.2) * 0.018) * squash
    body.current.scale.set(1 / Math.sqrt(breathe), breathe, 1 / Math.sqrt(breathe))
    if (spin.current) {
      if (look.hat === 'propeller') spin.current.rotation.y += dt * (moving ? 18 : 6)
      if (look.hat === 'halo') spin.current.position.y = TOP + 0.28 + Math.sin(t * 2) * 0.04
    }
  })

  return (
    <group ref={body}>
      {/* legs */}
      {[-1, 1].map((s) => (
        <mesh key={s} ref={s < 0 ? legL : legR} position={[s * 0.26, 0.4, 0]} geometry={limb(0.4, 0.17)} castShadow={shadows}>
          <meshStandardMaterial roughness={0.42} color={look.pattern === 'solid' ? look.body : look.accent} />
        </mesh>
      ))}
      {/* the bean */}
      <mesh geometry={eggGeometry()} scale={[1, 1, 0.9]} castShadow={shadows}>
        <meshStandardMaterial roughness={0.42} map={map} />
      </mesh>
      {/* the seam around the middle, like the vinyl figure */}
      <mesh position={[0, Y0 + 0.12, 0]} rotation-x={Math.PI / 2} scale={[1, 0.9, 1]}>
        <torusGeometry args={[RB + (RT - RB) * (0.12 / 0.66) + 0.003, 0.012, 6, 40]} />
        <meshStandardMaterial roughness={0.42} color={new THREE.Color(look.body).multiplyScalar(0.8).getStyle()} />
      </mesh>
      {/* face visor */}
      <mesh position={[0, FACE_Y, FACE_Z]} scale={[0.46, 0.37, 0.21]}>
        <sphereGeometry args={[1, 24, 16]} />
        <meshStandardMaterial roughness={0.28} color="#ffffff" emissive="#d8d8d2" />
      </mesh>
      <group ref={eyes}>
        <Eyes look={look} />
        {look.eyes !== 'star' &&
          [-1, 1].map((s) => (
            <mesh key={s} position={[s * 0.25, FACE_Y - 0.1, FACE_Z + 0.178]} rotation-y={s * 0.35}>
              <circleGeometry args={[0.05, 16]} />
              <meshBasicMaterial color="#ff9eb5" transparent opacity={0.55} />
            </mesh>
          ))}
      </group>
      <group ref={cheerFace} visible={false}>
        <CheerFace />
      </group>
      {holdsLaptop && <Laptop look={look} />}
      {/* stubby arms with round hands */}
      {[-1, 1].map((s) => (
        <group key={s} ref={s < 0 ? armL : armR} position={[s * 0.6, BODY_Y + 0.14, 0]}>
          <mesh geometry={limb(0.64, 0.14)} castShadow={shadows}>
            <meshStandardMaterial roughness={0.42} color={look.body} />
          </mesh>
          <mesh position={[0, -0.6, 0.02]}>
            <sphereGeometry args={[0.15, 14, 12]} />
            <meshStandardMaterial roughness={0.42} color={look.body} />
          </mesh>
          {s > 0 && !holdsLaptop && (
            // held items a bit chunkier than life so they read at a glance
            <group position={[0, -0.6, 0]} scale={1.35}>
              <group position={[0, 0.64, 0]}>
                <HandItem look={look} />
              </group>
            </group>
          )}
        </group>
      ))}
      <HatMesh look={look} spin={spin} />
    </group>
  )
}
