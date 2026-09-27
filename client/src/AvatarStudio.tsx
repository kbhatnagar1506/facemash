import { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { BeanBody } from './Bean'
import type { AvatarState } from './Avatar'
import { ACCENT_COLORS, BODY_COLORS, EYES, HATS, ITEMS, PATTERNS, SPONSOR_BEANS, decodeLook, defaultLook, encodeLook, loadLook, randomLook, saveLook, type Look } from './look'
import { fetchMe, saveProfile } from './account'

// /avatar: build your jellybean. A turntable preview you can spin, and big friendly
// pickers for colour, pattern, face and hat. "Save & play" stores it and drops you
// back into the game, where everyone sees your bean.

const LABEL: Record<string, string> = {
  solid: 'Solid', split: 'Two-tone', stripes: 'Stripes', dots: 'Polka', zigzag: 'Zigzag', hearts: 'Hearts',
  dots_e: '• •', happy: '^ ^', sleepy: '– –', wink: '• ^', star: '✦ ✦', shades: '😎',
  none: 'None', cap: 'Cap', crown: 'Crown', bunny: 'Bunny', bucket: 'Bucket', propeller: 'Propeller', halo: 'Halo', party: 'Party', headphones: 'Headphones',
  i_none: 'Empty hands', laptop: 'Laptop', coffee: 'Coffee', boba: 'Boba', phone: 'Phone', duck: 'Rubber duck', energy: 'Energy drink', trophy: 'Trophy',
}
const HAT_ICON: Record<string, string> = { none: '∅', cap: '🧢', crown: '👑', bunny: '🐰', bucket: '🪣', propeller: '🚁', halo: '😇', party: '🥳', headphones: '🎧' }
const ITEM_ICON: Record<string, string> = { none: '✋', laptop: '💻', coffee: '☕', boba: '🧋', phone: '📱', duck: '🦆', energy: '⚡', trophy: '🏆' }

/** Label colour for a chip filled with `hex`: white or ink, whichever reads better (WCAG contrast). */
function inkOn(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  const INK = 0.0237 // --ink #2b2a33
  return 1.05 / (L + 0.05) >= (L + 0.05) / (INK + 0.05) ? '#fff' : 'var(--ink)'
}

function Podium() {
  return (
    <group>
      <mesh position={[0, -0.12, 0]} receiveShadow>
        <cylinderGeometry args={[1.5, 1.6, 0.24, 48]} />
        <meshToonMaterial color="#ffffff" />
      </mesh>
      <mesh position={[0, -0.005, 0]} rotation-x={-Math.PI / 2} receiveShadow>
        <ringGeometry args={[1.25, 1.42, 48]} />
        <meshBasicMaterial color="#ffd23f" />
      </mesh>
    </group>
  )
}

/** Floating pastel confetti shapes drifting behind the bean. */
function Sparkles() {
  const g = useRef<THREE.Group>(null!)
  const bits = useRef(
    Array.from({ length: 28 }, (_, i) => ({
      p: (() => {
        // a far ring all the way round, so they stay behind the bean from any angle
        const a = Math.random() * Math.PI * 2
        const r = 7 + Math.random() * 3
        return new THREE.Vector3(Math.cos(a) * r, Math.random() * 5 - 0.5, Math.sin(a) * r)
      })(),
      c: ['#ff8fb1', '#ffd23f', '#7ad36b', '#3fc5f0', '#b58be0', '#ff8a3d'][i % 6],
      s: 0.1 + Math.random() * 0.12,
      k: Math.random() * 10,
    })),
  )
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    g.current.children.forEach((m, i) => {
      const b = bits.current[i]
      m.position.set(b.p.x + Math.sin(t * 0.4 + b.k) * 0.3, b.p.y + Math.sin(t * 0.7 + b.k) * 0.25, b.p.z)
      m.rotation.set(t * 0.6 + b.k, t * 0.8 + b.k, 0)
    })
  })
  return (
    <group ref={g}>
      {bits.current.map((b, i) => (
        <mesh key={i} scale={b.s}>
          {i % 3 === 0 ? <octahedronGeometry args={[1, 0]} /> : i % 3 === 1 ? <boxGeometry args={[1.4, 1.4, 0.3]} /> : <sphereGeometry args={[1, 10, 8]} />}
          <meshBasicMaterial color={b.c} />
        </mesh>
      ))}
    </group>
  )
}

