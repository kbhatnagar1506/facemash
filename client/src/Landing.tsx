import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { BeanBody } from './Bean'
import type { AvatarState } from './Avatar'
import type { Look } from './look'
import './landing.css'

// The landing page: your bean walks down a winding path as you scroll, through the
// story of why we built this. Scroll progress drives everything in the 3D scene;
// the copy sits in normal HTML sections on top.

const HERO: Look = { body: '#3b63c4', accent: '#ffffff', pattern: 'solid', eyes: 'dots', hat: 'headphones', item: 'phone', logo: 'hackgt' }
const FRIEND: Look = { body: '#ff7eb6', accent: '#ffffff', pattern: 'hearts', eyes: 'happy', hat: 'bunny', item: 'boba' }
const MATCH: Look = { body: '#ffc93c', accent: '#ff5d6c', pattern: 'solid', eyes: 'star', hat: 'cap', item: 'laptop' }
const SMALL: Look[] = [
  { body: '#7ad36b', accent: '#ffffff', pattern: 'solid', eyes: 'dots', hat: 'none', item: 'coffee' },
  { body: '#9b6bd1', accent: '#ffe066', pattern: 'stripes', eyes: 'happy', hat: 'party', item: 'none' },
  { body: '#ff8a3d', accent: '#ffffff', pattern: 'split', eyes: 'wink', hat: 'crown', item: 'none' },
  { body: '#2bb3a6', accent: '#ffffff', pattern: 'dots', eyes: 'dots', hat: 'propeller', item: 'duck' },
]

/* ------------------------------------------------------------------ path */

// A long S-curve heading "down" the page (toward -z). s ∈ [0,1].
const LEN = 150
const path = new THREE.CatmullRomCurve3(
  [
    [0, 0, 0],
    [4, 0, -18],
    [-4, 0, -38],
    [5, 0, -58],
    [-3, 0, -80],
    [4, 0, -102],
    [-2, 0, -124],
    [0, 0, -LEN],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  false,
  'centripetal',
)
const at = (s: number) => path.getPointAt(THREE.MathUtils.clamp(s, 0, 1))

// scene beats along the path (fractions of the walk), matched to the copy sections
const BEAT = { friend: 0.16, small: 0.33, crowd: 0.5, bug: 0.7, apps: 0.84, meet: 0.985 }

/* --------------------------------------------------------------- scene bits */

function useScroll() {
  const p = useRef(0) // 0..1 target
  useEffect(() => {
    const on = () => {
      const max = document.documentElement.scrollHeight - innerHeight
      p.current = max > 0 ? scrollY / max : 0
    }
    on()
    addEventListener('scroll', on, { passive: true })
    addEventListener('resize', on)
    return () => {
      removeEventListener('scroll', on)
      removeEventListener('resize', on)
    }
  }, [])
  return p
}

/** A bean standing somewhere, facing a direction, with its own little life. */
function Extra({ look, pos, face = 0, wave = false, cheerAt, scale = 1 }: { look: Look; pos: THREE.Vector3; face?: number; wave?: boolean; cheerAt?: React.MutableRefObject<number>; scale?: number }) {
  const state = useRef<AvatarState>({ moving: false, wave })
  const g = useRef<THREE.Group>(null!)
  useFrame(({ clock }) => {
    state.current.wave = wave && Math.sin(clock.elapsedTime * 1.3 + pos.x) > 0.2
    if (cheerAt && cheerAt.current > 0) state.current.cheer = cheerAt.current
  })
  return (
    <group ref={g} position={pos} rotation-y={face} scale={scale}>
      <BeanBody look={look} state={state} />
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, 0]}>
        <circleGeometry args={[0.75, 24]} />
        <meshBasicMaterial color="#000" transparent opacity={0.12} depthWrite={false} />
      </mesh>
    </group>
  )
}

/** The crowd: hundreds of simple beans ("strangers") packed around the path, plus a
 *  handful that glow gold — the people you actually need, lost in the sea. */
