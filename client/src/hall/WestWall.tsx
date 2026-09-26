import { useMemo } from 'react'
import * as THREE from 'three'
import { L1, Z1, westSlope, westX } from './layout'
import { checkerWall, textCard } from './textures'
import { FoldingChair } from './Sponsors'

// Everything on the west wall, entrance end to back, from the on-site photos.
// Each item is placed in the wall's own frame: local x runs along the wall
// toward the back, local z points out into the atrium, y is up.

function OnWall({ z, off = 0.02, y = 0, children }: { z: number; off?: number; y?: number; children: React.ReactNode }) {
  const a = Math.atan(westSlope(z))
  return (
    <group position={[westX(z) + off, y, z]} rotation-y={Math.PI / 2 + a}>
      {children}
    </group>
  )
}

function Box({ p, s, color, opacity }: { p: THREE.Vector3Tuple; s: THREE.Vector3Tuple; color: string; opacity?: number }) {
  return (
    <mesh position={p} castShadow>
      <boxGeometry args={s} />
      <meshLambertMaterial color={color} transparent={opacity !== undefined} opacity={opacity ?? 1} />
    </mesh>
  )
}

/** Recessed wooden door, optionally with one leaf swung open onto a lit room. */
function WoodDoor({ w = 1.1, double = false, open = false }: { w?: number; double?: boolean; open?: boolean }) {
  const leaf = double ? w / 2 : w
  return (
    <group>
      <Box p={[0, 2.5, 0.05]} s={[w + 0.3, 0.14, 0.12]} color="#e9e6df" />
      {[-1, 1].map((s) => (
        <Box key={s} p={[(s * (w + 0.15)) / 2, 1.25, 0.05]} s={[0.1, 2.5, 0.12]} color="#e9e6df" />
      ))}
      {open && (
        <mesh position={[0, 1.2, 0.01]}>
          <planeGeometry args={[w, 2.4]} />
          <meshBasicMaterial color="#e8ebe8" />
        </mesh>
      )}
      {double ? (
        <>
          <Box p={[-leaf / 2, 1.2, open ? 0.04 : 0.06]} s={[leaf, 2.4, 0.05]} color="#c98f45" />
          <group position={[w / 2, 0, 0.06]} rotation-y={open ? 1.2 : 0}>
            <Box p={[-leaf / 2, 1.2, 0]} s={[leaf, 2.4, 0.05]} color="#c98f45" />
          </group>
        </>
      ) : open ? (
        <group position={[-w / 2, 0, 0.06]} rotation-y={-1.1}>
          <Box p={[leaf / 2, 1.2, 0]} s={[leaf, 2.4, 0.05]} color="#c98f45" />
        </group>
      ) : (
        <Box p={[0, 1.2, 0.06]} s={[leaf, 2.4, 0.05]} color="#c98f45" />
      )}
      <Box p={[w / 2 - 0.15, 1.05, 0.12]} s={[0.04, 0.2, 0.05]} color="#9ea3a8" />
    </group>
  )
}

