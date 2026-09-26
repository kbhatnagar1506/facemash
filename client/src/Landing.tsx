import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import * as THREE from 'three'
import { Scene, PAPER } from './landing/Scene'
import { Ln } from './landing/Copy'
import { layoutLines, reveal } from './landing/reveal'
import { SECTIONS } from './landing/path'
import { clamp } from './landing/physics'
import { frameFor, makeShared, type Frame } from './landing/shared'
import './landing.css'

// The landing page. The story is the problem statement, word for word, set in eight
// beats; a bean walks a winding path through a small 3D world as you scroll. Scrolling
// stays native: the page only smooths what the scroll drives (see landing/Scene.tsx).

const DPRS = [0.85, 1, 1.25, 1.5]

const GL = {
  antialias: true,
  alpha: false,
  stencil: false,
  powerPreference: 'high-performance' as const,
  toneMapping: THREE.NeutralToneMapping,
}

/** If WebGL is unavailable the story still reads; the stage just stays empty. */
class GLBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

function Chevron() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.75" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function BeanMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="7" y="2" width="18" height="28" rx="9" fill="#3B63C4" />
      <rect x="11.5" y="7.5" width="12" height="8" rx="4" fill="#fff" />
      <circle cx="15.5" cy="11.5" r="1.25" fill="#1B1D24" />
      <circle cx="19.5" cy="11.5" r="1.25" fill="#1B1D24" />
    </svg>
  )
}