function Crowd({ progress }: { progress: React.MutableRefObject<number> }) {
  const body = useRef<THREE.InstancedMesh>(null!)
  const visor = useRef<THREE.InstancedMesh>(null!)
  const N = 520
  const geo = useMemo(() => {
    const b = new THREE.CapsuleGeometry(0.64, 0.66, 6, 14)
    b.scale(1, 1, 0.9)
    b.translate(0, 1.27, 0)
    const v = new THREE.SphereGeometry(1, 12, 8)
    v.scale(0.46, 0.37, 0.21)
    v.translate(0, 1.66, 0.43)
    return { b, v }
  }, [])
  const people = useMemo(() => {
    const out: { p: THREE.Vector3; r: number; gold: boolean; ph: number }[] = []
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    while (out.length < N) {
      const s = BEAT.crowd - 0.1 + rnd() * 0.24
      const c = at(s)
      const side = (rnd() - 0.5) * 34
      if (Math.abs(side) < 4.8) continue // keep a clear lane so you can see yourself walk through
      out.push({ p: new THREE.Vector3(c.x + side, 0, c.z + (rnd() - 0.5) * 3), r: rnd() * Math.PI * 2, gold: out.length % 97 === 13, ph: rnd() * 10 })
    }
    return out
  }, [])
  useEffect(() => {
    const m = new THREE.Matrix4()
    const c = new THREE.Color()
    people.forEach((q, i) => {
      m.makeRotationY(q.r).setPosition(q.p)
      body.current.setMatrixAt(i, m)
      visor.current.setMatrixAt(i, m)
      body.current.setColorAt(i, q.gold ? c.set('#ffc93c') : c.setHSL(0.6 + (i % 7) * 0.02, 0.08, 0.62 + (i % 5) * 0.04))
    })
    body.current.instanceMatrix.needsUpdate = visor.current.instanceMatrix.needsUpdate = true
    if (body.current.instanceColor) body.current.instanceColor.needsUpdate = true
  }, [people])
  const m = useMemo(() => new THREE.Matrix4(), [])
  const q = useMemo(() => new THREE.Quaternion(), [])
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), [])
  const one = useMemo(() => new THREE.Vector3(1, 1, 1), [])
  const tmp = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ clock }) => {
    // the crowd rises up out of the ground as you arrive, and idles (a little bob)
    const k = THREE.MathUtils.smoothstep(progress.current, BEAT.crowd - 0.2, BEAT.crowd - 0.08)
    const t = clock.elapsedTime
    people.forEach((pp, i) => {
      q.setFromAxisAngle(up, pp.r + Math.sin(t * 0.5 + pp.ph) * 0.3)
      tmp.set(pp.p.x, (k - 1) * 3 + Math.abs(Math.sin(t * 2 + pp.ph)) * 0.05, pp.p.z)
      m.compose(tmp, q, one.setScalar(0.85))
      body.current.setMatrixAt(i, m)
      visor.current.setMatrixAt(i, m)
    })
    body.current.instanceMatrix.needsUpdate = visor.current.instanceMatrix.needsUpdate = true
  })
  return (
    <>
      <instancedMesh ref={body} args={[geo.b, undefined, N]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.45} />
      </instancedMesh>
      <instancedMesh ref={visor} args={[geo.v, undefined, N]} frustumCulled={false}>
        <meshStandardMaterial color="#ffffff" roughness={0.3} emissive="#dcdcd6" />
      </instancedMesh>
    </>
  )
}

/** Floating icon above a spot (bug, idea, match card) that pops in near its beat. */
function Sign({ pos, text, color, beat, progress, w = 1.6 }: { pos: THREE.Vector3; text: string; color: string; beat: number; progress: React.MutableRefObject<number>; w?: number }) {
  const s = useRef<THREE.Sprite>(null!)
  const map = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = 512
    c.height = 256
    const g = c.getContext('2d')!
    g.fillStyle = color
    g.beginPath()
    g.roundRect(8, 8, 496, 200, 60)
    g.fill()
    g.beginPath()
    g.moveTo(230, 206)
    g.lineTo(256, 250)
    g.lineTo(282, 206)
    g.fill()
    g.fillStyle = '#1f2430'
    g.font = '900 96px Nunito, Arial'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, 256, 112)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [text, color])
  useFrame(({ clock }) => {
    const k = THREE.MathUtils.smoothstep(progress.current, beat - 0.07, beat - 0.02)
    const sc = k * w
    s.current.scale.set(sc, sc / 2, 1)
    s.current.position.set(pos.x, pos.y + Math.sin(clock.elapsedTime * 2 + pos.x) * 0.08, pos.z)
  })
  return (
    <sprite ref={s}>
      <spriteMaterial map={map} transparent depthWrite={false} />
    </sprite>
  )
}

