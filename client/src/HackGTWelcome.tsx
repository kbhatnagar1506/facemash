import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import './hackgt.css'

export interface Track {
  id: string
  name: string
  track: string
  blurb: string
  img: string
}

export interface ScheduleItem {
  item: string
  time: string
  start: string // "HH:MM", local event time
  end?: string
  where?: string
}

export interface EventInfo {
  title: string
  theme?: string
  tagline: string
  about?: string
  where: string
  when: string
  url: string
  tracks?: Track[]
  days?: { label: string; date: string; title: string; items: ScheduleItem[] }[]
}

type Panel = null | 'about' | 'tracks' | 'schedule'

/** Wooden info board over the market: About / Tracks / Schedule. */
export function InfoBoard({ event, panel, onClose }: { event: EventInfo; panel: Exclude<Panel, null>; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.code === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const [day, setDay] = useState(() => {
    const d = new Date() // local date, not UTC: evenings in Atlanta are already tomorrow in UTC
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return Math.max(0, event.days?.findIndex((d) => d.date === today) ?? 0)
  })
  return createPortal(
    <div className="hg-board-wrap" onClick={onClose}>
      <div className="hg-info" onClick={(e) => e.stopPropagation()}>
        <button className="hg-info-x" onClick={onClose} aria-label="Close">✕</button>
        {panel === 'about' && (
          <>
            <h2>About</h2>
            <h3>What is {event.title}?</h3>
            <p>{event.about ?? event.tagline}</p>
            <p className="hg-dim">{event.when} · {event.where}</p>
          </>
        )}
        {panel === 'tracks' && (
          <>
            <h2>Tracks</h2>
            <div className="hg-tracks">
              {event.tracks?.map((t) => (
                <div key={t.id} className="hg-track">
                  <img src={t.img} alt={t.name} />
                  <div>
                    <b>{t.name}</b>
                    <small>{t.track}</small>
                    <p>{t.blurb}</p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {panel === 'schedule' && event.days && (
          <>
            <h2>Schedule</h2>
            <div className="hg-days">
              {event.days.map((d, i) => (
                <button key={d.label} className={i === day ? 'on' : ''} aria-pressed={i === day} onClick={() => setDay(i)}>
                  {d.label}
                </button>
              ))}
            </div>
            <h3>{event.days[day].title}</h3>
            <ul className="hg-schedule">
              {event.days[day].items.map((s, i) => (
                <li key={i}>
                  <b>{s.item}</b>
                  <span>{s.time}{s.where ? ` · ${s.where}` : ''}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

export function HackGTWelcome({
  event, onClose, onEnter,
}: {
  event: EventInfo | null
  onClose: () => void
  onEnter: () => void
}) {
  const [panel, setPanel] = useState<Panel>(null)

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return
      if (panel) setPanel(null)
      else onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose, panel])

  const title = event?.title ?? 'HackGT'
  // Portal to <body> so it sits above drei's in-world HTML labels.
  return createPortal(
    <div className="hg" role="dialog" aria-label={`Welcome to ${title}`}>
      <div className="hg-sky">
        <div className="hg-cloud hg-cloud-1" />
        <div className="hg-cloud hg-cloud-2" />
        <div className="hg-cloud hg-cloud-3" />
        <svg className="hg-hills" viewBox="0 0 1200 200" preserveAspectRatio="none" aria-hidden>
          <path d="M0 200 L0 120 L90 60 L170 110 L260 40 L360 115 L470 75 L560 125 L700 55 L820 120 L930 70 L1040 120 L1200 80 L1200 200 Z" fill="#8fb3a8" />
          <path d="M0 200 L0 150 L120 105 L230 145 L380 100 L520 150 L660 110 L800 150 L960 115 L1100 150 L1200 130 L1200 200 Z" fill="#6f9c93" />
        </svg>
        <div className="hg-sea">
          <svg className="hg-boat" viewBox="0 0 60 60" aria-hidden>
            <path d="M30 4 L30 44 L10 44 Z" fill="#fff" />
            <path d="M33 12 L33 44 L48 44 Z" fill="#e9f3ff" />
            <path d="M6 46 L54 46 L46 54 L14 54 Z" fill="#35415e" />
          </svg>
        </div>
      </div>
      <div className="hg-dock" />

      <img className="hg-side hg-side-l" src="/hackgt/leftstall.png" alt="" />
      <img className="hg-side hg-side-r" src="/hackgt/rightstall.png" alt="" />

      <nav className="hg-nav">
        <img className="hg-logo" src="/hackgt/logo.svg" alt={`${title} logo`} />
        <div className="hg-nav-links">
          <button onClick={() => setPanel('about')}>About</button>
          <button onClick={() => setPanel('tracks')}>Tracks</button>
          <button onClick={() => setPanel('schedule')}>Schedule</button>
          <button className="hg-nav-back" onClick={onClose}>Back to campus</button>
        </div>
      </nav>

      <div className="hg-welcome">Welcome to {title}!</div>

      <div className="hg-stage">
        <img className="hg-stall" src="/hackgt/stall.png" alt={`${title} Seaside Market stall`} />
        <button className="hg-enter" onClick={onEnter} aria-label={`Register — enter ${title}`}>
          <img src="/hackgt/register.png" alt="" />
        </button>
      </div>

      {panel && event && <InfoBoard event={event} panel={panel} onClose={() => setPanel(null)} />}
    </div>,
    document.body,
  )
}
