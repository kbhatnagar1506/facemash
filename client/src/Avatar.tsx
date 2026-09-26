import { forwardRef, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'

export interface AvatarState {
  moving: boolean
  bubble?: string
  /** Seated pose (legs forward, body lowered): hackers at tables. */
  sit?: boolean
  /** Arm wave for NPCs chatting / greeting. */
  wave?: boolean
}

/**
 * Chibi trainer: big head, cap in the player's color, swinging arms/legs.
 * The parent group is positioned/rotated by the owner; `state` drives animation.
 */
export const Avatar = forwardRef<
  THREE.Group,
  {
    color: string
    name: string
    state: React.MutableRefObject<AvatarState>
    me?: boolean
    /** NPC look: no cap (hair instead), own shirt/skin colors, no name tag. */
    npc?: { shirt: string; skin: string; hair: string; pants?: string; backpack?: string }
    /** Hide the floating name tag (your own avatar in the third-person view). */
    hideTag?: boolean
  }
>(function Avatar({ color, name, state, me, npc, hideTag }, ref) {
  const body = useRef<THREE.Group>(null!)
  const legL = useRef<THREE.Mesh>(null!)
  const legR = useRef<THREE.Mesh>(null!)
  const armL = useRef<THREE.Mesh>(null!)
  const armR = useRef<THREE.Mesh>(null!)
  const bubble = useRef<HTMLDivElement>(null!)
  const phase = useRef(0)
  const shirt = npc?.shirt ?? color
  const skin = npc?.skin ?? '#f3c9a5'
  const pants = npc?.pants ?? '#2f3a5c'

  useFrame((_, dt) => {
    const { moving, sit, wave } = state.current
    phase.current = moving ? phase.current + dt * 12 : phase.current * 0.8
    const s = Math.sin(phase.current) * (moving ? 0.7 : 0)
    legL.current.rotation.x = sit ? -1.45 : s
    legR.current.rotation.x = sit ? -1.45 : -s
    armL.current.rotation.x = sit ? -0.9 : -s
    armR.current.rotation.x = sit ? -0.9 : s
    if (wave) {
      const t = performance.now() / 1000
      armR.current.rotation.x = -2.6
      armR.current.rotation.z = 0.4 + Math.sin(t * 9) * 0.35
    } else armR.current.rotation.z = 0
    body.current.position.y = sit ? -0.42 : moving ? Math.abs(Math.cos(phase.current)) * 0.12 : 0
    if (bubble.current) {
      const text = state.current.bubble ?? ''
      if (bubble.current.textContent !== text) bubble.current.textContent = text
      bubble.current.style.display = text ? 'block' : 'none'
    }
  })

  return (
    <group ref={ref}>
      {/* soft blob shadow */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.12, 0]}>
        <circleGeometry args={[0.7, 20]} />
        <meshBasicMaterial color="#000" transparent opacity={0.22} depthWrite={false} />
      </mesh>
      <group ref={body}>
        <mesh ref={legL} position={[-0.22, 0.55, 0]} geometry={limb(0.5)} castShadow={!npc}>
          <meshToonMaterial color={pants} />
        </mesh>
        <mesh ref={legR} position={[0.22, 0.55, 0]} geometry={limb(0.5)} castShadow={!npc}>
          <meshToonMaterial color={pants} />
        </mesh>
        <mesh position={[0, 0.95, 0]} castShadow={!npc}>
          <capsuleGeometry args={[0.36, 0.35, 4, 12]} />
          <meshToonMaterial color={shirt} />
        </mesh>
        {npc?.backpack && (
          <mesh position={[0, 1.02, -0.38]} castShadow={!npc}>
            <boxGeometry args={[0.52, 0.62, 0.26]} />
            <meshToonMaterial color={npc.backpack} />
          </mesh>
        )}
        <mesh ref={armL} position={[-0.48, 1.2, 0]} geometry={limb(0.42)} castShadow={!npc}>
          <meshToonMaterial color={skin} />
        </mesh>
        <mesh ref={armR} position={[0.48, 1.2, 0]} geometry={limb(0.42)} castShadow={!npc}>
          <meshToonMaterial color={skin} />
        </mesh>
        <mesh position={[0, 1.78, 0]} castShadow={!npc}>
          <sphereGeometry args={[0.5, 20, 16]} />
          <meshToonMaterial color={skin} />
        </mesh>
        {/* eyes face +z (forward) */}
        <mesh position={[-0.17, 1.8, 0.45]}>
          <sphereGeometry args={[0.065, 8, 8]} />
          <meshBasicMaterial color="#1d1d24" />
        </mesh>
        <mesh position={[0.17, 1.8, 0.45]}>
          <sphereGeometry args={[0.065, 8, 8]} />
          <meshBasicMaterial color="#1d1d24" />
        </mesh>
        {npc ? (
          // hair: a dome slightly bigger than the head, pushed back
          <mesh position={[0, 1.86, -0.05]} castShadow={!npc}>
            <sphereGeometry args={[0.53, 18, 10, 0, Math.PI * 2, 0, Math.PI / 1.9]} />
            <meshToonMaterial color={npc.hair} />
          </mesh>
        ) : (
          <>
        {/* trainer cap: dome + brim */}
            <mesh position={[0, 1.9, 0]} castShadow={!npc}>
              <sphereGeometry args={[0.53, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
              <meshToonMaterial color={color} />
            </mesh>
            <mesh position={[0, 1.92, 0.42]} rotation-x={0.12}>
              <cylinderGeometry args={[0.36, 0.36, 0.06, 16, 1, false, -Math.PI / 2, Math.PI]} />
              <meshToonMaterial color={color} />
            </mesh>
            <mesh position={[0, 2.15, 0.35]}>
              <sphereGeometry args={[0.1, 10, 8]} />
              <meshToonMaterial color="#ffffff" />
            </mesh>
          </>
        )}
      </group>
      {!npc && (
        <Html position={[0, 2.9, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className="avatar-tag">
            <div ref={bubble} className="bubble" style={{ display: 'none' }} />
            <div className={me ? 'nametag me' : 'nametag'} style={{ visibility: hideTag ? 'hidden' : undefined }}>{name}</div>
          </div>
        </Html>
      )}
    </group>
  )
})

const limbCache = new Map<number, THREE.BufferGeometry>()
/** Capsule pivoting from its top so rotation.x swings it like a leg/arm. */
function limb(len: number) {
  let g = limbCache.get(len)
  if (!g) {
    g = new THREE.CapsuleGeometry(0.13, len - 0.2, 4, 8)
    g.translate(0, -len / 2 + 0.1, 0)
    limbCache.set(len, g)
  }
  return g
}
