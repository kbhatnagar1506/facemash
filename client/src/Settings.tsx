import { useEffect, useMemo, useState } from 'react'
import './landing.css'

// Settings: everything your agent sent about you (a Muse upload, or your voice answers), to
// read and edit. Saving goes through the same door as an upload on the server (credentials
// scrubbed, then stored and re-indexed), so your agent talks from what you left here.
// Fields we don't know are kept as they were.

type Note = { date: string; content: string }
type Memory = Record<string, unknown> & {
  user_md?: string
  memory_md?: string
  daily_notes?: Note[]
  bank?: Record<string, string>
}

const BANK: { key: string; label: string; hint: string }[] = [
  { key: 'experience', label: 'Experience', hint: 'What you have done and built' },
  { key: 'opinions', label: 'Opinions', hint: 'What you think about things' },
  { key: 'reflections', label: 'Reflections', hint: 'What you have learned' },
  { key: 'world', label: 'World', hint: 'Facts about your world' },
]

const asText = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join('\n\n') : v == null ? '' : JSON.stringify(v, null, 2))

function Field({ label, hint, value, onChange, rows = 4 }: { label: string; hint?: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <label className="set-field">
      <span className="set-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <textarea value={value} rows={Math.max(rows, Math.min(18, value.split('\n').length + 1))} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

export default function Settings() {
  const [state, setState] = useState<'loading' | 'signin' | 'empty' | 'ready' | 'error'>('loading')
  const [mem, setMem] = useState<Memory>({})
  const [dirty, setDirty] = useState(false)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    document.title = 'Settings · togethr'
    fetch('/api/me/memory', { credentials: 'same-origin' })
      .then(async (r) => {
        if (r.status === 401) return setState('signin')
        if (!r.ok) return setState('error')
        const j = (await r.json()) as { stored: boolean; memory?: Memory }
        if (!j.stored || !j.memory) return setState('empty')
        const m = { ...j.memory }
        m.bank = Object.fromEntries(Object.entries((m.bank as Record<string, unknown>) ?? {}).map(([k, v]) => [k, asText(v)]))
        m.daily_notes = (Array.isArray(m.daily_notes) ? m.daily_notes : []).map((n) => ({ date: asText((n as Note).date), content: asText((n as Note).content) }))
        m.user_md = asText(m.user_md)
        m.memory_md = asText(m.memory_md)
        setMem(m)
        setState('ready')
      })
      .catch(() => setState('error'))
  }, [])

  const set = (patch: Partial<Memory>) => {
    setMem((m) => ({ ...m, ...patch }))
    setDirty(true)
  }
  const notes = mem.daily_notes ?? []
  const setNoteAt = (i: number, n: Note | null) => set({ daily_notes: n ? notes.map((x, k) => (k === i ? n : x)) : notes.filter((_, k) => k !== i) })
  const source = useMemo(() => (mem.source === 'voice' ? 'your voice answers' : 'your Muse agent'), [mem.source])

  const save = async () => {
    setSaving(true)
    setNote('')
    const r = await fetch('/api/me/memory', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memory: mem }),
    }).catch(() => null)
    setSaving(false)
    if (!r?.ok) return setNote("Couldn't save just now. Try again?")
    const j = (await r.json()) as { redacted?: number }
    setDirty(false)
    setNote(j.redacted ? `Saved. ${j.redacted} sensitive item${j.redacted === 1 ? ' was' : 's were'} removed (passwords, keys, card numbers).` : 'Saved. Your agent uses this now.')
  }
  const erase = async () => {
    if (!confirm('Delete everything your agent sent? This cannot be undone.')) return
    const r = await fetch('/api/muse/memory', { method: 'DELETE', credentials: 'same-origin' }).catch(() => null)
    if (r?.ok) {
      setMem({})
      setState('empty')
    }
  }

  return (
    <div className="landing muse-page">
      <header className="muse-nav">
        <a className="brand" href="/">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect x="7" y="2" width="18" height="28" rx="9" fill="#3B63C4" />
            <rect x="11.5" y="7.5" width="12" height="8" rx="4" fill="#fff" />
            <circle cx="15.5" cy="11.5" r="1.25" fill="#1B1D24" />
            <circle cx="19.5" cy="11.5" r="1.25" fill="#1B1D24" />
          </svg>
          togethr
        </a>
      </header>
      <main className="muse-main">
        <section className="muse-card set-card">
          <h1>Your memory</h1>
          {state === 'loading' && <p className="muse-sub">Loading…</p>}
          {state === 'signin' && (
            <>
              <p className="muse-sub">Sign in to see and edit what your agent knows about you.</p>
              <a className="btn btn-primary muse-wide" href="/?signin">
                Sign in
              </a>
            </>
          )}
          {state === 'error' && <p className="muse-error">Couldn't load your memory. Try again in a moment.</p>}
          {state === 'empty' && (
            <>
              <p className="muse-sub">Nothing here yet. Connect your Muse agent, or answer five questions out loud, and it shows up here to edit.</p>
              <a className="btn btn-primary muse-wide" href="/muse">
                Connect Muse or use voice
              </a>
            </>
          )}
          {state === 'ready' && (
            <>
              <p className="muse-sub">
                This is what {source} told us about you. Edit anything: your agent talks from exactly this. Only you can see it.
              </p>
              <div className="set-form">
                <Field label="About me" hint="Who you are, in your words" value={mem.user_md ?? ''} onChange={(v) => set({ user_md: v })} rows={5} />
                <Field label="Memory" hint="What your agent remembers" value={mem.memory_md ?? ''} onChange={(v) => set({ memory_md: v })} rows={5} />
                {BANK.map((b) => (
                  <Field key={b.key} label={b.label} hint={b.hint} value={mem.bank?.[b.key] ?? ''} onChange={(v) => set({ bank: { ...(mem.bank ?? {}), [b.key]: v } })} rows={3} />
                ))}
                <div className="set-notes">
                  <span className="set-label">
                    Daily notes<small>{notes.length} note{notes.length === 1 ? '' : 's'}</small>
                  </span>
                  {notes.map((n, i) => (
                    <div className="set-note" key={i}>
                      <div className="set-note-top">
                        <input value={n.date} placeholder="Date" onChange={(e) => setNoteAt(i, { ...n, date: e.target.value })} aria-label="Note date" />
                        <button type="button" className="muse-link" onClick={() => setNoteAt(i, null)}>
                          Remove
                        </button>
                      </div>
                      <textarea value={n.content} rows={Math.min(12, n.content.split('\n').length + 1)} onChange={(e) => setNoteAt(i, { ...n, content: e.target.value })} aria-label="Note" />
                    </div>
                  ))}
                  <button type="button" className="btn btn-secondary" onClick={() => set({ daily_notes: [...notes, { date: new Date().toISOString().slice(0, 10), content: '' }] })}>
                    + Add a note
                  </button>
                </div>
              </div>
              <div className="set-save">
                <button type="button" className="btn btn-primary muse-wide" disabled={!dirty || saving} onClick={save}>
                  {saving ? 'Saving…' : dirty ? 'Save changes' : 'All saved'}
                </button>
                {note && (
                  <p className="muse-fine" role="status">
                    {note}
                  </p>
                )}
              </div>
              <button type="button" className="muse-link set-erase" onClick={erase}>
                Delete all of it
              </button>
            </>
          )}
        </section>
      </main>
    </div>
  )
}
