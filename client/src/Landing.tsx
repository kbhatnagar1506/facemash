import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import * as THREE from 'three'
import { Scene, PAPER } from './landing/Scene'
import { Ln } from './landing/Copy'
import { layoutLines, reveal } from './landing/reveal'
import { SECTIONS } from './landing/path'
import { clamp } from './landing/physics'
import { frameFor, makeShared, type Frame } from './landing/shared'
import { SignInSheet } from './landing/SignIn'
import { fetchMe, signOut, type Me } from './account'
import { nextForMember } from './onboarding'
import './landing.css'

// The landing page. The story is the problem statement, word for word, set in eight
// beats; a bean walks a winding path through a small 3D world as you scroll. Scrolling
// stays native: the page only smooths what the scroll drives (see landing/Scene.tsx).

const DPRS = [0.85, 1, 1.25, 1.5]
// phones: a lower floor, and start a rung down (a 3x screen at 1.25 is still sharp)
const DPRS_PHONE = [0.75, 1, 1.25, 1.5]
const isPhone = () => matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600

/** Warm the HTTP cache with the next page's code (once per page), without running any of it. */
function prefetchRoute(href: string) {
  const files = (window as unknown as { __routeFiles?: Record<string, string[]> }).__routeFiles?.[new URL(href, location.href).pathname]
  const saveData = (navigator as unknown as { connection?: { saveData?: boolean } }).connection?.saveData
  if (!files || saveData) return
  for (const f of files) {
    if (document.head.querySelector(`link[href="${f}"]`)) continue
    const l = document.createElement('link')
    l.rel = 'prefetch'
    l.href = f
    document.head.appendChild(l)
  }
}
const onIntent = (e: { currentTarget: HTMLAnchorElement }) => prefetchRoute(e.currentTarget.href)

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