export function Landing() {
  const shared = useMemo(makeShared, [])
  if (import.meta.env.DEV) (window as unknown as { __landing: unknown }).__landing = shared
  const root = useRef<HTMLDivElement>(null!)
  const nav = useRef<HTMLElement>(null!)
  const stage = useRef<HTMLDivElement>(null!)
  // resolution ladder: PerformanceMonitor steps down a rung while frames run long, back up when they recover
  const [q, setQ] = useState(DPRS.length - 1)
  const dpr = Math.min(devicePixelRatio || 1, DPRS[q])

  // page title and browser chrome colour while the landing is up
  useEffect(() => {
    const prev = document.title
    document.title = 'HackGT 13'
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    meta.content = PAPER
    document.head.appendChild(meta)
    return () => {
      document.title = prev
      meta.remove()
    }
  }, [])

  // reduced motion, live
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => {
      shared.reduced = mq.matches
    }
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [shared])

  // where each section's copy sits → scroll anchors and camera framings for the scene
  useLayoutEffect(() => {
    let lastW = 0
    let lastH = 0
    let raf = 0
    const measure = () => {
      raf = 0
      const W = innerWidth
      const H = innerHeight
      // the canvas spans the large viewport (100lvh); on phones innerHeight is the small one
      const CH = stage.current.clientHeight || H
      lastW = W
      lastH = H
      const isNarrow = W < 768
      shared.narrow = isNarrow
      const secs = root.current.querySelectorAll<HTMLElement>('[data-beat]')
      const sy = scrollY
      const maxScroll = Math.max(1, document.documentElement.scrollHeight - H)
      const navBottom = nav.current.getBoundingClientRect().bottom
      const anchors: number[] = []
      const frames: Frame[] = []
      for (let i = 0; i < secs.length; i++) {
        const el = secs[i]
        const r = el.getBoundingClientRect()
        // desktop: the section centred on screen; phone: its bottom (where the copy sits) at the bottom
        let a = clamp(isNarrow ? r.bottom + sy - H : r.top + sy + r.height / 2 - H / 2, 0, maxScroll)
        if (i === 0) a = 0
        if (i === secs.length - 1) a = maxScroll
        if (i > 0) a = Math.max(a, anchors[i - 1] + 1)
        anchors.push(a)
        const c = (el.querySelector('.copy') ?? el).getBoundingClientRect()
        const off = sy - a
        frames.push(frameFor(SECTIONS[i], { left: c.left, right: c.right, top: c.top + off, bottom: c.bottom + off }, W, H, CH, navBottom, isNarrow))
      }
      shared.anchors = anchors
      shared.maxScroll = maxScroll
      shared.frames = frames
      // line breaks may have moved: re-time the reveals that haven't played yet
      root.current.querySelectorAll<HTMLElement>('.copy:not(.in)').forEach(layoutLines)
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    measure()
    const onResize = () => {
      // the mobile toolbar sliding in and out is not a layout change
      if (innerWidth === lastW && Math.abs(innerHeight - lastH) < 120) return
      schedule()
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(root.current.querySelector('.landing-copy')!)
    addEventListener('resize', onResize)
    document.fonts?.ready.then(schedule)
    return () => {
      ro.disconnect()
      removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
    }
  }, [shared])

  // ready = fonts in and the first frame drawn (or a timeout): fade the stage up, reveal the headline.
  // Only while the page is visible: a background tab never mounts the scene, and the reveal
  // should play for someone who is looking.
  useEffect(() => {
    let fonts = false
    let frame = shared.framed
    let done = false
    let t1 = 0
    let t2 = 0
    const visible = () => document.visibilityState === 'visible'
    const go = () => {
      if (done || !fonts || !frame || !visible()) return
      done = true
      shared.readyAt = performance.now()
      root.current.classList.add('ready')
      const hero = root.current.querySelector<HTMLElement>('[data-beat="hero"] .copy')
      if (hero) reveal(hero)
    }
    shared.onFirstFrame = () => {
      frame = true
      go()
    }
    // the fallbacks start counting only once someone can see the page
    const arm = () => {
      if (!visible() || t1) return
      t1 = window.setTimeout(() => {
        fonts = true
        go()
      }, 1500)
      t2 = window.setTimeout(() => {
        frame = true
        go()
      }, 2800)
      go()
    }
    document.fonts?.ready.then(() => {
      fonts = true
      go()
    })
    document.addEventListener('visibilitychange', arm)
    arm()
    return () => {
      document.removeEventListener('visibilitychange', arm)
      clearTimeout(t1)
      clearTimeout(t2)
      shared.onFirstFrame = null
    }
  }, [shared])

  // every other section reveals once, as it comes up the screen
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          io.unobserve(e.target)
          reveal(e.target as HTMLElement)
        }
      },
      { rootMargin: '0px 0px -18% 0px', threshold: 0 },
    )
    root.current.querySelectorAll('[data-beat]:not([data-beat="hero"]) .copy').forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  return (
    <div className="landing" ref={root}>
      <div className="landing-stage" aria-hidden="true" ref={stage}>
        <GLBoundary>
          <Canvas
            dpr={dpr}
            shadows="percentage"
            gl={GL}
            camera={{ fov: 40, near: 0.1, far: 140, position: [0, 3, 9] }}
            onCreated={({ gl }) => {
              gl.toneMapping = THREE.NeutralToneMapping
            }}
          >
            <PerformanceMonitor
              bounds={(r) => (r > 90 ? [50, 90] : [54, 59])}
              flipflops={3}
              onIncline={() => setQ((x) => Math.min(DPRS.length - 1, x + 1))}
              onDecline={() => setQ((x) => Math.max(0, x - 1))}
              onFallback={() => setQ(1)}
            />
            <Scene shared={shared} />
          </Canvas>
        </GLBoundary>
      </div>
      <div className="scrim scrim-side" aria-hidden="true" ref={(el) => void (shared.scrimSide = el)} />
      <div className="scrim scrim-center" aria-hidden="true" ref={(el) => void (shared.scrimCenter = el)} />
      <div className="scrim scrim-bottom" aria-hidden="true" ref={(el) => void (shared.scrimBottom = el)} />
      <div className="scrim scrim-top" aria-hidden="true" />
      <div className="landing-progress" aria-hidden="true" ref={(el) => void (shared.progress = el)} />

      <header className="landing-nav" ref={nav}>
        <a className="brand" href="/">
          <BeanMark />
          HackGT 13
        </a>
        <nav className="nav-links" aria-label="Site">
          <a className="nav-link" href="/avatar">
            Make your bean
          </a>
          <a className="btn btn-secondary btn-sm" href="/play">
            Enter
            <Chevron />
          </a>
        </nav>
      </header>

      <main className="landing-copy">
        <section className="beat beat-hero" data-beat="hero">
          <div className="copy">
            <h1 className="rv">
              <Ln k="h">Think about your best friend.</Ln>
            </h1>
          </div>
          <div className="scroll-cue" aria-hidden="true" ref={(el) => void (shared.cue = el)} />
        </section>

        <section className="beat beat-story" data-beat="friend">
          <div className="copy">
            <p className="rv">
              <Ln k="b">{'Chances are you had no intention of meeting them, it was basically an accident. Same for your partner, your co-founder, the person who changed your career –'}</Ln>{' '}
              <Ln k="d">almost every relationship that matters, you got _by chance_.</Ln>
            </p>
          </div>
        </section>

        <section className="beat beat-story" data-beat="small">
          <div className="copy">
            <p className="rv">
              <Ln k="b">That used to be fine because _life was small_. You saw the same faces every day and serendipity did the work.</Ln>
            </p>
            <p className="rv">
              <Ln k="d">It doesn’t anymore.</Ln>
            </p>
          </div>
        </section>

        <section className="beat beat-story beat-tall" data-beat="crowd">
          <div className="copy">
            <p className="rv">
              <Ln k="lead">There are</Ln> <Ln k="num">1,000+</Ln>{' '}
              <Ln k="b">
                {
                  'people at HackGT right now, and there’s probably a handful of them who are _exactly who you need_ – someone building the thing you dream about, someone who’d end up being a close friend for the next twenty years.'
                }
              </Ln>
            </p>
            <p className="rv">
              <Ln k="b">And honestly you will _walk past every single one of them_, not because they’re hiding but because there’s no way to know they’re there and no natural way to find out.</Ln>
            </p>
          </div>
        </section>

        <section className="beat beat-statement" data-beat="strangers">
          <div className="copy">
            <p className="rv">
              <Ln k="s">Modern life didn’t really give us more connection, it gave us _more strangers_.</Ln>
            </p>
          </div>
        </section>

        <section className="beat beat-story" data-beat="bug">
          <div className="copy">
            <p className="rv">
              <Ln k="d">{'One of us has been to 33 hackathons and it’s the same story every time –'}</Ln>{' '}
              <Ln k="b">you find out on the Sunday afternoon that the person who had already fixed the exact bug you were stuck on was sat _two tables away_ all weekend.</Ln>
            </p>
          </div>
        </section>

        <section className="beat beat-story" data-beat="apps">
          <div className="copy">
            <p className="rv">
              <Ln k="d">We’ve all tried the event networking apps.</Ln>
            </p>
            <p className="rv">
              <Ln k="b">{'You get a directory and a percentage match, nobody opens them during the actual event, and {{“87% match”}} doesn’t tell you what to say to someone.'}</Ln>
            </p>
          </div>
        </section>

        <section className="beat beat-finale" data-beat="finale">
          <div className="copy">
            <p className="rv">
              <Ln k="lead">We wanted something that works while your phone stays in your pocket and your head stays up, and where the end result is</Ln>{' '}
              <Ln k="d">two people who’d both be glad to meet actually talking _face to face_,</Ln> <Ln k="b">not yet another chat app.</Ln>
            </p>
            <div className="ctas" data-ui="">
              <a className="btn btn-primary" href="/avatar">
                Make your bean
              </a>
              <a className="btn btn-secondary" href="/play">
                Enter HackGT 13
                <Chevron />
              </a>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