/** A dotted line between two points that draws itself in as you scroll past `beat`. */
function Thread({ a, b, beat, progress, color = '#ff5d6c' }: { a: THREE.Vector3; b: THREE.Vector3; beat: number; progress: React.MutableRefObject<number>; color?: string }) {
  const g = useRef<THREE.Group>(null!)
  const dots = 18
  useFrame(({ clock }) => {
    const k = THREE.MathUtils.smoothstep(progress.current, beat - 0.04, beat + 0.02)
    g.current.children.forEach((c, i) => {
      const f = i / (dots - 1)
      c.visible = f <= k
      c.position.lerpVectors(a, b, f)
      c.position.y = 1.9 + Math.sin(f * Math.PI) * 1.2 + Math.sin(clock.elapsedTime * 4 - i * 0.6) * 0.04
    })
  })
  return (
    <group ref={g}>
      {Array.from({ length: dots }, (_, i) => (
        <mesh key={i}>
          <sphereGeometry args={[0.07, 8, 6]} />
          <meshBasicMaterial color={color} />
        </mesh>
      ))}
    </group>
  )
}

/** Soft pastel ground: a big disc with a painted winding path you walk along. */
function Ground() {
  const pathGeo = useMemo(() => {
    const pts = path.getSpacedPoints(300)
    const pos: number[] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      const d = new THREE.Vector3().subVectors(b, a).normalize()
      const n = new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(1.3)
      const p1 = a.clone().add(n)
      const p2 = a.clone().sub(n)
      const p3 = b.clone().add(n)
      const p4 = b.clone().sub(n)
      pos.push(p1.x, 0.01, p1.z, p2.x, 0.01, p2.z, p3.x, 0.01, p3.z, p2.x, 0.01, p2.z, p4.x, 0.01, p4.z, p3.x, 0.01, p3.z)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.computeVertexNormals()
    return g
  }, [])
  const dashGeo = useMemo(() => {
    const pts = path.getSpacedPoints(160)
    const pos: number[] = []
    for (let i = 0; i < pts.length - 1; i += 2) {
      const a = pts[i]
      const b = pts[i + 1]
      pos.push(a.x, 0.02, a.z, b.x, 0.02, b.z)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    return g
  }, [])
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0, -LEN / 2]} receiveShadow>
        <planeGeometry args={[220, LEN + 120]} />
        <meshBasicMaterial color="#ffdcea" toneMapped={false} />
      </mesh>
      <mesh geometry={pathGeo} receiveShadow>
        <meshBasicMaterial color="#fffafc" side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <lineSegments geometry={dashGeo}>
        <lineBasicMaterial color="#ffb3cf" />
      </lineSegments>
    </group>
  )
}

/** Pastel confetti bits floating in the air everywhere. */
function Confetti() {
  const mesh = useRef<THREE.InstancedMesh>(null!)
  const N = 220
  const bits = useMemo(() => {
    let seed = 3
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    return Array.from({ length: N }, () => ({ x: (rnd() - 0.5) * 60, y: 1 + rnd() * 9, z: 10 - rnd() * (LEN + 30), r: rnd() * 6, s: 0.08 + rnd() * 0.12 }))
  }, [])
  useEffect(() => {
    const c = new THREE.Color()
    const cols = ['#ff8fb1', '#ffd23f', '#7ad36b', '#3fc5f0', '#b58be0', '#ff8a3d']
    bits.forEach((_, i) => mesh.current.setColorAt(i, c.set(cols[i % cols.length])))
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true
  }, [bits])
  const m = useMemo(() => new THREE.Matrix4(), [])
  const e = useMemo(() => new THREE.Euler(), [])
  const q = useMemo(() => new THREE.Quaternion(), [])
  const v = useMemo(() => new THREE.Vector3(), [])
  const sc = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    bits.forEach((b, i) => {
      e.set(t * 0.7 + b.r, t * 0.9 + b.r, 0)
      q.setFromEuler(e)
      v.set(b.x + Math.sin(t * 0.3 + b.r) * 0.6, b.y + Math.sin(t * 0.6 + b.r) * 0.4, b.z)
      m.compose(v, q, sc.setScalar(b.s))
      mesh.current.setMatrixAt(i, m)
    })
    mesh.current.instanceMatrix.needsUpdate = true
  })
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, N]} frustumCulled={false}>
      <boxGeometry args={[1.4, 1.4, 0.3]} />
      <meshBasicMaterial />
    </instancedMesh>
  )
}