/** Frosted glass: a big window panel or a pair of doors with bar handles. */
function FrostedGlass({ w, h, doors = false }: { w: number; h: number; doors?: boolean }) {
  return (
    <group>
      <mesh position={[0, h / 2 + (doors ? 0 : 0.9), 0.03]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial color="#a9c0bb" roughness={0.2} metalness={0.1} />
      </mesh>
      <mesh position={[0, h / 2 + (doors ? 0 : 0.9), 0.035]}>
        <planeGeometry args={[w * 0.96, h * 0.96]} />
        <meshBasicMaterial color="#d5e3df" transparent opacity={0.35} />
      </mesh>
      <Box p={[0, h + (doors ? 0 : 0.9) + 0.05, 0.03]} s={[w + 0.12, 0.1, 0.08]} color="#c7cacd" />
      <Box p={[0, (doors ? 0 : 0.9) - 0.05, 0.03]} s={[w + 0.12, 0.1, 0.08]} color="#c7cacd" />
      {doors && (
        <>
          <Box p={[0, h / 2, 0.04]} s={[0.04, h, 0.06]} color="#c7cacd" />
          {[-0.12, 0.12].map((x) => (
            <Box key={x} p={[x, 1.1, 0.12]} s={[0.035, 0.5, 0.035]} color="#b9bdc3" />
          ))}
        </>
      )}
    </group>
  )
}

function Bins({ labels }: { labels: [string, string][] }) {
  const cards = useMemo(
    () => labels.map(([t]) => textCard([{ text: t, font: '800 60px Arial', color: '#1d1d20' }], { bg: '#f4f4f0', w: 256, h: 128 })),
    [labels],
  )
  return (
    <group>
      {labels.map(([, color], i) => (
        <group key={i} position={[(i - (labels.length - 1) / 2) * 0.62, 0, 0.35]}>
          <Box p={[0, 0.5, 0]} s={[0.56, 1, 0.55]} color={color} />
          <Box p={[0, 1.02, 0]} s={[0.58, 0.05, 0.57]} color="#2a2b2e" />
          <mesh position={[0, 0.78, 0.28]}>
            <planeGeometry args={[0.36, 0.18]} />
            <meshBasicMaterial map={cards[i].map} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

function WetFloor() {
  return (
    <group>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, 0.34, s * 0.1]} rotation-x={s * 0.28}>
          <boxGeometry args={[0.32, 0.7, 0.02]} />
          <meshLambertMaterial color="#f2c230" />
        </mesh>
      ))}
    </group>
  )
}

function TrashCan() {
  return (
    <group>
      <mesh position={[0, 0.45, 0]} castShadow>
        <cylinderGeometry args={[0.3, 0.27, 0.9, 20]} />
        <meshLambertMaterial color="#4c5157" />
      </mesh>
      <mesh position={[0, 0.91, 0]}>
        <torusGeometry args={[0.29, 0.035, 6, 20]} />
        <meshLambertMaterial color="#111" />
      </mesh>
    </group>
  )
}

function Carton({ x, z, s = 0.45, rot = 0 }: { x: number; z: number; s?: number; rot?: number }) {
  return (
    <group position={[x, 0, z]} rotation-y={rot}>
      <Box p={[0, s * 0.4, 0]} s={[s, s * 0.8, s * 0.7]} color="#b98d5c" />
      <mesh position={[0, s * 0.8, s * 0.36]} rotation-x={-0.9}>
        <planeGeometry args={[s, s * 0.3]} />
        <meshLambertMaterial color="#a67c4e" side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

export function WestWall() {
  const panels = useMemo(() => checkerWall(10, 2, [], 21), [])
  const tv = useMemo(
    () =>
      textCard(
        [
          { text: 'HackGT 13', font: '800 46px Arial', color: '#ffffff' },
          { text: 'Seaside Market', font: '500 24px Arial', color: '#cfe0ff' },
          { text: 'Hack on!', font: '600 26px Arial', color: '#f2c230' },
        ],
        { bg: '#2c4fa8', w: 256, h: 400 },
      ),
    [],
  )
  const bathrooms = useMemo(
    () => textCard([{ text: '← BATHROOMS', font: '800 44px Arial', color: '#1d2c3a' }], { bg: '#dcecf7', w: 400, h: 140 }),
    [],
  )

  return (
    <group>
      {/* TV in its wall niche, beside the side corridor (south wall near the corner) */}
      <group position={[westX(Z1) + 6.2, 0, Z1 - 0.05]} rotation-y={Math.PI}>
        <Box p={[0, 2.2, 0.06]} s={[1.9, 1.9, 0.12]} color="#eceae5" />
        <Box p={[0, 2.2, 0.16]} s={[0.78, 1.36, 0.08]} color="#15171c" />
        <mesh position={[0, 2.2, 0.205]}>
          <planeGeometry args={[0.68, 1.22]} />
          <meshBasicMaterial map={tv.map} toneMapped={false} />
        </mesh>
      </group>

      {/* 3-bin recycling station and a black chair, right by the stair base */}
      <OnWall z={20.7}>
        <Bins labels={[['PLASTIC', '#454a50'], ['LANDFILL', '#b9a98a'], ['COMPOST', '#2f4a3a']]} />
      </OnWall>
      <OnWall z={19.2}>
        <group position={[0, 0, 0.5]}>
          <Box p={[0, 0.46, 0]} s={[0.46, 0.06, 0.44]} color="#1d1e22" />
          <Box p={[0, 0.8, -0.2]} s={[0.46, 0.5, 0.05]} color="#1d1e22" />
          {[-0.2, 0.2].map((x) => [-0.18, 0.18].map((z) => <Box key={`${x}${z}`} p={[x, 0.23, z]} s={[0.03, 0.46, 0.03]} color="#9aa0a6" />))}
        </group>
      </OnWall>

      {/* beige / taupe panels on the wall under the stair */}
      <OnWall z={10} off={0.03}>
        <mesh position={[0, L1 / 2, 0]}>
          <planeGeometry args={[13, L1]} />
          <meshLambertMaterial map={panels} />
        </mesh>
      </OnWall>

      {/* wooden door (open) after the stair, frosted window, then the Help Desk wall */}
      <OnWall z={2.2}>
        <WoodDoor w={1.8} double open />
      </OnWall>
      <OnWall z={-2.6}>
        <FrostedGlass w={3.4} h={2.2} />
      </OnWall>
      <OnWall z={-11}>
        <FrostedGlass w={2} h={2.5} doors />
      </OnWall>
      <OnWall z={-13.6}>
        <WoodDoor w={1.05} />
      </OnWall>

      {/* bins, wet-floor sign and boxes in front of a taupe panel */}
      <OnWall z={-15.6} off={0.03}>
        <mesh position={[0, 1.6, 0]}>
          <planeGeometry args={[2.4, 3.2]} />
          <meshLambertMaterial color="#9d978a" />
        </mesh>
        <Bins labels={[['RECYCLE', '#3d5670'], ['PAPER', '#3d5670'], ['LANDFILL', '#2e3035']]} />
        <group position={[1.6, 0, 0.5]}>
          <WetFloor />
        </group>
        <Carton x={-1.6} z={0.4} />
        <Carton x={-1.9} z={0.8} s={0.38} rot={0.4} />
      </OnWall>

      {/* navy accent wall with the open double doors to the bathroom corridor */}
      <OnWall z={-20.5} off={0.04}>
        <mesh position={[0, (L1 - 0.4) / 2, 0]}>
          <planeGeometry args={[6, L1 - 0.4]} />
          <meshLambertMaterial color="#34475a" />
        </mesh>
        <group position={[0.4, 0, 0.02]}>
          <mesh position={[0, 1.25, 0.005]}>
            <planeGeometry args={[1.9, 2.5]} />
            <meshBasicMaterial color="#3b3a38" />
          </mesh>
          <WoodDoor w={1.9} double open />
        </group>
        <mesh position={[2.1, 1.7, 0.03]}>
          <planeGeometry args={[0.3, 0.2]} />
          <meshBasicMaterial color="#f4f4f0" />
        </mesh>
      </OnWall>

      {/* loose chairs, trash can and the bathrooms sign on the column */}
      <OnWall z={-17.5}>
        <group position={[0, 0, 2.2]}>
          <FoldingChair x={0} z={0} rot={0.2} />
          <FoldingChair x={1.1} z={0.2} rot={-0.1} />
        </group>
        <group position={[-2.2, 0, 2.6]}>
          <TrashCan />
        </group>
      </OnWall>
      <mesh position={[-7.45, 1.8, -14.2]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[0.6, 0.21]} />
        <meshBasicMaterial map={bathrooms.map} />
      </mesh>
    </group>
  )
}
