import type { CSSProperties, ReactNode } from 'react'

// Story text, typeset for a line-by-line reveal. Each word sits in its own mask
// (<span class="w"><span class="wi">word</span></span>) with real spaces between, so
// the words stay selectable, wrap naturally, and read as ordinary text to assistive tech.
//
// Markup inside a line:
//   _word word_   emphasis; the closing _ may sit mid-token ("them_," keeps the comma out)
//   {{…}}         an inline chip, kept together as one unit
// Only a normal space splits words: a no-break space keeps a dash on the word before it.

export type Kind = 'h' | 'd' | 's' | 'b' | 'lead' | 'num'

/** One line (display:block span) of a paragraph. */
export function Ln({ k, children }: { k: Kind; children: string }) {
  return <span className={`ln ${k}`}>{words(children)}</span>
}

function words(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let inEm = false
  let emIdx = 0
  let key = 0
  for (const m of text.matchAll(/\{\{([^}]*)\}\}|[^ ]+/g)) {
    if (key > 0) out.push(' ')
    if (m[1] !== undefined) {
      out.push(
        <span className="w" key={key++}>
          <span className="wi">
            <span className="ichip">{m[1]}</span>
          </span>
        </span>,
      )
      continue
    }
    let tok = m[0]
    if (tok.startsWith('_')) {
      inEm = true
      emIdx = 0
      tok = tok.slice(1)
    }
    if (!inEm) {
      out.push(
        <span className="w" key={key++}>
          <span className="wi">{tok}</span>
        </span>,
      )
      continue
    }
    const close = tok.indexOf('_')
    const emPart = close >= 0 ? tok.slice(0, close) : tok
    const rest = close >= 0 ? tok.slice(close + 1) : ''
    out.push(
      <span className={close >= 0 ? 'w em em-end' : 'w em'} key={key++} style={{ '--ui': emIdx++ } as CSSProperties}>
        <span className="wi">
          <em className="u">{emPart}</em>
          {rest}
        </span>
      </span>,
    )
    if (close >= 0) inEm = false
  }
  return out
}