/* ------------------------------------------------------------- the walker */

function Walker({ progress }: { progress: React.MutableRefObject<number> }) {
  const g = useRef<THREE.Group>(null!)
  const state = useRef<AvatarState>({ moving: false })
  const s = useRef(0)
  const { camera, size } = useThree()
  const look = useMemo(() => new THREE.Vector3(), [])
  const camPos = useMemo(() => new THREE.Vector3(), [])
  const met = useRef(false)
  const sideRef = useRef(0)
  useFrame((_, dt) => {
    // ease the walk toward the scroll position; walking animation while catching up
    const target = progress.current * 0.985
    const prev = s.current
    s.current += (target - s.current) * Math.min(1, dt * 3.2)
    const speed = Math.abs(s.current - prev) / Math.max(dt, 1e-3)
    state.current.moving = speed > 0.004
    const p = at(s.current)
    const ahead = at(Math.min(1, s.current + 0.004))
    g.current.position.copy(p)
    const facing = speed > 0.004 ? Math.atan2(ahead.x - p.x, ahead.z - p.z) : Math.atan2(camera.position.x - p.x, camera.position.z - p.z)
    g.current.rotation.y += Math.atan2(Math.sin(facing - g.current.rotation.y), Math.cos(facing - g.current.rotation.y)) * Math.min(1, dt * 6)
    // the big finish: reach the golden bean and both celebrate
    if (!met.current && s.current > BEAT.meet - 0.02) {
      met.current = true
      state.current.cheer = performance.now()
    } else if (met.current && s.current < BEAT.meet - 0.05) met.current = false
    // camera: behind-and-above, bean kept on the side opposite the copy
    const narrow = size.width < 820
    // opening shot: bean centred low under the headline; then it walks on the side
    // opposite each block of copy
    const hero = 1 - THREE.MathUtils.smoothstep(s.current, 0.01, 0.07)
    // which side of the screen is free for each beat (the copy card takes the other side)
    const want = narrow ? 0 : s.current < 0.08 ? 0 : s.current < 0.245 ? 1 : s.current < 0.41 ? -1 : s.current < 0.77 ? 1 : s.current < 0.92 ? -1 : 0
    sideRef.current += (want - sideRef.current) * Math.min(1, dt * 2.5)
    const side = sideRef.current * (1 - hero)
    camPos.set(p.x + side * 2.2, p.y + (narrow ? 5.5 : 4.6) + hero * 1.2, p.z + (narrow ? 11 : 9.5) + hero * 1.5)
    camera.position.lerp(camPos, 1 - Math.exp(-dt * 4))
    look.lerp(new THREE.Vector3(p.x - side * 2.6, p.y + 1.4 + hero * 3.4, p.z - 2 - hero * 2), 1 - Math.exp(-dt * 4))
    camera.lookAt(look)
  })
  return (
    <group ref={g}>
      <BeanBody look={HERO} state={state} />
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, 0]}>
        <circleGeometry args={[0.8, 24]} />
        <meshBasicMaterial color="#000" transparent opacity={0.14} depthWrite={false} />
      </mesh>
    </group>
  )
}