/** Signed in: your Google photo in the nav, with a way out. */
function AccountChip({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [open, setOpen] = useState(false)
  const u = me.user!
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    addEventListener('click', close)
    return () => removeEventListener('click', close)
  }, [open])
  return (
    <div className="acct">
      <button
        className="acct-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Signed in as ${u.name || u.email}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        {u.picture ? <img src={u.picture} alt="" referrerPolicy="no-referrer" /> : <span>{(u.given || u.name || u.email).slice(0, 1)}</span>}
      </button>
      {open && (
        <div className="acct-menu" role="menu">
          <div className="acct-who">
            <strong>{u.name}</strong>
            <span>{u.email}</span>
          </div>
          <a role="menuitem" href="/muse">
            Connect your Muse
          </a>
          <button type="button" role="menuitem" onClick={() => signOut().then(onSignedOut)}>
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

export function Landing() {
  const shared = useMemo(makeShared, [])
  // Enter asks you to sign in when sign-in is on and you aren't yet (there is no guest mode);
  // /play and /avatar send signed-out visitors here with ?signin to open it straight away
  const [me, setMe] = useState<Me | null>(null)
  const [sheet, setSheet] = useState(false)
  useEffect(() => {
    fetchMe().then((m) => {
      setMe(m)
      if (m.googleClientId && !m.user && new URLSearchParams(location.search).has('signin')) setSheet(true)
    })
  }, [])
  useEffect(() => {
    if (sheet) prefetchRoute('/play')
    if (!me?.user) return
    const t = setTimeout(() => prefetchRoute(nextForMember(me)), 4000)
    return () => clearTimeout(t)
  }, [me, sheet])
  const enter = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    if (me?.googleClientId && !me.user) {
      e.preventDefault()
      setSheet(true)
    } else if (me?.user) {
      // signed in: new accounts carry on with onboarding, everyone else goes straight in
      e.preventDefault()
      location.href = nextForMember(me)
    }
  }
  if (import.meta.env.DEV) (window as unknown as { __landing: unknown }).__landing = shared
  const root = useRef<HTMLDivElement>(null!)
  const nav = useRef<HTMLElement>(null!)
  const stage = useRef<HTMLDivElement>(null!)
  // resolution ladder: PerformanceMonitor steps down a rung while frames run long, back up when they recover
  const phone = useMemo(isPhone, [])
  const ladder = phone ? DPRS_PHONE : DPRS
  const [q, setQ] = useState(phone ? 2 : DPRS.length - 1)
  const dpr = Math.min(devicePixelRatio || 1, ladder[q])

  // page title and browser chrome colour while the landing is up
  useEffect(() => {
    const prev = document.title
    document.title = 'facemash · meet the right people at HackGT 13'
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
      // phones park each section's copy at the bottom of the screen: a short line (the
      // "strangers" beat) sits inside the bottom 18% there and would never play
      { rootMargin: innerWidth < 768 ? '0px 0px -4% 0px' : '0px 0px -18% 0px', threshold: 0 },
    )
    root.current.querySelectorAll('[data-beat]:not([data-beat="hero"]) .copy').forEach((el) => io.observe(el))
    // and a backstop on the section itself: once half of it is on screen its words play,
    // wherever the copy happens to rest (reveal() only plays once)
    const bySection = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          bySection.unobserve(e.target)
          const copy = e.target.querySelector<HTMLElement>('.copy')
          if (copy) reveal(copy)
        }
      },
      { threshold: 0.5 },
    )
    root.current.querySelectorAll('[data-beat]:not([data-beat="hero"])').forEach((el) => bySection.observe(el))
    return () => {
      io.disconnect()
      bySection.disconnect()
    }
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
              onIncline={() => setQ((x) => Math.min(ladder.length - 1, x + 1))}
              onDecline={() => setQ((x) => Math.max(0, x - 1))}
              onFallback={() => setQ(1)}
            />
            <Scene shared={shared} lite={phone} />
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
          facemash
        </a>
        <nav className="nav-links" aria-label="Site">
          <a className="nav-link" href="/avatar">
            Make your bean
          </a>
          {me?.user && <AccountChip me={me} onSignedOut={() => fetchMe().then(setMe)} />}
          <a className="btn btn-secondary btn-sm" href="/play" onClick={enter} onPointerDown={onIntent} onPointerEnter={onIntent}>
            Enter
            <Chevron />
          </a>
        </nav>
      </header>

      <main className="landing-copy">
        <section className="beat beat-hero" data-beat="hero">
          <div className="copy">
            <h1 className="rv">
              <Ln k="h">Imagine your loved ones.</Ln>
            </h1>
          </div>
          <div className="scroll-cue" aria-hidden="true" ref={(el) => void (shared.cue = el)} />
        </section>

        <section className="beat beat-story" data-beat="friend">
          <div className="copy">
            <p className="rv">
              <Ln k="b">{'Your closest friend. Your partner. The co-founder who took the leap with you. The mentor who opened a door –'}</Ln>{' '}
              <Ln k="d">almost none of them were planned. You met them _by accident_.</Ln>
            </p>
          </div>
        </section>

        <section className="beat beat-story" data-beat="small">
          <div className="copy">
            <p className="rv">
              <Ln k="b">For most of history, accidents were enough. You grew up among the same _few hundred faces_, and chance did the introducing.</Ln>
            </p>
            <p className="rv">
              <Ln k="d">The room got bigger.</Ln>
            </p>
          </div>
        </section>

        <section className="beat beat-story beat-tall" data-beat="crowd">
          <div className="copy">
            <p className="rv">
              <Ln k="lead">Right now there are</Ln> <Ln k="num">1,000+</Ln>{' '}
              <Ln k="b">
                {
                  'people at HackGT, and a few of them are _exactly who you need_ – someone building the thing you keep dreaming about, someone you’ll still be calling in twenty years.'
                }
              </Ln>
            </p>
            <p className="rv">
              <Ln k="b">And you’ll probably _walk right past them_. Not because they’re hiding, but because nothing tells you they’re there.</Ln>
            </p>
          </div>
        </section>

        <section className="beat beat-statement" data-beat="strangers">
          <div className="copy">
            <p className="rv">
              <Ln k="s">We didn’t get more connected. We got _more strangers_.</Ln>
            </p>
          </div>
        </section>

        <section className="beat beat-story" data-beat="bug">
          <div className="copy">
            <p className="rv">
              <Ln k="d">{'Every hackathon ends the same way –'}</Ln>{' '}
              <Ln k="b">on Sunday you find out the person who already fixed your exact bug was sitting _two tables away_ all weekend.</Ln>
            </p>
          </div>
        </section>

        <section className="beat beat-story" data-beat="apps">
          <div className="copy">
            <p className="rv">
              <Ln k="d">Networking apps tried.</Ln>
            </p>
            <p className="rv">
              <Ln k="b">{'A directory, a {{“87% match”}}, and nobody opens them once the event starts. A percentage never told anyone what to say.'}</Ln>
            </p>
          </div>
        </section>

        <section className="beat beat-finale" data-beat="finale">
          <div className="copy">
            <p className="rv">
              <Ln k="lead">So we built something that works while your phone stays in your pocket. Your agents talk first, and when it’s worth it,</Ln>{' '}
              <Ln k="d">two people meet _face to face_</Ln> <Ln k="b">with something real to say.</Ln>
            </p>
            <div className="ctas" data-ui="">
              <a className="btn btn-primary" href="/avatar" onPointerDown={onIntent} onPointerEnter={onIntent}>
                Make your bean
              </a>
              <a className="btn btn-secondary" href="/play" onClick={enter} onPointerDown={onIntent} onPointerEnter={onIntent}>
                Enter HackGT 13
                <Chevron />
              </a>
            </div>
          </div>
        </section>
      </main>

      {/* What the app is, in one line (also what Google's consent screen review reads) */}
      <footer className="about">
        <img src="/facemash-logo-66.png" alt="" width="22" height="22" loading="lazy" decoding="async" />
        <p>
          <b>facemash</b> helps HackGT 13 attendees find the people they'd be glad to meet. You sign in with Google so
          we can save your bean and progress; we only use your name and email for your account.
        </p>
        <nav aria-label="Legal">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
      </footer>
      {sheet && me?.googleClientId && <SignInSheet clientId={me.googleClientId} next={nextForMember} onClose={() => setSheet(false)} />}
    </div>
  )
}