/** The bean on the podium: smiles, winks and jumps whenever its look changes (or on save). */
function Showcase({ look, pose, cheer }: { look: Look; pose: 'idle' | 'wave' | 'walk'; cheer: number }) {
  const state = useRef<AvatarState>({ moving: false })
  const g = useRef<THREE.Group>(null!)
  const key = `${look.body}${look.accent}${look.pattern}${look.eyes}${look.hat}${look.item}`
  useEffect(() => {
    state.current.cheer = performance.now()
  }, [key, cheer])
  useFrame(({ camera }, dt) => {
    state.current.moving = pose === 'walk'
    state.current.wave = pose === 'wave'
    // turn to face you for the cheer, otherwise a slow turntable spin
    const cheering = state.current.cheer !== undefined && performance.now() - state.current.cheer < 1300
    if (cheering) {
      // swing round to face wherever the camera is, so you see the smile and the wink
      const want = Math.atan2(camera.position.x, camera.position.z)
      const d = Math.atan2(Math.sin(want - g.current.rotation.y), Math.cos(want - g.current.rotation.y))
      g.current.rotation.y += d * Math.min(1, dt * 12)
    }
    else g.current.rotation.y += dt * (pose === 'walk' ? 0 : 0.35)
    if (pose === 'walk') g.current.rotation.y = 0.5
  })
  return (
    <group ref={g}>
      <BeanBody look={look} state={state} />
    </group>
  )
}