function Scene({ progress }: { progress: React.MutableRefObject<number> }) {
  const friendPos = useMemo(() => {
    const p = at(BEAT.friend)
    return new THREE.Vector3(p.x + 1.6, 0, p.z - 0.4)
  }, [])
  const small = useMemo(() => {
    const c = at(BEAT.small)
    return SMALL.map((l, i) => {
      const a = (i / SMALL.length) * Math.PI * 2 + 0.4
      return { l, p: new THREE.Vector3(c.x + Math.cos(a) * 3.4, 0, c.z + Math.sin(a) * 3.4), f: Math.atan2(-Math.cos(a), -Math.sin(a)) }
    })
  }, [])
  const bug = useMemo(() => {
    const c = at(BEAT.bug)
    return { me: new THREE.Vector3(c.x + 2.6, 0, c.z - 1.5), them: new THREE.Vector3(c.x + 8.5, 0, c.z - 5) }
  }, [])
  const meet = useMemo(() => {
    const c = at(0.999)
    return new THREE.Vector3(c.x, 0, c.z - 1.6)
  }, [])
  const matchCheer = useRef(0)
  useFrame(() => {
    if (progress.current > BEAT.meet - 0.02 && matchCheer.current === 0) matchCheer.current = performance.now()
    else if (progress.current < BEAT.meet - 0.05) matchCheer.current = 0
  })
  return (
    <>
      <color attach="background" args={['#ffe9f3']} />
      <fog attach="fog" args={['#ffe9f3', 26, 70]} />
      <hemisphereLight args={['#ffffff', '#ffd9e8', 1.5]} />
      <directionalLight position={[6, 12, 8]} intensity={1.7} />
      <Ground />
      <Confetti />
      <Walker progress={progress} />
      {/* 1. the friend you met by accident */}
      <Extra look={FRIEND} pos={friendPos} face={-Math.PI / 2} wave />
      <Sign pos={new THREE.Vector3(friendPos.x, 3.6, friendPos.z)} text="👋 hi!" color="#ffffff" beat={BEAT.friend} progress={progress} />
      {/* 2. life was small: the same few faces */}
      {small.map((q, i) => (
        <Extra key={i} look={q.l} pos={q.p} face={q.f} wave={i % 2 === 0} />
      ))}
      {/* 3. a thousand strangers */}
      <Crowd progress={progress} />
      {/* 4. stuck on a bug, the fix two tables away */}
      <Extra look={{ ...SMALL[0], body: '#8e9aaf', item: 'laptop' }} pos={bug.me} face={1.2} />
      <Sign pos={new THREE.Vector3(bug.me.x, 3.5, bug.me.z)} text="🐛 stuck" color="#ffd6dc" beat={BEAT.bug} progress={progress} />
      <Extra look={{ ...SMALL[3], item: 'laptop' }} pos={bug.them} face={-1.9} />
      <Sign pos={new THREE.Vector3(bug.them.x, 3.5, bug.them.z)} text="💡 fixed it" color="#fff1b8" beat={BEAT.bug + 0.03} progress={progress} />
      <Thread a={bug.me} b={bug.them} beat={BEAT.bug + 0.05} progress={progress} />
      {/* 5. the networking app you never open */}
      <Sign pos={new THREE.Vector3(at(BEAT.apps).x - 2.2, 3.4, at(BEAT.apps).z - 6)} text="87% match?" color="#e6ecff" beat={BEAT.apps} progress={progress} w={1.25} />
      {/* 6. face to face */}
      <Extra look={MATCH} pos={meet} face={0} cheerAt={matchCheer} />
      <Sign pos={new THREE.Vector3(meet.x, 3.9, meet.z + 0.8)} text="✨ hey!" color="#fff1b8" beat={BEAT.meet} progress={progress} />
    </>
  )
}

/* ------------------------------------------------------------------ page */

function Reveal({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const r = useRef<HTMLDivElement>(null!)
  const [on, setOn] = useState(false)
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setOn(true), { threshold: 0.25 })
    io.observe(r.current)
    return () => io.disconnect()
  }, [])
  return (
    <div ref={r} className={`reveal ${on ? 'in' : ''} ${className}`}>
      {children}
    </div>
  )
}