export function AvatarStudio() {
  const [look, setLook] = useState<Look>(() => loadLook() ?? defaultLook())
  // Signed in with memory from your agent: jev picked an outfit from it. Put it on when you
  // arrive during onboarding or haven't designed a bean yet; you can change anything.
  const [dressed, setDressed] = useState(false)
  useEffect(() => {
    const onboarding = location.search.includes('onboard')
    if (!onboarding && loadLook()) return
    let live = true
    fetch('/api/look/suggested', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { look?: string | null } | null) => {
        if (!live || !d?.look) return
        setLook(decodeLook(d.look))
        setDressed(true)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  const [pose, setPose] = useState<'idle' | 'wave' | 'walk'>('idle')
  const [name, setName] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('gt.name') ?? '""') as string
    } catch {
      return ''
    }
  })
  // signed in on a new device: start from the name on your account, not an empty box
  useEffect(() => {
    fetchMe().then((me) => setName((n) => n || me.profile?.name || me.user?.given || ''))
  }, [])
  useEffect(() => {
    const prev = document.title
    document.title = 'Bean Studio · togethr'
    return () => {
      document.title = prev
    }
  }, [])
  const [cheer, setCheer] = useState(0)
  const [saved, setSaved] = useState(false)
  const set = (p: Partial<Look>) => setLook((l) => ({ ...l, ...p }))
  const play = () => {
    saveLook(look)
    // signed in: your account gets the new bean too (a guest's stays on this device)
    saveProfile({ name: name.trim() || 'Hacker', look: encodeLook(look) })
    setCheer((c) => c + 1) // one last happy jump before heading in
    setSaved(true)
    try {
      localStorage.setItem('gt.name', JSON.stringify(name.trim() || 'Hacker'))
    } catch {
      /* fine */
    }
    setTimeout(() => (location.href = '/play?cheer'), 1500)
  }

  return (
    <div className="studio">
      <div className="studio-stage">
        <Canvas shadows camera={{ position: [0, 2.2, 6.2], fov: 38 }} dpr={[1, 2]}>
          <color attach="background" args={['#ffe9f3']} />
          <hemisphereLight args={['#ffffff', '#ffd9e8', 1.6]} />
          <directionalLight position={[3, 6, 4]} intensity={1.6} castShadow shadow-mapSize={[1024, 1024]} />
          <Suspense fallback={null}>
            <Sparkles />
            <Podium />
            <Showcase look={look} pose={pose} cheer={cheer} />
          </Suspense>
          <OrbitControls target={[0, 1.3, 0]} enablePan={false} minDistance={3.5} maxDistance={9} minPolarAngle={0.5} maxPolarAngle={1.55} />
        </Canvas>
        {saved && <div className="studio-saved">Looking good! ✨</div>}
        <div className="studio-title">
          <span>{location.search.includes('onboard') ? 'Step 3 of 3 · Make your bean' : 'HackGT 13 · Seaside Market'}</span>
          <strong>Bean Studio</strong>
          {dressed && <em className="studio-dressed">Dressed from what your Muse remembers about you</em>}
        </div>
        <div className="studio-poses">
          {(['idle', 'wave', 'walk'] as const).map((p) => (
            <button key={p} className={pose === p ? 'on' : ''} onClick={() => setPose(p)}>
              {p === 'idle' ? '🧍 Idle' : p === 'wave' ? '👋 Wave' : '🚶 Walk'}
            </button>
          ))}
        </div>
      </div>

      <div className="studio-panel">
        <label className="studio-name">
          Name
          <input value={name} maxLength={16} placeholder="Bean" onChange={(e) => setName(e.target.value)} />
        </label>

        <section>
          <h3>Sponsor beans</h3>
          <div className="studio-chips">
            {SPONSOR_BEANS.map((sb) => (
              <button
                key={sb.id}
                className={look.logo === sb.id ? 'chip on' : 'chip'}
                style={{ borderColor: 'var(--ink)', background: look.logo === sb.id ? '#ffd23f' : sb.look.body, color: look.logo === sb.id ? 'var(--ink)' : inkOn(sb.look.body) }}
                onClick={() => setLook({ ...sb.look })}
              >
                {sb.name}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>Body</h3>
          <div className="studio-swatches">
            {BODY_COLORS.map((c) => (
              <button key={c} className={look.body === c ? 'sw on' : 'sw'} style={{ background: c }} onClick={() => set({ body: c })} aria-label={`body ${c}`} />
            ))}
          </div>
        </section>

        <section>
          <h3>Accent</h3>
          <div className="studio-swatches">
            {ACCENT_COLORS.map((c) => (
              <button key={c} className={look.accent === c ? 'sw on' : 'sw'} style={{ background: c }} onClick={() => set({ accent: c })} aria-label={`accent ${c}`} />
            ))}
          </div>
        </section>

        <section>
          <h3>Pattern</h3>
          <div className="studio-chips">
            {PATTERNS.map((p) => (
              <button key={p} className={look.pattern === p ? 'chip on' : 'chip'} onClick={() => set({ pattern: p })}>
                {LABEL[p]}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>Face</h3>
          <div className="studio-chips">
            {EYES.map((e) => (
              <button key={e} className={look.eyes === e ? 'chip on' : 'chip'} onClick={() => set({ eyes: e })}>
                {LABEL[e === 'dots' ? 'dots_e' : e]}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>Hat</h3>
          <div className="studio-chips">
            {HATS.map((h) => (
              <button key={h} className={look.hat === h ? 'chip on' : 'chip'} onClick={() => set({ hat: h })}>
                <span className="ico">{HAT_ICON[h]}</span> {LABEL[h]}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>Holding</h3>
          <div className="studio-chips">
            {ITEMS.map((it) => (
              <button key={it} className={look.item === it ? 'chip on' : 'chip'} onClick={() => set({ item: it })}>
                <span className="ico">{ITEM_ICON[it]}</span> {LABEL[it === 'none' ? 'i_none' : it]}
              </button>
            ))}
          </div>
        </section>

        <div className="studio-actions">
          <button className="studio-random" onClick={() => setLook(randomLook())}>🎲 Surprise me</button>
          <button className="studio-play" onClick={play}>Save &amp; play ▸</button>
        </div>
      </div>
    </div>
  )
}