function Counter({ to }: { to: number }) {
  const r = useRef<HTMLSpanElement>(null!)
  const [n, setN] = useState(0)
  useEffect(() => {
    let raf = 0
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return
      io.disconnect()
      const t0 = performance.now()
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / 1400)
        setN(Math.round(to * (1 - (1 - k) ** 3)))
        if (k < 1) raf = requestAnimationFrame(step)
      }
      step()
    })
    io.observe(r.current)
    return () => {
      io.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [to])
  return <span ref={r}>{n.toLocaleString()}</span>
}

export function Landing() {
  const progress = useScroll()
  const bar = useRef<HTMLDivElement>(null!)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (bar.current) bar.current.style.transform = `scaleX(${progress.current})`
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [progress])
  return (
    <div className="landing">
      <div className="landing-stage">
        <Canvas camera={{ position: [0, 5, 10], fov: 42 }} dpr={[1, 1.75]}>
          <Scene progress={progress} />
        </Canvas>
      </div>
      <div className="landing-progress" ref={bar} />
      <nav className="landing-nav">
        <a className="brand" href="/">
          <span className="dot" /> HackGT 13
        </a>
        <div className="nav-links">
          <a href="/avatar">Make your bean</a>
          <a className="cta small" href="/play">Enter ▸</a>
        </div>
      </nav>

      <main className="landing-copy">
        <section className="beat hero">
          <Reveal>
            <p className="kicker">HackGT 13 · Klaus Atrium</p>
            <h1>
              Every relationship that matters <em>started by accident.</em>
            </h1>
            <p className="lead">Your best friend. Your co-founder. The person who changed your career.</p>
            <div className="scroll-hint">
              <span>scroll</span>
              <i />
            </div>
          </Reveal>
        </section>

        <section className="beat left">
          <Reveal className="card">
            <h2>Think about your best friend.</h2>
            <p>
              Chances are you had no intention of meeting them. It was basically an accident. Same for your partner, your
              co-founder, the person who changed your career: almost every relationship that matters, you got <b>by chance</b>.
            </p>
          </Reveal>
        </section>

        <section className="beat right">
          <Reveal className="card">
            <h2>Life used to be small.</h2>
            <p>
              That used to be fine. You saw the same faces every day, and serendipity did the work. <b>It doesn't anymore.</b>
            </p>
          </Reveal>
        </section>

        <section className="beat left tall">
          <Reveal className="card">
            <p className="big-stat">
              <Counter to={1000} />+
            </p>
            <h2>people at HackGT right now.</h2>
            <p>
              There's probably a handful of them who are exactly who you need: someone building the thing you dream about,
              someone who'd be a close friend for the next twenty years.
            </p>
            <p>
              And honestly, you will walk past every single one of them. Not because they're hiding, but because there's no
              way to know they're there, and no natural way to find out.
            </p>
            <p className="pull">Modern life didn't give us more connection. It gave us more strangers.</p>
          </Reveal>
        </section>

        <section className="beat left">
          <Reveal className="card">
            <p className="big-stat small">33 hackathons.</p>
            <h2>Same story every time.</h2>
            <p>
              You find out on Sunday afternoon that the person who'd already fixed the exact bug you were stuck on was sitting
              <b> two tables away</b> all weekend.
            </p>
          </Reveal>
        </section>

        <section className="beat right">
          <Reveal className="card">
            <h2>“87% match” doesn't tell you what to say.</h2>
            <p>
              We've all tried the event networking apps. You get a directory and a percentage, and nobody opens them during the
              actual event.
            </p>
          </Reveal>
        </section>

        <section className="beat finale">
          <Reveal className="card finale-card">
            <p className="kicker">So we built something different</p>
            <h2>
              Phone in your pocket. <em>Head up.</em>
            </h2>
            <p className="lead">
              It works while you're living the event, and the end result is two people who'd both be glad to meet, actually
              talking face to face. Not another chat app.
            </p>
            <div className="ctas">
              <a className="cta" href="/avatar">
                Make your bean ✨
              </a>
              <a className="cta ghost" href="/play">
                Enter HackGT 13 ▸
              </a>
            </div>
          </Reveal>
        </section>
      </main>
    </div>
  )
}
